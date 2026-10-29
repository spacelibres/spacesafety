/**
 * Sharded full-catalog sweep.
 *
 * ## Why shards
 *
 * Every thread must hold every trajectory it screens. An expanded 7-day OCM is
 * ~2.9 MB after the covariance became a flat buffer, so a thread holding all
 * 11 162 objects needs 32 GB — and 16 such threads need 520 GB. The machine has
 * 152 GB, and an earlier attempt at high parallelism took it down.
 *
 * So the catalog is cut into shards of `--size` objects (default 1000). For each
 * shard the driver parses and screens only that shard's objects against everything
 * from the shard's first index onward, which keeps the union of all shards equal to
 * every unordered pair exactly once, while bounding a single run to
 * `size x threads x 2.9 MB` — about 23 GB at the defaults.
 *
 * Each shard is an independent run: it can be interrupted and resumed, and a crash
 * costs one shard rather than the whole sweep. Progress is recorded in
 * `data/sweep-state.json` so `--resume` skips completed shards.
 *
 *   npm run screen:sharded                     # all shards, resumable
 *   npm run screen:sharded -- --size 800 --threads 8
 *   npm run screen:sharded -- --from 3 --to 5  # a slice of shards, for measuring
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const STATE_FILE = "./data/sweep-state.json";

interface SweepState {
  /** Catalog object ids in sweep order; the shard boundaries are derived from it. */
  order: string[];
  size: number;
  /** Indices of shards that completed, by start index. */
  done: number[];
  pairsScreened: number;
  updatedAt: string;
}

function loadState(): SweepState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as SweepState;
  } catch {
    return null;
  }
}

