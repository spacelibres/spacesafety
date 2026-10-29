/**
 * Screen the whole catalog in parallel across cores.
 *
 * ## Why this drives its own threads instead of the pool
 *
 * The pool (`src/worker/pool.ts`) dispatches one *pair* per message. Measured on
 * this machine, a pair costs 2.5 ms inline but 9.8 ms through the pool: every pair
 * pays a `postMessage`, a promise settle on the main thread, and an id exchange,
 * which for ~1 ms of arithmetic is four times the work itself. Adding cores made
 * the sweep slower than one core.
 *
 * So this worker model dispatches a **slice**: the thread screens every pair in a
 * cartesian block of ids it already holds and reports back only the pairs that
 * produced approaches. A block of 400×400 (160 000 pairs) is one message, and a
 * hundred thousand misses cost nothing on the wire.
 *
 * ## Memory
 *
 * Each thread receives every trajectory's packed bytes as a `SharedArrayBuffer`,
 * so the bytes exist once in the process regardless of thread count. The packed
 * form is 565 KB per 7-day OCM (stride 7 plus a compact covariance block), against
 * ~3.8 MB for an expanded `Track`; 11 000 objects is ~6 GB shared, which is why the
 * threads are used with a modest slice size rather than holding everything twice.
 *
 *   npm run screen:parallel
 *   npm run screen:parallel -- --threads 48 --block 300 --dry-run
 */

