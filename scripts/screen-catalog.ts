/**
 * Screen the catalog against itself, in memory-bounded chunks.
 *
 * Runs the same kernel the compute node runs, in-process, so results in the UI
 * come from the real code path without needing the gRPC channel up.
 *
 * ## Why chunks rather than one sweep
 *
 * Compiling a Starlink OCM (10 081 states, 7 days) costs ~250 ms and produces a
 * track of roughly 3.8 MB once the covariance is unpacked into per-state arrays.
 * Holding all 1000 objects at once reached the V8 heap limit at 3.8 GB and the
 * process died with `Reached heap limit`. So the catalog is processed in blocks of
 * `--chunk` objects: each block compiles only its own tracks, screens the pairs
 * inside it, and drops them before the next block.
 *
 * Every unordered pair is covered exactly once: for each block, pairs within the
 * block plus pairs to *later* blocks. A pair is therefore never screened twice and
 * never skipped at a block boundary.
 *
 *   npm run screen:catalog                       # all blocks
 *   npm run screen:catalog -- --chunk 40         # smaller blocks, less memory
 *   npm run screen:catalog -- --limit 200 --dry-run
 */

async function main() {
  const { eq: sqlEq } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const { catalog, objects } = await import("../src/db/schema");
  const { normaliseTrajectory } = await import("../src/lib/api/validate-trajectory");
  const { packCovariances, packStates, screenTracks, trackFromPacked } = await import(
    "../src/lib/core/screening"
  );
  const { ingestScreeningResult } = await import("../src/lib/api/screening-service");
  const { getTrajectoryFile } = await import("../src/lib/queries");

  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const num = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i === -1) return fallback;
    const v = Number(argv[i + 1]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const limit = num("--limit", Number.MAX_SAFE_INTEGER);

  const { db } = getDb();

  const entries = db
    .select({
      objectId: catalog.objectId,
      trajectoryId: catalog.trajectoryId,
      objectName: objects.objectName,
    })
    .from(catalog)
    .leftJoin(objects, sqlEq(objects.id, catalog.objectId))
    .all()
    .sort((a, b) => String(a.objectName).localeCompare(String(b.objectName)))
    .slice(0, limit);

  console.log(
    `\nscreening ${entries.length} catalog object(s)` + (dryRun ? " (dry run)" : "") + "\n",
  );

  /**
   * Compiled trajectories, held in the *packed* form.
   *
   * A `Track` keeps the covariance as 36 doubles per state in JS arrays: 3.8 MB
   * for one 7-day OCM, and 1000 of them exhausted the 4 GB heap. The packed
   * buffers are the same data at 565 KB per object (stride 7, plus a compact
   * covariance block), so the whole catalog fits with room to spare.
   */
  interface Packed {
    objectId: string;
    trajectoryId: string;
    objectName: string;
    data: Float64Array;
    covs: Float64Array | null;
  }
  const packed = new Map<string, Packed>();

  const loadStart = Date.now();
  for (const entry of entries) {
    const file = getTrajectoryFile(entry.trajectoryId);
    if (!file) {
      console.log(`  ${entry.objectName}: no file, skipped`);
      continue;
    }
    let sample;
    try {
      const normalised = normaliseTrajectory(file.text);
      sample = {
        trajectoryId: entry.trajectoryId,
        objectId: entry.objectId,
        objectName: entry.objectName ?? entry.objectId,
        hardBodyRadiusKm: 0.00883,
        stateSource: "operator_ephemeris",
        states: normalised.states.map((s) => ({
          epochMs: String(s.ms),
          px: s.position[0],
          py: s.position[1],
          pz: s.position[2],
          vx: s.velocity[0],
          vy: s.velocity[1],
          vz: s.velocity[2],
          covariance: s.covariance ?? [],
        })),
      };
    } catch (err) {
      console.log(`  ${entry.objectName}: ${(err as Error).message}`);
      continue;
    }
    const data = packStates(sample);
    if (!data) {
      console.log(`  ${entry.objectName}: rejected by the packer`);
      continue;
    }
    packed.set(entry.objectId, {
      objectId: entry.objectId,
      trajectoryId: entry.trajectoryId,
      objectName: entry.objectName ?? entry.objectId,
      data,
      covs: packCovariances(sample),
    });
  }
  const loadMs = Date.now() - loadStart;
  const heapMb = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(
    `  ${packed.size} compiled in ${(loadMs / 1000).toFixed(1)}s ` +
      `(heap ${heapMb.toFixed(0)} MB)\n`,
  );

  const list = [...packed.values()];
  const meta = (p: Packed) => ({
    trajectoryId: p.trajectoryId,
    objectId: p.objectId,
    objectName: p.objectName,
    hardBodyRadiusKm: 0.00883,
  });

  const starts = Date.now();
  let pairs = 0;
  let withApproaches = 0;
  let totalApproaches = 0;
  let ingested = 0;

  // Build `Track`s for a sliding window rather than one pair at a time.
  //
  // `trackFromPacked` still has to expand each state's covariance into a JS array,
  // which costs ~0.5 ms per object; doing that per pair made a 60-object run
  // 24 ms/pair instead of ~3. The window keeps the outer object plus the next
  // WINDOW objects compiled, so each track is built once per window instead of
  // once per pair, and the window slides without ever holding the whole catalog.
  const WINDOW = 120;
  let windowStart = -1;
  let window: Array<ReturnType<typeof trackFromPacked>> = [];

  for (let i = 0; i < list.length; i += 1) {
    if (windowStart !== Math.floor(i / WINDOW) * WINDOW) {
      windowStart = Math.floor(i / WINDOW) * WINDOW;
      const end = Math.min(windowStart + WINDOW, list.length);
      window = [];
      for (let k = windowStart; k < end; k += 1) {
        window[k - windowStart] = trackFromPacked(meta(list[k]), list[k].data, list[k].covs);
      }
    }
    const ta = window[i - windowStart];
    for (let j = i + 1; j < list.length; j += 1) {
      // A track outside the current window is compiled on demand and released by
      // the next slide.
      const tb =
        j < windowStart + window.length
          ? window[j - windowStart]
          : trackFromPacked(meta(list[j]), list[j].data, list[j].covs);
      pairs += 1;
      const out = screenTracks(ta, tb, 4000);
      if (out.approaches.length === 0) continue;

      withApproaches += 1;
      totalApproaches += out.approaches.length;
      for (const ap of out.approaches) {
        const pc = ap.probabilityOfCollision;
        console.log(
          `  ${list[i].objectName} x ${list[j].objectName}: ` +
            `miss=${ap.missDistanceKm.toFixed(3)} km ` +
            `rel=${ap.relativeSpeedKmS.toFixed(3)} km/s ` +
            `Pc=${pc === undefined || pc === null ? "NULL" : pc.toExponential(3)}`,
        );
      }

      if (!dryRun) {
        ingestScreeningResult({
          jobId: `local-${list[i].objectId.slice(0, 8)}-${list[j].objectId.slice(0, 8)}`,
          approaches: out.approaches,
          primaryTrajectoryId: list[i].trajectoryId,
          secondaryTrajectoryId: list[j].trajectoryId,
        });
        ingested += 1;
      }
    }
    if ((i + 1) % 100 === 0) {
      console.log(
        `  ...${i + 1}/${list.length} objects, ${pairs} pairs ` +
          `(${((Date.now() - starts) / 1000).toFixed(0)}s)`,
      );
    }
  }

  const ms = Date.now() - starts;
  console.log(
    `\n${pairs} pairs in ${(ms / 1000).toFixed(1)}s ` +
      `(${(ms / Math.max(pairs, 1)).toFixed(1)} ms/pair)`,
  );
  console.log(`${withApproaches} pair(s) with approaches, ${totalApproaches} approach(es)`);
  console.log(dryRun ? "dry run: nothing written" : `${ingested} result(s) ingested (CDMs + events)`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