function saveState(state: SweepState): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function main() {
  const { eq: sqlEq } = await import("drizzle-orm");
  const { availableParallelism } = await import("node:os");
  const { Worker } = await import("node:worker_threads");

  const { getDb } = await import("../src/db");
  const { catalog, objects } = await import("../src/db/schema");
  const { ingestScreeningResult } = await import("../src/lib/api/screening-service");
  const { getTrajectoryFile } = await import("../src/lib/queries");

  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const resume = argv.includes("--resume");
  const num = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i === -1) return fallback;
    const v = Number(argv[i + 1]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const size = num("--size", 1000);
  const threads = num("--threads", Math.min(8, Math.max(1, availableParallelism() - 8)));
  const from = num("--from", 0);
  const to = num("--to", Number.MAX_SAFE_INTEGER);

  // Budget: every thread holds the shard plus its cross-shard tail. Sized from the
  // shard count, never left at the 512 MB default, which evicted tracks mid-run and
  // made the sweep report thousands of pairs as "not resident".
  if (!process.env.SPACE_EYES_THREAD_MEMORY_MB) {
    // A cross-shard tail can reach the whole catalog in the worst case (the first
    // shard screens against everything), so the budget covers that.
    process.env.SPACE_EYES_THREAD_MEMORY_MB = "16384";
  }

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
    .sort((a, b) => String(a.objectName).localeCompare(String(b.objectName)));

  console.log(
    `\nsharded sweep: ${entries.length} objects, shard ${size}, ${threads} threads` +
      (dryRun ? " (dry run)" : "") +
      "\n",
  );

  // Schedule: each shard is [i, i+size) against [i, N). The union over shards is
  // every unordered pair exactly once, and a shard never needs an object it does
  // not already have from index i onward.
  const shards: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < entries.length; i += size) {
    shards.push({ start: i, end: Math.min(i + size, entries.length) });
  }

  const previous = resume ? loadState() : null;
  const done = new Set(previous?.done ?? []);
  const state: SweepState = previous ?? {
    order: entries.map((e) => e.objectId),
    size,
    done: [],
    pairsScreened: 0,
    updatedAt: new Date().toISOString(),
  };

  const todo = shards
    .map((s, index) => ({ ...s, index }))
    .filter((s) => !done.has(s.start))
    .slice(from, to === Number.MAX_SAFE_INTEGER ? undefined : to);

  const totalPairs = (entries.length * (entries.length - 1)) / 2;
  const remainingPairs = todo.reduce(
    (n, s) => n + (s.end - s.start) * entries.length - ((s.start + s.end - 1) * (s.end - s.start)) / 2,
    0,
  );
  console.log(`  ${shards.length} shard(s), ${shards.length - todo.length} already done`);
  console.log(`  ${todo.length} to run, ~${remainingPairs.toLocaleString()} of ${totalPairs.toLocaleString()} pairs\n`);

  let grandPairs = 0;
  let grandHits = 0;
  let grandIngested = 0;

  for (const shard of todo) {
    const shardStart = Date.now();

    // The shard's own objects plus everything after them. Both lists are ids only;
    // the text is parsed inside the workers.
    const shardEntries = entries.slice(shard.start, shard.end);
    const tailEntries = entries.slice(shard.start);

    console.log(
      `\n--- shard ${shard.index + 1}/${shards.length}: objects [${shard.start}, ${shard.end}) ` +
        `x [${shard.start}, ${entries.length}) ---`,
    );

    const threadEntry = new URL("../src/worker/screening-thread.ts", import.meta.url);
    const workers: Array<InstanceType<typeof Worker>> = [];
    for (let t = 0; t < threads; t += 1) {
      workers.push(
        new Worker(threadEntry, {
          execArgv: process.execArgv.filter((a) => a !== "--inspect"),
          name: `shard-${shard.index}-${t}`,
        }),
      );
    }
    await Promise.all(
      workers.map((w) => new Promise<void>((resolve) => w.once("message", () => resolve()))),
    );

    // --- parse inside the workers, one batch at a time so text never accumulates
    const packedIds: string[] = [];
    const failures: Array<{ name: string; error: string }> = [];
    const outstanding = new Map<
      string,
      { batch: typeof tailEntries; worker: InstanceType<typeof Worker> }
    >();
    let nextPrepare = 0;
    const PREPARE_BATCH = 40;

    const pendingAcks: Array<Promise<void>> = [];
    const ackResolvers = new Map<string, () => void>();
    let ackSeq = 0;

    let resolvePhase: (() => void) | null = null;
    let dispatch: (w: InstanceType<typeof Worker>) => void = () => {};

    for (const w of workers) {
      w.on("message", (msg: Record<string, unknown>) => {
        if (msg?.type === "packedAck") {
          const id = String(msg.ackId ?? "");
          const resolve = ackResolvers.get(id);
          if (resolve) {
            ackResolvers.delete(id);
            resolve();
          }
          return;
        }
        if (msg?.type !== "prepareResult") return;

        const job = outstanding.get(String(msg.prepareId ?? ""));
        if (!job) return;
        outstanding.delete(String(msg.prepareId ?? ""));

        const results = (msg.results ?? []) as Array<{
          trajectoryId: string;
          objectId: string;
          objectName: string;
          buffer: SharedArrayBuffer;
          covBuffer: SharedArrayBuffer | null;
        }>;
        for (const f of (msg.failed ?? []) as Array<{ trajectoryId: string; error: string }>) {
          const hit = job.batch.find((x) => x.trajectoryId === f.trajectoryId);
          failures.push({ name: hit?.objectName ?? f.trajectoryId, error: f.error });
        }

        // Ship each packed trajectory to every thread of this shard and wait for
        // every one to acknowledge before screening starts.
        for (const p of results) {
          packedIds.push(p.trajectoryId);
          for (const target of workers) {
            const ackId = `a${ackSeq++}`;
            pendingAcks.push(new Promise<void>((r) => ackResolvers.set(ackId, r)));
            target.postMessage({
              type: "packed",
              trajectoryId: p.trajectoryId,
              objectId: p.objectId,
              objectName: p.objectName,
              hardBodyRadiusKm: 0.00883,
              buffer: p.buffer,
              covBuffer: p.covBuffer,
              ack: ackId,
            });
          }
        }

        dispatch(job.worker);
      });
    }

    await new Promise<void>((resolve) => {
      resolvePhase = resolve;
      dispatch = (w: InstanceType<typeof Worker>) => {
        if (nextPrepare >= tailEntries.length) {
          if (outstanding.size === 0) resolve();
          return;
        }
        const batch = tailEntries.slice(nextPrepare, nextPrepare + PREPARE_BATCH);
        nextPrepare += batch.length;

        const items = batch
          .map((entry) => ({
            trajectoryId: entry.trajectoryId,
            objectId: entry.objectId,
            objectName: entry.objectName ?? entry.objectId,
            raw: getTrajectoryFile(entry.trajectoryId)?.text ?? "",
          }))
          .filter((x) => x.raw !== "");

        if (items.length === 0) {
          dispatch(w);
          return;
        }

        const id = `p${nextPrepare}`;
        outstanding.set(id, { batch, worker: w });
        w.postMessage({ type: "prepare", prepareId: id, items });
      };

      for (const w of workers) dispatch(w);
    });
    void resolvePhase;

    await Promise.all(pendingAcks);
    const parsed = packedIds.length;

    // Keyed by trajectory id: that is what the batch result names.
    const entryOf = new Map(tailEntries.map((e) => [e.trajectoryId, e]));
    const nameOf = new Map(tailEntries.map((e) => [e.trajectoryId, e.objectName ?? e.objectId]));

    // --- screen ---------------------------------------------------------------
    const shardOuter = shardEntries.map((e) => e.trajectoryId);
    const shardInner = tailEntries.map((e) => e.trajectoryId);

    let shardPairs = 0;
    let shardHits = 0;
    let shardIngested = 0;
    const shardStarted = Date.now();

    await new Promise<void>((resolve) => {
      let nextId = 0;
      let active = 0;
      let dispatched = false;

      const send = (w: InstanceType<typeof Worker>) => {
        w.postMessage({
          type: "batch",
          batchId: `s${shard.index}-${nextId++}`,
          outer: shardOuter,
          inner: shardInner,
          intraEnd: shardOuter.length,
          maxSamplePoints: 4000,
        });
        active += 1;
        dispatched = true;
      };

      for (const w of workers) {
        w.on("message", (msg: Record<string, unknown>) => {
          if (msg?.type !== "batchResult") return;
          active -= 1;
          shardPairs += Number(msg.pairsScreenable ?? 0);

          const hits = (msg.hits ?? []) as Array<{
            primaryId: string;
            secondaryId: string;
            approaches: Array<{
              missDistanceKm: number;
              relativeSpeedKmS: number;
              probabilityOfCollision?: number;
            }>;
          }>;
          for (const hit of hits) {
            shardHits += 1;
            for (const ap of hit.approaches) {
              const pc = ap.probabilityOfCollision;
              console.log(
                `  ${nameOf.get(hit.primaryId) ?? hit.primaryId} x ` +
                  `${nameOf.get(hit.secondaryId) ?? hit.secondaryId}: ` +
                  `miss=${ap.missDistanceKm.toFixed(3)} km ` +
                  `rel=${ap.relativeSpeedKmS.toFixed(3)} km/s ` +
                  `Pc=${pc === undefined || pc === null ? "NULL" : pc.toExponential(3)}`,
              );
            }
            if (!dryRun) {
              const a = entryOf.get(hit.primaryId);
              const b = entryOf.get(hit.secondaryId);
              if (a && b) {
                ingestScreeningResult({
                  jobId: `shard-${shard.index}-${hit.primaryId.slice(0, 8)}-${hit.secondaryId.slice(0, 8)}`,
                  approaches: hit.approaches as never,
                  primaryTrajectoryId: a.trajectoryId,
                  secondaryTrajectoryId: b.trajectoryId,
                });
                shardIngested += 1;
              }
            }
          }

          if (active === 0) resolve();
        });
      }

      // One slice per thread is enough: the shard is a single outer list, so the
      // work is already divided by the thread count only if the block is split.
      // Instead split the outer list across the workers here.
      const perWorker = Math.ceil(shardOuter.length / workers.length);
      workers.forEach((w, i) => {
        const outer = shardOuter.slice(i * perWorker, (i + 1) * perWorker);
        w.postMessage({
          type: "batch",
          batchId: `s${shard.index}-${nextId++}`,
          outer,
          inner: shardInner,
          intraEnd: shardOuter.length,
          maxSamplePoints: 4000,
        });
        active += 1;
        dispatched = true;
      });
      void send;
      void dispatched;
    });

    await Promise.all(workers.map((w) => w.terminate()));

    const shardMs = Date.now() - shardStarted;
    console.log(
      `    ${parsed} parsed, ${shardPairs.toLocaleString()} pairs in ` +
        `${(shardMs / 60000).toFixed(1)} min ` +
        `(${(shardMs / Math.max(shardPairs, 1)).toFixed(2)} ms/pair), ` +
        `${shardHits} hit(s)` +
        (dryRun ? "" : `, ${shardIngested} ingested`),
    );
    if (failures.length > 0) {
      console.log(`    ${failures.length} file(s) rejected (first: ${failures[0].name}: ${failures[0].error})`);
    }

    grandPairs += shardPairs;
    grandHits += shardHits;
    grandIngested += shardIngested;

    if (!dryRun) {
      state.done.push(shard.start);
      state.pairsScreened += shardPairs;
      state.updatedAt = new Date().toISOString();
      saveState(state);
    }

    console.log(`    shard ${shard.index + 1} done in ${((Date.now() - shardStart) / 60000).toFixed(1)} min`);
  }

  console.log(
    `\n${todo.length} shard(s): ${grandPairs.toLocaleString()} pairs, ` +
      `${grandHits} pair(s) with approaches` +
      (dryRun ? " (dry run)" : `, ${grandIngested} ingested`),
  );
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