async function main() {
  // `--max-old-space-size` must be decided before this module (and tsx, which
  // preloads on the main thread) allocates anything, because a flag set from
  // `process.env.NODE_OPTIONS` after startup is never applied — V8 reads it once
  // when the isolate is created. Re-exec with the flag on the real argv instead;
  // otherwise the driver dies at 4 GB while parsing, well before it needs to.
  if (!process.execArgv.some((a) => a.startsWith("--max-old-space-size"))) {
    const { spawnSync } = process.getBuiltinModule("node:child_process");
    const heapMb = process.env.SPACE_SAFETY_HEAP_MB ?? "65536";
    const child = spawnSync(
      process.execPath,
      [`--max-old-space-size=${heapMb}`, ...process.execArgv, ...process.argv.slice(1)],
      { stdio: "inherit", env: process.env },
    );
    process.exit(child.status ?? 1);
  }

  const { eq: sqlEq } = await import("drizzle-orm");
  const { availableParallelism } = await import("node:os");
  const { Worker } = await import("node:worker_threads");
  const { createHash } = await import("node:crypto");

  const { getDb } = await import("../src/db");
  const { catalog, objects, trajectoryFiles } = await import("../src/db/schema");
  const { ingestScreeningResult } = await import("../src/lib/api/screening-service");

  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const num = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i === -1) return fallback;
    const v = Number(argv[i + 1]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const threads = num("--threads", Math.max(1, availableParallelism() - 8));
  const block = num("--block", 300);
  const limit = num("--limit", Number.MAX_SAFE_INTEGER);
  const windowMs = num("--window", 0);

  const { db, sqlite } = getDb();
  // Read one ephemeris straight out of SQLite as a Buffer.
  //
  // The driver used to pull text through the ORM (`getTrajectoryFile`), which
  // materialises a JS string; at 24 threads x 40 files of 5 MB that churn pushed
  // the main thread past its heap limit even with a large heap. A Buffer is an
  // off-heap allocation, and the worker's parser decodes it itself.
  const readFileStmt = sqlite.prepare(
    "SELECT file_text AS text FROM trajectory_files WHERE trajectory_id = ?",
  );
  const readFile = (id: string): Buffer | null => {
    const row = readFileStmt.get(id) as { text: Buffer | string } | undefined;
    if (!row) return null;
    return Buffer.isBuffer(row.text) ? row.text : Buffer.from(row.text, "utf8");
  };

  // Per-thread budget.
  //
  // A packed track is 3.31 MB (state stride 7 at 8 bytes, plus a flat 36-double
  // covariance), and the buffers are `SharedArrayBuffer`s, so the *process* holds
  // one copy regardless of thread count. The budget only needs to cover that shared
  // total plus slack — sizing it per thread by thread count (an earlier version set
  // 16 GB) claimed far more than the machine has and died at the heap limit.
  if (!process.env.SPACE_SAFETY_THREAD_MEMORY_MB) {
    const objects = limit === Number.MAX_SAFE_INTEGER ? 11_200 : limit;
    const sharedMb = objects * 3.31;
    // Each thread's cache also tracks its own residency bookkeeping, and the
    // covariance is copied out per lookup, so allow a fixed working allowance.
    process.env.SPACE_SAFETY_THREAD_MEMORY_MB = String(Math.ceil(sharedMb + 2048));
  }

  // The driver itself holds every raw file for the current block plus the packed
  // ids, so it needs headroom above Node's default 4 GB heap.
  if (!process.execArgv.some((a) => a.startsWith("--max-old-space-size"))) {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=24576`.trim();
  }

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
    `\nscreening ${entries.length} objects, ${threads} threads, block ${block}` +
      (dryRun ? " (dry run)" : "") +
      "\n",
  );

  // --- spawn the workers first, then let them parse -----------------------------
  //
  // Parsing is the expensive half: 283 ms for a 5 MB OCM to normalise, against
  // 14 ms to pack the result. Reading 11 000 files and parsing them on the main
  // thread took 41 minutes and used one core. Each worker parses its own share, so
  // the phase scales with the machine and the packed tracks land directly where
  // the screening will need them.
  const threadEntry = new URL("../src/worker/screening-thread.ts", import.meta.url);
  const workers: InstanceType<typeof Worker>[] = [];
  // Heap flags cannot be forwarded to a Worker; a worker's isolate size is fixed
  // by the process that created it. Copying the driver's `execArgv` forwarded
  // `--max-old-space-size` and was rejected outright.
  const workerExecArgv = process.execArgv.filter(
    (a) => !a.startsWith("--max-old-space-size") && a !== "--inspect",
  );
  for (let t = 0; t < threads; t += 1) {
    workers.push(
      new Worker(threadEntry, {
        execArgv: workerExecArgv,
        name: `sweep-${t}`,
      }),
    );
  }
  await Promise.all(
    workers.map((w) => new Promise<void>((resolve) => w.once("message", () => resolve()))),
  );
  console.log(`  ${threads} thread(s) ready`);

  interface Packed {
    objectId: string;
    trajectoryId: string;
    objectName: string;
    /** Dedupe key: the same object can appear once per catalog row, and a
     *  duplicated entry would screen every one of its pairs twice. */
    key: string;
  }
  const packed: Packed[] = [];
  const loadStart = Date.now();

  // The text is read lazily, a batch at a time.
  //
  // Reading every file up front held 1000 x 5 MB = 5 GB of raw text on the main
  // thread and died at the heap limit (`exit 134`). Only one batch of text needs
  // to exist at once: it is parsed by a worker and then dropped, and the packed
  // result travels as a `SharedArrayBuffer`.
  const work: Array<{
    objectId: string;
    trajectoryId: string;
    objectName: string;
    raw: Buffer;
  }> = [];
  console.log(`  ${entries.length} object(s) queued for parallel parse`);

  const PREPARE_BATCH = 40;
  const prepareStart = Date.now();
  const failures: Array<{ objectName: string; error: string }> = [];
  /** Trajectory ids are what the packed list is filtered on; names are only label. */
  const failedIds = new Set<string>();
  let prepared = 0;
  let nextPrepare = 0;

  // Permanent listeners, keyed by prepareId.
  //
  // Attaching and detaching a handler per batch raced with the `packed` messages
  // the same thread receives, and the handler was sometimes removed before its own
  // result arrived — a single-threaded run then reported every pair as "not
  // resident". One permanent listener plus a map of outstanding batches has no such
  // timing dependency.
  //
  // The map holds only a hash of the batch's trajectory ids, not the batch itself:
  // keeping the slice alive (and its entry objects) retained far more than the
  // buffers did and was what drove the driver to its heap limit.
  const outstanding = new Map<string, { key: string; worker: InstanceType<typeof Worker> }>();
  let resolvePrepare: (() => void) | null = null;
  let dispatch: (w: InstanceType<typeof Worker>) => void = () => {};

  const onPrepare = (msg: Record<string, unknown>) => {
    if (msg?.type !== "prepareResult") return;
    const id = String(msg.prepareId ?? "");
    const job = outstanding.get(id);
    if (!job) return;
    outstanding.delete(id);

    const results = (msg.results ?? []) as Array<{
      trajectoryId: string;
      objectId: string;
      objectName: string;
      buffer: SharedArrayBuffer;
      covBuffer: SharedArrayBuffer | null;
    }>;
    prepared += results.length;

    for (const f of (msg.failed ?? []) as Array<{ trajectoryId: string; error: string }>) {
      failures.push({ objectName: f.trajectoryId, error: f.error });
      failedIds.add(f.trajectoryId);
    }

    // Ship every freshly packed trajectory to every thread. The buffers are
    // shared, so this copies nothing; without it each thread would only know the
    // trajectories it parsed itself.
    for (const p of results) {
      const forwarded = {
        type: "packed" as const,
        trajectoryId: p.trajectoryId,
        objectId: p.objectId,
        objectName: p.objectName,
        hardBodyRadiusKm: 0.00883,
        buffer: p.buffer,
        covBuffer: p.covBuffer,
        ack: true,
      };
      for (const target of workers) {
        const ackId = `a${ackSeq++}`;
        pendingAcks.push(new Promise<void>((resolve) => ackResolvers.set(ackId, resolve)));
        target.postMessage({ ...forwarded, ack: ackId });
      }
      packed.push({
        objectId: p.objectId,
        trajectoryId: p.trajectoryId,
        objectName: p.objectName,
        key: `${p.objectId}\u0000${p.trajectoryId}`,
      });
    }

    if (prepared % 400 < PREPARE_BATCH) {
      console.log(
        `  prepared ${prepared}/${entries.length} ` +
          `(${((Date.now() - prepareStart) / 1000).toFixed(0)}s, ` +
          `heap ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB)`,
      );
    }

    dispatch(job.worker);
  };

  // Resolve once every thread has acknowledged every packed trajectory. Without
  // this the first slices were screened against an empty cache, because a `batch`
  // message can overtake the `packed` messages that make the tracks resident.
  // One promise per (trajectory, thread). A shared counter raced: `packed` acks
  // arrive interleaved with later `prepare` replies, and the count reached zero
  // before every thread had acknowledged, so slices ran against a partial cache.
  // Keyed by a unique id per (trajectory, thread) send. Keying by trajectory id
  // failed: the first thread's ack consumed the entry and the other threads' acks
  // had nothing to resolve, so the driver proceeded with a partially warm cache.
  const pendingAcks: Array<Promise<void>> = [];
  const ackResolvers = new Map<string, () => void>();
  let ackSeq = 0;
  const onAck = (ackId: string) => {
    const resolve = ackResolvers.get(ackId);
    if (!resolve) return;
    ackResolvers.delete(ackId);
    resolve();
  };

  for (const w of workers) {
    w.on("message", (msg: Record<string, unknown>) => {
      if (msg?.type === "packedAck") {
        onAck(String(msg.ackId ?? ""));
        return;
      }
      if (msg?.type === "prepareResult") onPrepare(msg);
    });
  }

  await new Promise<void>((resolve) => {
    resolvePrepare = resolve;

    dispatch = (w: InstanceType<typeof Worker>) => {
      if (nextPrepare >= entries.length) {
        if (outstanding.size === 0) resolve();
        return;
      }
      const batch = entries.slice(nextPrepare, nextPrepare + PREPARE_BATCH);
      nextPrepare += batch.length;

      // Read just this batch's bytes; they are released once the worker replies.
      // A file that is missing leaves a null hole rather than an empty string so
      // the filter below cannot mistake one for the other.
      const batchIds = batch.map((e) => e.trajectoryId);
      const items: Array<{
        trajectoryId: string;
        objectId: string;
        objectName: string;
        raw: Buffer;
      }> = [];
      for (const entry of batch) {
        const raw = readFile(entry.trajectoryId);
        if (!raw || raw.length === 0) continue;
        items.push({
          trajectoryId: entry.trajectoryId,
          objectId: entry.objectId,
          objectName: entry.objectName ?? entry.objectId,
          raw,
        });
      }

      if (items.length === 0) {
        dispatch(w);
        return;
      }

      const id = String(nextPrepare);
      outstanding.set(id, {
        key: createHash("sha1").update(batchIds.join("\u0000")).digest("hex"),
        worker: w,
      });
      // `postMessage` copies the Buffer into the thread's own heap, so the driver's
      // copy is garbage as soon as this returns.
      w.postMessage({ type: "prepare", prepareId: id, items });
    };

    for (const w of workers) dispatch(w);
  });
  void resolvePrepare;

  // Wait for the cache to be warm on every thread before any batch is dispatched.
  if (pendingAcks.length > 0) {
    await Promise.all(pendingAcks);
  }

  console.log(
    `  ${prepared} trajectory(ies) parsed by ${threads} thread(s) in ` +
      `${((Date.now() - prepareStart) / 60000).toFixed(1)} min`,
  );
  if (failures.length > 0) {
    console.log(`  ${failures.length} file(s) rejected:`);
    for (const f of failures.slice(0, 5)) console.log(`    ${f.objectName}: ${f.error}`);
  }
  // Only keep the ones the workers actually hold, and only one entry per
  // (object, trajectory): catalog rows can repeat an object, and a duplicate would
  // screen the same pairs a second time and race its own CDM onto the event.
  const seen = new Set<string>();
  const usable: Packed[] = [];
  for (const p of packed) {
    if (failedIds.has(p.trajectoryId) || seen.has(p.key)) continue;
    seen.add(p.key);
    usable.push(p);
  }

  const totalPairs = (usable.length * (usable.length - 1)) / 2;
  console.log(`  ${totalPairs.toLocaleString()} pairs to screen\n`);

  // --- build the slice list ----------------------------------------------------
  // A slice is one contiguous outer block against everything from that block's
  // first index onward. Each unordered pair therefore belongs to exactly one
  // slice: the one whose outer block contains its lower index. The thread skips
  // the (a, a) self-pair, which is the only overlap this scheme creates.
  interface Slice {
    outer: string[];
    inner: string[];
    /** Length of the intra-block prefix of `inner`; pairs inside it are handled. */
    intraEnd: number;
  }
  // Each slice covers the pairs whose *lower* index lies in its outer block:
  // intra-block pairs (both indices in the block) plus cross-block pairs where the
  // lower index is in this block and the higher one is in any later block. Slices
  // are therefore disjoint and their union is every unordered pair exactly once.
  //
  // Outer blocks are chunked further by `chunk` and interleaved across threads.
  // One slice per block left most cores idle: for the last blocks the inner list is
  // only a few hundred entries, so a whole slice is a fraction of a second and 24
  // threads received work in irregular batches. Peak block 300 / chunk 20 gives
  // 6,000 small units, which keeps every thread fed to the end and makes the units
  // recognisable in a profile (the slice index appears in the batch id).
  const chunk = Math.min(num("--chunk", 20), block);
  const chunks: Array<{ b: number; oi: number; oiEnd: number }> = [];
  let blockIndex = 0;
  for (let i = 0; i < usable.length; i += block) {
    const end = Math.min(i + block, usable.length);
    for (let oi = 0; oi < end - i; oi += chunk) {
      chunks.push({ b: blockIndex, oi, oiEnd: Math.min(oi + chunk, end - i) });
    }
    blockIndex += 1;
  }
  console.log(
    `  ${blockIndex} block(s) x chunk ${chunk} = ${chunks.length} unit(s) queued\n`,
  );

  // --- run ---------------------------------------------------------------------
  const started = Date.now();
  let pairsDone = 0;
  let pairsMissing = 0;
  let withApproaches = 0;
  let totalApproaches = 0;
  let ingested = 0;
  let lastReport = Date.now();
  let nextSlice = 0;
  // A unit can take minutes, so report on a clock rather than only when a result
  // lands: a sweep that logs nothing for twenty minutes reads as a hang.
  const heartbeat = setInterval(() => {
    const elapsed = (Date.now() - started) / 1000;
    if (elapsed < 30) return;
    const rate = pairsDone / Math.max(elapsed, 1);
    console.log(
      `  ${pairsDone.toLocaleString()}/${totalPairs.toLocaleString()} pairs ` +
        `(${rate.toFixed(0)}/s, eta ${((totalPairs - pairsDone) / Math.max(rate, 1) / 60).toFixed(0)} min, ` +
        `units ${nextSlice}/${chunks.length}, in flight ${active})`,
    );
  }, 60_000);
  heartbeat.unref();
  // Per-block id lists, built once and held as plain arrays: every chunk of a
  // block shares the same `inner`, and rebuilding it per chunk would copy the
  // remaining catalog each time.
  const blockOuter: string[][] = [];
  const blockInner: string[][] = [];
  for (let i = 0; i < usable.length; i += block) {
    const end = Math.min(i + block, usable.length);
    blockOuter.push(usable.slice(i, end).map((p) => p.trajectoryId));
    blockInner.push(usable.slice(i).map((p) => p.trajectoryId));
  }
  let active = 0;
  let nextId = 0;

  const byTrajectory = new Map(usable.map((p) => [p.trajectoryId, p]));

  await new Promise<void>((resolve) => {
    const dispatch = (w: InstanceType<typeof Worker>) => {
      if (nextSlice >= chunks.length) {
        if (active === 0) resolve();
        return;
      }
      const c = chunks[nextSlice];
      nextSlice += 1;
      active += 1;
      const outer = blockOuter[c.b];
      w.postMessage({
        type: "batch",
        batchId: String(nextId++),
        outer: outer.slice(c.oi, c.oiEnd),
        inner: blockInner[c.b],
        // A chunk that starts inside the block still owns its block-upper-triangle
        // pairs, which `runBatch` checks against the absolute index.
        intraEnd: outer.length,
        outerStart: c.oi,
        maxSamplePoints: 4000,
        // 0 leaves the kernel's default (two minutes).
        windowMs: windowMs || undefined,
      });
    };

    for (const w of workers) {
      w.on("message", (msg: Record<string, unknown>) => {
        if (msg?.type !== "batchResult") return;
        active -= 1;
        pairsDone += Number(msg.pairsScreenable ?? 0);
        pairsMissing += Number(msg.pairsMissing ?? 0);

        const hits = (msg.hits ?? []) as Array<{
          primaryId: string;
          secondaryId: string;
          approaches: Array<{ missDistanceKm: number; relativeSpeedKmS: number; probabilityOfCollision?: number }>;
        }>;

        for (const hit of hits) {
          withApproaches += 1;
          totalApproaches += hit.approaches.length;
          const a = byTrajectory.get(hit.primaryId);
          const b = byTrajectory.get(hit.secondaryId);

          for (const ap of hit.approaches) {
            const pc = ap.probabilityOfCollision;
            console.log(
              `  ${a?.objectName ?? hit.primaryId} x ${b?.objectName ?? hit.secondaryId}: ` +
                `miss=${ap.missDistanceKm.toFixed(3)} km ` +
                `rel=${ap.relativeSpeedKmS.toFixed(3)} km/s ` +
                `Pc=${pc === undefined || pc === null ? "NULL" : pc.toExponential(3)}`,
            );
          }

          if (!dryRun && a && b) {
            ingestScreeningResult({
              jobId: `local-${hit.primaryId.slice(0, 8)}-${hit.secondaryId.slice(0, 8)}`,
              approaches: hit.approaches as never,
              primaryTrajectoryId: a.trajectoryId,
              secondaryTrajectoryId: b.trajectoryId,
            });
            ingested += 1;
          }
        }

        if (Date.now() - lastReport > 20_000) {
          const elapsed = (Date.now() - started) / 1000;
          const rate = pairsDone / Math.max(elapsed, 1);
          console.log(
            `  ${pairsDone.toLocaleString()}/${totalPairs.toLocaleString()} pairs ` +
              `(${rate.toFixed(0)}/s, eta ${((totalPairs - pairsDone) / Math.max(rate, 1) / 60).toFixed(0)} min, ` +
              `units ${nextSlice}/${chunks.length})`,
          );
          lastReport = Date.now();
        }

        dispatch(w);
      });
    }

    for (const w of workers) {
      w.on("message", (msg: Record<string, unknown>) => {
        if (msg?.type === "prepareResult") onPrepare(msg);
      });
    }
    for (const w of workers) dispatch(w);
  });

  await Promise.all(workers.map((w) => w.terminate()));
  clearInterval(heartbeat);

  const ms = Date.now() - started;
  console.log(
    `\n${pairsDone.toLocaleString()} pairs in ${(ms / 60000).toFixed(1)} min ` +
      `(${(ms / Math.max(pairsDone, 1)).toFixed(2)} ms/pair effective)`,
  );
  console.log(
    `${withApproaches} pair(s) with approaches, ${totalApproaches} approach(es), ` +
      `${pairsMissing.toLocaleString()} pair(s) skipped (track not resident)`,
  );
  console.log(dryRun ? "dry run: nothing written" : `${ingested} result(s) ingested`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
