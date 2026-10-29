/**
 * Multi-core screening pool.
 *
 * The compute node used to run every job on one thread. JavaScript's event loop
 * gives concurrency but not parallelism, so a single worker process could never
 * use more than one core no matter what `concurrency` said — the number only
 * controlled how many jobs were *queued* in the stream.
 *
 * This module runs N `worker_threads`, each with its own V8 isolate and its own
 * track cache, and hands jobs to whichever is free. That is where the cores
 * actually get used.
 *
 * ## Contract
 *
 * `run(job, sources)` resolves with the same `ScreeningResultMsg` the inline
 * path produced, including failures. A thread that dies is replaced and its
 * in-flight job is failed rather than silently dropped — the API requeues
 * `JOB_STATUS_FAILED`, so a lost job would otherwise stall a real conjunction
 * report.
 *
 * `sources` (raw ephemeris text by id) is pushed to every thread **once**, not
 * per job. Sending states per job moved ~6 MB per pair and made the pool 4-8x
 * slower than inline; sending the text once and the id afterwards is what makes
 * parallelism pay.
 *
 * ## Sizing
 *
 * Default is `availableParallelism() - 1`, leaving a core for the event loop and
 * gRPC. Override with `SPACE_EYES_WORKER_THREADS`. Setting it to 1 keeps the
 * inline path (no threads at all), which is what the tests and the demo use.
 */

import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

import { packCovariances, packStates } from "../lib/core/screening";
import { normaliseTrajectory } from "../lib/api/validate-trajectory";
import { combineFeeds } from "../lib/orbit/feed-combination";
import { formatDoyTimestamp, type ItcState } from "../lib/orbit/itc";
import type { ScreeningJobMsg, ScreeningResultMsg, TrajectorySampleMsg } from "../lib/grpc/proto";
import type { SourceMap } from "./screening-thread";

/** Which CCSDS family a raw ephemeris text belongs to, for feed combination. */
function formatOf(raw: string): string {
  if (raw.startsWith("CCSDS_OCM") || raw.includes("CCSDS_OCM_VERS")) return "ocm";
  if (/^created:/m.test(raw)) return "itc";
  if (/META_START/.test(raw)) return "ocm";
  if (/CCSDS_OEM_VERS/.test(raw)) return "oem";
  return "unknown";
}

/** Normalised state as the kernel's `ItcState`, which `combineFeeds` consumes. */
function toItcStates(
  states: ReadonlyArray<{
    ms: number;
    position: readonly number[];
    velocity: readonly number[];
    covariance: number[] | null;
  }>,
): ItcState[] {
  return states.map((s) => ({
    ms: s.ms,
    position: [s.position[0], s.position[1], s.position[2]] as [number, number, number],
    velocity: [s.velocity[0], s.velocity[1], s.velocity[2]] as [number, number, number],
    covariance: s.covariance,
  }));
}

/**
 * Serialise merged states back to Modified ITC text.
 *
 * The packed path works on text, so a merged trajectory has to be expressible as
 * one. The covariance is written as the 21-value lower triangle, seven per line,
 * which is the format the parser reads back.
 */
function toItcText(states: ItcState[], name: string): string {
  const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  const first = states[0]?.ms ?? Date.now();
  const last = states[states.length - 1]?.ms ?? first;
  const stepS = states.length > 1 ? Math.round((last - first) / (states.length - 1) / 1000) : 60;
  const out: string[] = [
    `created:${iso(Date.now())} UTC`,
    `ephemeris_start:${iso(first)} UTC ephemeris_stop:${iso(last)} UTC step_size:${stepS}`,
    `ephemeris_source:${name}`,
    "UVW",
  ];
  for (const s of states) {
    out.push(
      `${formatDoyTimestamp(s.ms)} ${s.position[0].toFixed(6)} ${s.position[1].toFixed(6)} ` +
        `${s.position[2].toFixed(6)} ${s.velocity[0].toFixed(9)} ${s.velocity[1].toFixed(9)} ` +
        `${s.velocity[2].toFixed(9)}`,
    );
    if (s.covariance && s.covariance.length === 36) {
      const lower: number[] = [];
      for (let r = 0; r < 6; r += 1) {
        for (let c = 0; c <= r; c += 1) lower.push(s.covariance[r * 6 + c]);
      }
      for (let row = 0; row < 3; row += 1) {
        out.push(
          lower
            .slice(row * 7, row * 7 + 7)
            .map((v) => v.toExponential(9))
            .join(" "),
        );
      }
    }
  }
  return `${out.join("\n")}\n`;
}

