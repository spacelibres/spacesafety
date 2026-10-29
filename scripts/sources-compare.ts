/**
 * Cross-check the sources against each other and report where they disagree.
 *
 * This is the payoff of storing every provider's element set separately: for any
 * object two sources both know, propagate both to one instant and measure the
 * separation. The report is the evidence base for deciding which source drives a
 * screen.
 *
 *   npm run sources:compare                # sample 2 000 shared objects
 *   npm run sources:compare -- --all       # every shared object
 *   npm run sources:compare -- --norad 44714,25544 --verbose
 */

async function main(): Promise<void> {
  const { loadEnvLocal } = await import("./env");
  loadEnvLocal();

  const { getDb } = await import("../src/db");
  const { parseTleFile } = await import("../src/lib/orbit/tle");
  const { compareSources, summarize, ocmSampler } = await import("../src/lib/sources/compare");
  const type = await import("../src/lib/sources/compare");

  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const all = argv.includes("--all");
  const verbose = argv.includes("--verbose");
  const sample = Number(flag("--sample") ?? 2000);
  const noradArg = flag("--norad");

  const { sqlite } = getDb();

  // Objects held by more than one source are the only ones that can be checked.
  const shared = sqlite
    .prepare(
      `SELECT norad_id AS noradId, COUNT(*) AS n
         FROM object_sources GROUP BY norad_id HAVING n > 1
         ORDER BY norad_id`,
    )
    .all() as Array<{ noradId: number; n: number }>;

  const targets = noradArg
    ? noradArg.split(",").map((s) => Number(s.trim()))
    : (all ? shared : shared.filter((_, i) => i % Math.max(1, Math.ceil(shared.length / sample)) === 0))
        .map((r) => r.noradId);

  if (targets.length === 0) {
    console.error("\n  no object is held by two sources yet; run `npm run sources:refresh` first\n");
    process.exit(1);
  }

  console.log(
    `\nSpace Safety — source cross-check\n` +
      `  ${shared.length} object(s) held by 2+ sources; checking ${targets.length}\n`,
  );

  const stateStmt = sqlite.prepare(
    `SELECT norad_id AS noradId, source_id AS sourceId, epoch, inclination, raan,
            eccentricity, arg_perigee AS argPerigee, mean_anomaly AS meanAnomaly,
            mean_motion AS meanMotion, bstar
       FROM object_sources WHERE norad_id = ?`,
  );
  const fileStmt = sqlite.prepare(
    `SELECT t.state_source AS sourceId, f.file_text AS text, t.point_count AS pointCount
       FROM trajectories t JOIN trajectory_files f ON f.trajectory_id = t.id
      WHERE t.object_id = (SELECT id FROM objects WHERE norad_id = ? LIMIT 1)
        AND t.state_source IN ('space-track','spacebook-xp-tle','spacebook-omm',
                               'operator_ephemeris')`,
  );
  // Object class and size come from SATCAT, which is the only source that has
  // them for every catalogue number. Without them a debris object and a
  // station-kept satellite look identically alarming.
  const metaStmt = sqlite.prepare(
    "SELECT object_type AS objectType, period FROM satcat WHERE norad_id = ? LIMIT 1",
  );

  const comparisons = [];
  const started = Date.now();

  for (const noradId of targets) {
    const states = stateStmt.all(noradId) as Array<{
      noradId: number;
      sourceId: string;
      epoch: string | null;
      inclination: number | null;
      raan: number | null;
      eccentricity: number | null;
      argPerigee: number | null;
      meanAnomaly: number | null;
      meanMotion: number | null;
      bstar: number | null;
    }>;
    if (states.length < 2) continue;

    const meta = metaStmt.get(noradId) as
      | { objectType: string | null; period: number | null }
      | undefined;

    const tles = new Map<string, ReturnType<typeof parseTleFile>["tles"][number]>();
    const ocm = new Map<string, ReturnType<typeof ocmSampler> & object>();
    for (const row of fileStmt.all(noradId) as Array<{ sourceId: string; text: string }>) {
      if (row.sourceId === "operator_ephemeris") {
        const sampler = ocmSampler("starlink-ocm", row.text);
        if (!sampler) continue;
        ocm.set("starlink-ocm", sampler as ReturnType<typeof ocmSampler> & object);
        continue;
      }
      const { tles: parsed } = parseTleFile(row.text);
      if (parsed[0]) tles.set(row.sourceId, parsed[0]);
    }

    // The operator ephemeris participates as a position source, not as an element
    // set. Its `epoch` is deliberately null: an OCM's arc start is not a fitted
    // element-set epoch, and attaching one made the drift calculation divide a
    // real separation by a one-hour gap and report rates above orbital velocity.
    const withOcm = [...states];
    if (ocm.size > 0 && !withOcm.some((s) => s.sourceId === "starlink-ocm")) {
      withOcm.push({
        noradId,
        sourceId: "starlink-ocm",
        epoch: null,
        inclination: null,
        raan: null,
        eccentricity: null,
        argPerigee: null,
        meanAnomaly: null,
        meanMotion: null,
        bstar: null,
      });
    }

    comparisons.push(
      compareSources(
        noradId,
        withOcm,
        tles,
        {
          objectType: meta?.objectType ?? null,
          semiMajorAxisKm: meta?.period ? semiMajorAxisFromPeriod(meta.period) : null,
          ocm,
        },
      ),
    );
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const summary = summarize(comparisons, verbose ? 50 : 15);

  console.log(`  compared ${summary.compared} object(s) in ${elapsed}s\n`);
  console.log(`  agree          ${summary.agree}`);
  console.log(`  stale          ${summary.stale}`);
  console.log(`  suspect        ${summary.suspect}`);
  console.log(`  single-source  ${summary.singleSource}`);
  console.log(`  unpropagatable ${summary.unpropagatable}`);
  console.log(
    `\n  separation at joint epoch: median ${fmt(summary.medianKm)} km, ` +
      `p95 ${fmt(summary.p95Km)} km\n`,
  );

  if (summary.worst.length > 0) {
    console.log("  worst separations:");
    console.log("    norad   worst km  phase min  verdict   reason");
    for (const c of summary.worst) {
      console.log(
        `    ${String(c.noradId).padEnd(7)} ${fmt(c.worstDeltaKm).padStart(8)}  ` +
          `${fmt(c.worstPhaseMinutes).padStart(9)}  ${c.verdict.padEnd(9)} ${c.reason}`,
      );
    }
    console.log();
  }

  if (verbose) {
    console.log("  per-source field differences (reference = newest epoch):");
    for (const c of comparisons.slice(0, 20)) {
      console.log(`    NORAD ${c.noradId} (ref ${c.referenceSource})`);
      for (const e of c.entries) {
        console.log(
          `      ${e.sourceId.padEnd(18)} Δepoch ${fmt(e.epochOffsetHours).padStart(7)} h  ` +
            `Δinc ${fmtExp(e.deltaInclinationDeg)}°  Δmm ${fmtExp(e.deltaMeanMotionRevPerDay)}  ` +
            `Δr ${fmt(e.deltaKm)} km`,
        );
      }
    }
    console.log();
  }

  // A non-zero exit when the supplies disagree badly makes this usable in CI.
  if (summary.suspect > 0) {
    console.log(`  WARNING: ${summary.suspect} object(s) disagree by more than the stale band\n`);
  }
  void type;
}

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(2));
const fmtExp = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : v.toExponential(2);

/** Semi-major axis, km, from a Keplerian period in minutes. */
function semiMajorAxisFromPeriod(periodMin: number): number | null {
  if (!Number.isFinite(periodMin) || periodMin <= 0) return null;
  const mu = 398_600.4418; // km^3/s^2
  const seconds = periodMin * 60;
  return Math.cbrt((mu * seconds * seconds) / (4 * Math.PI * Math.PI));
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