export interface PoolOptions {
  /** Number of threads. 0 or 1 runs inline on the calling thread. */
  threads?: number;
  onLog?: (message: string) => void;
  /** Timeout for one job, ms. A thread over this is killed and replaced. */
  jobTimeoutMs?: number;
}

export interface ScreeningPool {
  /** Threads actually in use (0 means inline). */
  readonly threads: number;
  run(job: ScreeningJobMsg, sources: SourceMap, companions?: SourceMap): Promise<ScreeningResultMsg>;
  /** Number of jobs currently executing on threads. */
  readonly busy: number;
  /** Packed bytes currently resident across all threads. */
  readonly residentBytes: number;
  shutdown(): Promise<void>;
}

interface Slot {
  worker: Worker | null;
  /** True once the thread has signalled ready; nothing is posted before that. */
  ready: boolean;
  /** Job currently assigned to this slot, if any. */
  jobId: string | null;
  resolve: ((r: ScreeningResultMsg) => void) | null;
  /** Watchdog for the running job; cleared when it completes. */
  timer: NodeJS.Timeout | null;
  /** Restart metadata so a dead thread can be recreated. */
  generation: number;
  /** Consecutive failed starts, used to back off a respawn loop. */
  failures: number;
}

/** Resolve the thread count from an explicit option, else the environment. */
export function resolveThreadCount(threads?: number): number {
  if (typeof threads === "number") return Math.max(0, Math.floor(threads));
  const fromEnv = Number(process.env.SPACE_EYES_WORKER_THREADS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return Math.floor(fromEnv);
  // Leave one core for the event loop and the gRPC client.
  return Math.max(0, availableParallelism() - 1);
}

/** Path of the compiled/linked thread entry point. */
const THREAD_ENTRY = new URL("./screening-thread.ts", import.meta.url);

/**
 * Create a pool.
 *
 * With `threads <= 1` the returned pool runs jobs inline through the same code
 * path the thread uses, so behaviour is identical and tests need no threads.
 */
export function createPool(opts: PoolOptions = {}): ScreeningPool {
  const log = opts.onLog ?? (() => {});
  const count = resolveThreadCount(opts.threads);
  const jobTimeoutMs = opts.jobTimeoutMs ?? 120_000;

  if (count <= 1) {
    // Inline path: same function the threads run, so behaviour cannot diverge.
    let mod: typeof import("./screening-thread") | null = null;
    const load = async () => {
      mod ??= await import("./screening-thread");
      return mod;
    };
    return {
      threads: 0,
      busy: 0,
      residentBytes: 0,
      run: async (job, sources, companions) => {
        const { loadTrajectory, loadCompanion, runInline } = await load();
        // Companions first: combining reads the link when it parses the primary.
        for (const [id, companionId] of Object.entries(companions ?? {})) {
          loadCompanion(id, companionId);
        }
        for (const [id, raw] of Object.entries(sources)) loadTrajectory(id, raw);
        return runInline(job);
      },
      shutdown: async () => {},
    };
  }

  const slots: Slot[] = [];
  let nextId = 0;
  let shuttingDown = false;
  /** True while `pump` is on the stack, so a nested call returns immediately. */
  let pumping = false;
  /**
   * Trajectory text pushed to the threads, keyed by id, per thread.
   *
   * This **must** be per-slot. A single shared map looks right and is wrong: once
   * thread A has loaded a trajectory, a shared map says every thread has it, so
   * B and C never receive the text and re-report the job as "trajectory not
   * available". The symptom is a pool that works only on its first thread.
   *
   * A value change means the trajectory was revised and is re-sent everywhere.
   */
  const loadedBySlot = new WeakMap<Slot, Map<string, string>>();

  /**
   * Companion links already pushed to each slot.
   *
   * Per-slot for the same reason as `loadedBySlot`: a shared map would claim every
   * thread knows a link after the first one received it. Values are the companion
   * id, so a changed link is re-sent.
   */
  const companionsBySlot = new WeakMap<Slot, Map<string, string>>();

  /** Bytes resident per slot, mirrored from what we sent, for diagnostics. */
  const residentBytes = new WeakMap<Slot, number>();

  /** Packed byte size per trajectory id, so an eviction can be accounted. */
  const sizes = new Map<string, number>();

  /**
   * Trajectories named by the job currently being dispatched.
   *
   * The per-slot scan used to walk `item.sources` — the caller's whole map. In a
   * sweeps that is hundreds of entries on every one of thousands of dispatches
   * (millions of string comparisons), and it cost an order of magnitude more
   * than the compute it was protecting. Only the two ids this job mentions can
   * need sending, so only those are looked up.
   */
  /**
   * Parsed-and-packed trajectories, built once on the main thread.
   *
   * Parsing a 3-day ITC file costs ~90 ms; screening it costs ~1.5 ms. If each
   * thread parses for itself, a 16-thread pool spends 16x the parse cost and runs
   * *slower* than one core — measured at 8x slower before this cache existed.
   * The main thread parses once, packs into a `Float64Array`, and ships the bytes
   * as a `SharedArrayBuffer`, which is copied nowhere.
   */
  const packed = new Map<
    string,
    { buffer: SharedArrayBuffer; covBuffer: SharedArrayBuffer | null; meta: PackedMeta }
  >();

  interface PackedMeta {
    trajectoryId: string;
    objectId: string;
    objectName: string;
    hardBodyRadiusKm: number;
    /** Cache key this entry lives under; differs from the id for merged feeds. */
    key: string;
  }

  /** Label fields a job carries, used to fill in what a raw file cannot say. */
  type Label = {
    trajectoryId: string;
    objectId: string;
    objectName: string;
    hardBodyRadiusKm: number;
    stateSource?: string;
  };

  /**
   * Combine the object's feeds before packing.
   *
   * The packed path is the one every real dispatch takes, so the merge has to
   * happen here, not only in the thread's raw-text path. Packing the requested
   * file alone shipped an OCM's states *without* the ITC's covariance, and the CDM
   * came out with a NULL Pc while the same pair computed fine inline — the two
   * paths disagreed.
   *
   * Returns the requested file's text when there is no companion, which is the
   * common case (a non-Starlink object, or a self-contained OCM).
   */
  const mergedRaw = (
    id: string,
    raw: string,
    sources: SourceMap,
    companions: Record<string, { trajectoryId: string }> | undefined,
  ): string => {
    const companionId = companions?.[id]?.trajectoryId;
    const companionRaw = companionId ? sources[companionId] : undefined;
    // Nothing to merge: keep the original text byte-for-byte so the packed cache
    // key (which is the id) stays comparable across calls.
    if (!companionId || !companionRaw) return raw;

    try {
      const own = normaliseTrajectory(raw);
      const combined = combineFeeds([
        { trajectoryId: id, format: formatOf(raw), states: toItcStates(own.states) },
        {
          trajectoryId: companionId,
          format: formatOf(companionRaw),
          states: toItcStates(normaliseTrajectory(companionRaw).states),
        },
      ]);
      // A single feed means the merge found nothing to borrow; `raw` is equivalent.
      if (!combined || combined.kind === "single" || combined.covarianceTrajectoryId === null) {
        return raw;
      }
      return toItcText(combined.states, own.objectName ?? id);
    } catch (err) {
      // Never fail a dispatch because the merge could not be built: the caller's
      // own file is still a valid input, and the thread reports parse problems.
      log(`[pool] feed merge failed for ${id}: ${(err as Error).message}`);
      return raw;
    }
  };

  const packedFor = (id: string, raw: string, fallback: Label, merged?: string): PackedMeta | null => {
    // The cache key carries whether the packed form was merged. A trajectory may be
    // dispatched linked (OCM + ITC covariance) and unlinked in the same run, and
    // keying on the id alone would serve whichever variant was packed first — the
    // unlinked job would silently inherit a borrowed covariance, or the linked one
    // would silently lose it.
    const mergedText = merged && merged !== raw ? merged : undefined;
    const key = mergedText ? `${id}\u0000merged` : id;
    const hit = packed.get(key);
    if (hit) {
      // Move to the young end: recency must reflect use, not first sight.
      packed.delete(key);
      packed.set(key, hit);
      return hit.meta;
    }

    let sample: TrajectorySampleMsg;
    try {
      const normalised = normaliseTrajectory(mergedText ?? raw);
      sample = {
        trajectoryId: id,
        objectId: fallback.objectId || id,
        objectName: normalised.objectName ?? fallback.objectName ?? id,
        hardBodyRadiusKm: fallback.hardBodyRadiusKm || 0.005,
        stateSource: fallback.stateSource || "operator_ephemeris",
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
      // Let the thread produce the structured failure, so error text matches the
      // inline path exactly rather than being invented here.
      log(`[pool] cannot pack ${id}: ${(err as Error).message} | merged=${mergedText ? "yes" : "no"}`);
      return null;
    }

    const data = packStates(sample);
    if (!data) return null;

    const buffer = new SharedArrayBuffer(data.byteLength);
    new Float64Array(buffer).set(data);

    // Covariance travels alongside, in its own shared buffer. It cannot join the
    // state buffer: the kernel's hot loop indexes `[t, px, py, pz, vx, vy, vz]`
    // with a fixed stride, and widening it would slow every screening for a field
    // only the probability step reads.
    let covBuffer: SharedArrayBuffer | null = null;
    const covData = packCovariances(sample);
    if (covData) {
      covBuffer = new SharedArrayBuffer(covData.byteLength);
      new Float64Array(covBuffer).set(covData);
    }

    const meta: PackedMeta = {
      trajectoryId: id,
      objectId: sample.objectId,
      objectName: sample.objectName,
      hardBodyRadiusKm: sample.hardBodyRadiusKm,
      key,
    };
    packed.set(key, { buffer, covBuffer, meta });
    const bytes = buffer.byteLength + (covBuffer?.byteLength ?? 0);
    packCacheBytes += bytes;
    sizes.set(id, bytes);

    // Bound the *main thread's* pack cache too: it is the same data again, so an
    // unbounded map here doubles the total footprint.
    evictFromPackCache();
    return meta;
  };

  /**
   * Drop least-recently-packed trajectories from the main thread cache.
   *
   * The pool's own copy is cheaper than the threads' (one per process, not one
   * per thread) but it is the same bytes. Unbounded, a constellation sweep grows
   * it to `satellites x arc size` — 11 163 x 20 MB is 220 GB.
   */
  // Read lazily on each call: a module-level constant would freeze the first
  // value seen, and a test (or an operator) that changes it would have no effect.
  const packCacheMaxBytes = (): number =>
    Number(process.env.SPACE_EYES_PACK_CACHE_MB ?? 1024) * 1024 * 1024;
  let packCacheBytes = 0;

  function evictFromPackCache(): void {
    const max = packCacheMaxBytes();
    if (max <= 0) return;
    while (packCacheBytes > max && packed.size > 0) {
      const oldest = packed.keys().next().value;
      if (oldest === undefined) break;
      const entry = packed.get(oldest);
      if (!entry) break;
      packed.delete(oldest);
      packCacheBytes -= entry.buffer.byteLength + (entry.covBuffer?.byteLength ?? 0);
    }
  };

  /** Send a packed trajectory to one slot if it has not had it yet. */
  const sendPackedIfNeeded = (slot: Slot, meta: PackedMeta): boolean => {
    const entry = packed.get(meta.key);
    if (!entry) return true;
    let known = loadedBySlot.get(slot);
    if (!known) {
      known = new Map();
      loadedBySlot.set(slot, known);
    }
    // The thread keys tracks by trajectory id, so a merged and an unmerged variant
    // are different versions of the *same* track. The marker must therefore
    // change when the variant does, or a thread that holds the unmerged copy
    // would keep serving it to a linked job.
    const markerKey = meta.trajectoryId;
    // The buffer identity is the version: a re-parsed trajectory gets a fresh
    // SharedArrayBuffer, so a string comparison is not enough.
    const marker =
      String(entry.buffer.byteLength) +
      ":" +
      String(entry.covBuffer?.byteLength ?? 0) +
      ":" +
      meta.objectName;
    if (known.get(markerKey) === marker) return true;
    try {
      slot.worker!.postMessage({
        type: "packed",
        trajectoryId: meta.trajectoryId,
        objectId: meta.objectId,
        objectName: meta.objectName,
        hardBodyRadiusKm: meta.hardBodyRadiusKm,
        buffer: entry.buffer,
        covBuffer: entry.covBuffer,
      });
    } catch (err) {
      failSlot(slot, `failed to send trajectory: ${(err as Error).message}`);
      return false;
    }
    known.set(markerKey, marker);
    residentBytes.set(slot, (residentBytes.get(slot) ?? 0) + (sizes.get(meta.trajectoryId) ?? 0));
    return true;
  };

  const spawn = (slot: Slot): void => {
    const generation = ++slot.generation;
    const worker = new Worker(THREAD_ENTRY, {
      // tsx registers a loader for the parent; worker threads do not inherit it,
      // so pass it explicitly for the .ts entry point.
      execArgv: process.execArgv.filter((a) => a !== "--inspect"),
      name: `space-eyes-compute-${slots.indexOf(slot)}`,
    });
    slot.worker = worker;

    worker.on(
      "message",
      (msg: { type: string; result?: ScreeningResultMsg; trajectoryId?: string }) => {
      if (msg?.type === "ready") {
        // A fresh thread knows nothing: replay everything sent to its
        // predecessor. The map survives a restart, so re-spawns warm up instantly.
        slot.ready = true;
        // A live thread clears the failure streak: the next crash respawns at once.
        slot.failures = 0;
        const known = loadedBySlot.get(slot);
        if (known) {
          for (const [id, raw] of known) {
            try {
              worker.postMessage({ type: "load", id, raw });
            } catch {
              // If the thread died again, the exit handler will re-spawn.
              break;
            }
          }
        }
        pump();
        return;
      }
      if (msg?.type === "evicted") {
        // The thread dropped this trajectory to stay inside its memory budget.
        // Forget it here too, or the next job naming it would be sent without
        // the trajectory and fail as "not available" — a silent correctness bug
        // that only appears once a sweep exceeds the budget.
        const evictedId = msg.trajectoryId;
        if (!evictedId) return;
        const known = loadedBySlot.get(slot);
        if (known) known.delete(evictedId);
        residentBytes.set(
          slot,
          Math.max(0, (residentBytes.get(slot) ?? 0) - (sizes.get(evictedId) ?? 0)),
        );
        return;
      }
      if (msg?.type !== "result" || !msg.result) return;
      // Ignore results from a superseded generation.
      if (slot.generation !== generation) return;
      if (slot.timer) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      const resolve = slot.resolve;
      slot.jobId = null;
      slot.resolve = null;
      resolve?.(msg.result);
      pump();
    });

    worker.on("error", (err: Error) => {
      log(`[pool] thread error: ${err.message}`);
      failSlot(slot, `compute thread failed: ${err.message}`);
    });

    worker.on("exit", (code) => {
      if (shuttingDown) return;
      log(`[pool] thread exited with code ${code}`);
      failSlot(slot, `compute thread exited with code ${code}`);
    });
  };

  const failSlot = (slot: Slot, reason: string): void => {
    const jobId = slot.jobId;
    const resolve = slot.resolve;
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    slot.jobId = null;
    slot.resolve = null;
    slot.ready = false;

    try {
      slot.worker?.terminate();
    } catch {
      // already gone
    }
    slot.worker = null;

    // Back off before respawning. A thread that cannot even import its module
    // exits in ~2 ms, and an immediate respawn turns that into a hot loop that
    // pegs a core and floods the log while never making progress. The counter
    // resets on a successful `ready`, so a one-off crash still respawns at once.
    slot.failures += 1;
    const backoffMs = slot.failures > 1 ? Math.min(5_000, 100 * 2 ** (slot.failures - 1)) : 0;

    if (jobId && resolve) {
      resolve({
        jobId,
        status: "JOB_STATUS_FAILED",
        approaches: [],
        error: reason,
        computeMs: 0,
      });
    }
    if (!shuttingDown) {
      if (backoffMs === 0) {
        spawn(slot);
      } else {
        const timer = setTimeout(() => {
          if (!shuttingDown && slot.worker === null) spawn(slot);
        }, backoffMs);
        timer.unref?.();
      }
    }
    pump();
  };

  for (let i = 0; i < count; i += 1) {
    const slot: Slot = {
      worker: null,
      ready: false,
      jobId: null,
      resolve: null,
      timer: null,
      generation: 0,
      failures: 0,
    };
    slots.push(slot);
    spawn(slot);
  }

  // Queue of jobs waiting for a free slot.
  const pending: Array<{
    job: ScreeningJobMsg;
    sources: SourceMap;
    /** Companion link per requested trajectory id, when the object has two feeds. */
    companions?: Record<string, { trajectoryId: string }>;
    resolve: (r: ScreeningResultMsg) => void;
  }> = [];

  const pump = (): void => {
    // Re-entrancy guard. `pump` is called from message handlers (`ready`,
    // `evicted`) and from `run`/`failSlot`, so one `pump` can synchronously reach
    // another. Without this, the inner call dispatches the head of `pending` and
    // shifts it, and the outer loop then continues with the *stale* `item` it
    // already captured — dispatching the same job twice, the second time against
    // a slot whose bookkeeping has moved on, which kills the thread and starts the
    // respawn loop. Guarding is cheaper than making the queue re-entrant.
    if (pumping) return;
    pumping = true;
    try {
      while (pending.length > 0) {
        const slot = slots.find((s) => s.ready && s.jobId === null && s.worker !== null);
        if (!slot || !slot.worker) return;

        // Re-read the head on every iteration: an inner call may have shifted it.
        const item = pending[0];
        if (!item) return;

      // Pack and push the two trajectories this job names.
      //
      // The item is *peeked*, not shifted: sending can fail, and shifting first
      // would drop the job with its promise never settled — that lost 10 of 152
      // approaches in the benchmark before it was found.
      const registered = companionsBySlot.get(slot) ?? new Map<string, string>();
      // The map is created lazily: a slot that never sees a linked object would
      // otherwise have no entry, and the `registered?.get(...)` guard below reads
      // as "no links known" — which is also the condition for sending one. The
      // first send then had nowhere to record itself and threw, killing the thread
      // on every dispatch. Register it on first use instead.
      companionsBySlot.set(slot, registered);
      const packPackage = (): boolean => {
        for (const side of [item.job.primary, item.job.secondary] as const) {
          const id = side.trajectoryId;

          // Link the object's second feed before anything could parse it. The
          // packed path resolves the choice on the main thread, but a trajectory
          // that failed to pack falls through to the thread's raw-text path, which
          // needs to know which companion to combine with.
          const link = item.companions?.[id];
          if (link && registered.get(id) !== link.trajectoryId) {
            try {
              slot.worker!.postMessage({ type: "companion", id, companionId: link.trajectoryId });
              registered.set(id, link.trajectoryId);
            } catch (err) {
              failSlot(slot, `failed to send companion link: ${(err as Error).message}`);
              return false;
            }
          }

          const raw = item.sources[id];
          if (raw === undefined) continue;
          const meta = packedFor(id, raw, side, mergedRaw(id, raw, item.sources, item.companions));
          // A null meta means the source is unparseable; let the thread report it.
          if (meta && !sendPackedIfNeeded(slot, meta)) return false;
        }
        return true;
      };

      if (!packPackage()) return;
      pending.shift();

      slot.jobId = item.job.jobId;
      slot.resolve = item.resolve;

      const generation = slot.generation;
      const timer = setTimeout(() => {
        if (slot.generation !== generation || slot.jobId !== item.job.jobId) return;
        log(`[pool] job ${item.job.jobId.slice(0, 8)} exceeded ${jobTimeoutMs} ms; recycling thread`);
        failSlot(slot, `compute timed out after ${jobTimeoutMs} ms`);
      }, jobTimeoutMs);
      timer.unref?.();
      slot.timer = timer;

        try {
          slot.worker.postMessage({ type: "job", job: item.job });
        } catch (err) {
          failSlot(slot, `failed to dispatch: ${(err as Error).message}`);
          return;
        }
      }
    } finally {
      pumping = false;
    }
  };

  log(`[pool] ${count} compute thread(s) started`);

  return {
    threads: count,
    get busy() {
      return slots.filter((s) => s.jobId !== null).length;
    },
    get residentBytes() {
      return slots.reduce((n, s) => n + (residentBytes.get(s) ?? 0), 0);
    },
    run(job, sources, companions) {
      if (shuttingDown) {
        return Promise.resolve<ScreeningResultMsg>({
          jobId: job.jobId,
          status: "JOB_STATUS_FAILED",
          approaches: [],
          error: "compute pool is shutting down",
          computeMs: 0,
        });
      }
      void nextId;
      return new Promise<ScreeningResultMsg>((resolve) => {
        const links: Record<string, { trajectoryId: string }> | undefined = companions
          ? Object.fromEntries(
              Object.entries(companions).map(([id, companionId]) => [
                id,
                { trajectoryId: companionId },
              ]),
            )
          : undefined;
        pending.push({ job, sources, companions: links, resolve });
        pump();
      });
    },
    async shutdown() {
      shuttingDown = true;
      for (const item of pending.splice(0)) {
        item.resolve({
          jobId: item.job.jobId,
          status: "JOB_STATUS_FAILED",
          approaches: [],
          error: "compute pool is shutting down",
          computeMs: 0,
        });
      }
      await Promise.all(
        slots.map(async (slot) => {
          try {
            await slot.worker?.terminate();
          } catch {
            // ignore
          }
          slot.worker = null;
        }),
      );
    },
  };
}
