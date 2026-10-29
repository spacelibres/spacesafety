/**
 * Screening worker thread.
 *
 * Runs the numerical kernel off the main thread so a pool of these can use every
 * core. The main thread owns the gRPC stream; this thread owns compute and a
 * private track cache.
 *
 * ## Why the cache is per-thread
 *
 * `screening.ts` keeps a bounded LRU of compiled trajectories. Sharing it across
 * threads would need synchronisation on the hottest path in the program. Giving
 * each thread its own cache costs some duplicate compilation — the same
 * satellite may be compiled once per thread — but that cost is paid once per
 * satellite per thread and amortises over the many pairs it appears in, while a
 * lock would be paid on every lookup.
 *
 * ## Message protocol
 *
 *   in : { type: "load", id, raw }      register a trajectory's raw text
 *   in : { type: "job", job }           screen a pair, by id only
 *   out: { type: "result", result }     ScreeningResultMsg
 *   out: { type: "ready" }
 *
 * A job carries trajectory **ids**, never states. Ship the states and each job
 * moves ~6 MB across the thread boundary (4 321 states x 768 B x 2), which costs
 * far more than the ~2 ms of compute it saves — measured at 4-8x *slower* than
 * inline. Instead the main thread pushes each trajectory's raw text once
 * (`load`), and jobs reference it. Text is small relative to the wire form and
 * is parsed once per thread.
 *
 * Threads do not do network I/O: keeping all fetching on one thread means one
 * cache and one retry policy. Trajectories a job needs but this thread has not
 * been given are reported as a structured failure and the API requeues, exactly
 * as for a worker that lacks the file.
 */

import { parentPort } from "node:worker_threads";

import { normaliseTrajectory } from "../lib/api/validate-trajectory";
import {
  screen,
  screenTracks,
  trackFromPacked,
  type Track,
} from "../lib/core/screening";
import { combineFeeds, type FeedSource } from "../lib/orbit/feed-combination";
import { packCovariances, packStates } from "../lib/core/screening";
import type { ItcState } from "../lib/orbit/itc";
import type { ScreeningJobMsg, ScreeningResultMsg, TrajectorySampleMsg } from "../lib/grpc/proto";

/** Raw ephemeris text keyed by trajectory id, held by each thread. */
export type SourceMap = Record<string, string>;

interface LoadMessage {
  type: "load";
  id: string;
  raw: string;
}

interface JobMessage {
  type: "job";
  job: ScreeningJobMsg;
}

/**
 * A slice of a sweep: screen every pair `(outer[i], inner[j])` for i in the outer
 * list and j in the inner list.
 *
 * Dispatching one message per *pair* made the pool slower than a single core:
 * 1 770 pairs measured 9.8 ms/pair through the pool against 2.5 ms/pair inline,
 * because every pair paid a postMessage, a promise settle on the main thread and
 * an exchange of ids for work that costs ~1 ms. A slice moves that cost to the
 * slice, and the thread loops over its pairs without leaving the isolate.
 *
 * Only pairs that produce approaches are reported, so a slice of hundreds of
 * thousands of misses costs one small message.
 */
interface BatchMessage {
  type: "batch";
  batchId: string;
  outer: string[];
  inner: string[];
  /**
   * Number of leading `inner` entries that belong to the outer block itself.
   *
   * Pairs are enumerated as `(outer[i], inner[k])` for `k > i` inside the prefix,
   * and for every `k` beyond it. That yields each unordered pair exactly once
   * across the whole sweep, without the caller having to build disjoint lists.
   */
  intraEnd?: number;
  /** Index, within the block's outer list, of `outer[0]`. A chunked slice sends a
   *  window of the block's outer entries but the whole block as `inner`, so the
   *  self-pair comparison below has to be against the absolute index. */
  outerStart?: number;
  maxSamplePoints?: number;
  windowMs?: number;
}

/**
 * Parse and pack raw ephemeris text into this thread's own track cache.
 *
 * Parsing is the expensive half of a sweep — 283 ms for a 5 MB OCM against 14 ms
 * to pack it — and it is pure CPU, so it belongs on the workers. The main thread
 * reading 11 000 files and parsing them serially took 41 minutes on its own.
 */
interface PrepareMessage {
  type: "prepare";
  prepareId: string;
  items: Array<{
    trajectoryId: string;
    objectId: string;
    objectName: string;
    /** Raw ephemeris text, as a UTF-8 `Buffer` or a string. Uint8Array because a
     *  structured clone delivers a Buffer as one. */
    raw: string | Uint8Array;
  }>;
}

export interface PreparedTrajectory {
  trajectoryId: string;
  objectId: string;
  objectName: string;
  buffer: SharedArrayBuffer;
  covBuffer: SharedArrayBuffer | null;
}

interface PrepareResultMessage {
  type: "prepareResult";
  prepareId: string;
  results: PreparedTrajectory[];
  failed: Array<{ trajectoryId: string; error: string }>;
}

interface BatchApproach {
  primaryId: string;
  secondaryId: string;
  approaches: ScreeningResultMsg["approaches"];
}

interface BatchResultMessage {
  type: "batchResult";
  batchId: string;
  pairsScreenable: number;
  pairsMissing: number;
  hits: BatchApproach[];
  computeMs: number;
}

/**
 * A trajectory already parsed and packed by the main thread.
 *
 * Transferred as a `SharedArrayBuffer`, so every thread reads the same bytes and
 * nothing is copied. This is the fix for the pool's original problem: parsing a
 * 3-day ITC file costs ~89 ms while screening it costs ~1.5 ms, and letting each
 * thread parse for itself made a 16-thread pool slower than one core.
 */
interface PackedMessage {
  type: "packed";
  trajectoryId: string;
  objectId: string;
  objectName: string;
  hardBodyRadiusKm: number;
  /** `[t, px, py, pz, vx, vy, vz]` per sample, SharedArrayBuffer-backed. */
  buffer: SharedArrayBuffer;
  /** `count x 36` covariances, or null when the trajectory carries none. */
  covBuffer?: SharedArrayBuffer | null;
  /** When set, reply with `packedAck` carrying this id once the track is resident. */
  ack?: string;
}

/** Result of evicting a trajectory, reported back so the pool can re-send it. */
interface EvictedMessage {
  type: "evicted";
  trajectoryId: string;
}

/**
 * Register a second feed for a trajectory id.
 *
 * A Starlink object is published twice (OCM and Modified ITC) and the two files
 * are linked in the database. The pool sends this once per thread so the raw-text
 * path below can combine them; the packed path is unaffected because the main
 * thread already resolved the choice before it packed.
 */
interface CompanionMessage {
  type: "companion";
  id: string;
  companionId: string;
}

/**
 * Companion trajectory id per requested id, filled from the batch endpoint.
 *
 * Only consulted when a job arrives with raw text instead of packed states, which
 * is the case when a trajectory could not be packed on the main thread (parse
 * failure) or when the caller asked for the inline path.
 */
const companions = new Map<string, string>();

/**
 * Parsed states per trajectory id, so many pairs reuse one parse.
 *
 * Keyed by id and invalidated whenever `loadTrajectory` sees new text for that id.
 */
const stateCache = new Map<string, ItcState[]>();

/** Record that `id` has a second feed under `companionId`. */
export function loadCompanion(id: string, companionId: string): void {
  if (companions.get(id) === companionId) return;
  companions.set(id, companionId);
  // A link changes which feeds combine, so any derivation of this id built before
  // the link is stale. Without this, a job that ran before the link arrived keeps
  // serving the covariance-less result from the parse cache.
  parsed.delete(id);
  stateCache.delete(id);
  stateCache.delete(companionId);
}

/** Companion links currently known to this thread. Exported for tests. */
export function knownCompanions(): Record<string, string> {
  return Object.fromEntries(companions);
}

/**
 * Tracks built from shared buffers, keyed by trajectory id.
 *
 * Bounded by bytes with LRU eviction. Without a bound, a full-constellation sweep
 * grows this to `satellites x threads x arc size`: 64 three-day arcs across 16
 * threads measured 1.6 GB RSS, and a real constellation would be far worse. The
 * pool needs to know what it evicted, because it tracks what each thread holds
 * and would otherwise skip re-sending a trajectory the thread no longer has.
 */
const sharedTracks = new Map<string, Track>();

/**
 * Byte budget for this thread's packed tracks.
 *
 * Default 512 MB: enough for ~25 three-day Starlink arcs at 20 MB each, which is
 * more than one dispatch typically touches, while keeping a 16-thread pool inside
 * a few GB. `SPACE_EYES_THREAD_MEMORY_MB=0` disables eviction.
 */
const memoryBudgetBytes = (): number =>
  Number(process.env.SPACE_EYES_THREAD_MEMORY_MB ?? 512) * 1024 * 1024;

let usedBytes = 0;

/** Called by `loadPacked` on every (re)send, so recency reflects real use. */
function touchShared(id: string): void {
  const track = sharedTracks.get(id);
  if (!track) return;
  // Map preserves insertion order: delete + set moves it to the young end.
  sharedTracks.delete(id);
  sharedTracks.set(id, track);
}

function evictUntilUnderBudget(): void {
  const budget = memoryBudgetBytes();
  if (budget <= 0) return;
  const port = parentPort;
  while (usedBytes > budget && sharedTracks.size > 1) {
    // Oldest first; never evict the only entry, which may be mid-job.
    const oldestId = sharedTracks.keys().next().value;
    if (oldestId === undefined) break;
    const track = sharedTracks.get(oldestId);
    if (!track) break;
    sharedTracks.delete(oldestId);
    usedBytes -= track.data.byteLength;
    port?.postMessage({ type: "evicted", trajectoryId: oldestId } satisfies EvictedMessage);
  }
}

/**
 * Per-thread trajectory cache.
 *
 * Bounded by total characters rather than entry count: one Starlink file is
 * ~40 MB, so a count-based cap of "a few hundred" would be tens of gigabytes.
 */
const CACHE_MAX_CHARS = Number(process.env.SPACE_EYES_THREAD_CACHE_CHARS ?? 400_000_000);
const sources: SourceMap = {};
let cachedChars = 0;

export function loadTrajectory(id: string, raw: string): void {
  if (sources[id] === raw) return;
  // New text invalidates any previous parse of this id.
  parsed.delete(id);
  const existing = sources[id];
  if (existing) cachedChars -= existing.length;
  sources[id] = raw;
  cachedChars += raw.length;
  // The combined input depends on this text; drop any previous derivation.
  stateCache.delete(id);

  // Evict oldest until under budget. Insertion order gives FIFO, which is good
  // enough: a sweep touches a satellite's neighbours in bursts, so recency and
  // order are nearly the same thing here.
  while (cachedChars > CACHE_MAX_CHARS) {
    const oldest = Object.keys(sources)[0];
    if (!oldest) break;
    cachedChars -= sources[oldest].length;
    delete sources[oldest];
    parsed.delete(oldest);
    stateCache.delete(oldest);
  }
}

/**
 * Parsed form of each cached trajectory, keyed by id.
 *
 * Without this, every job re-parsed its trajectories: a 2 MB ITC file costs
 * ~13 ms to parse and another ~6 ms to rebuild into wire states, while the actual
 * screening takes ~2 ms. Cached parsing is what makes a sweep worthwhile, and it
 * matters far more here than in the API process because a worker sees the same
 * satellite in hundreds of pairs.
 *
 * Entries are dropped when `loadTrajectory` sees new text for the id, so a
 * revised trajectory can never be served from a stale parse.
 */
const parsed = new Map<string, TrajectorySampleMsg>();

/** Register a main-thread-packed trajectory, ready for zero-copy screening. */
export function loadPacked(msg: Omit<PackedMessage, "type">): void {
  const existing = sharedTracks.get(msg.trajectoryId);
  const incomingCovBytes = msg.covBuffer ? msg.covBuffer.byteLength : 0;
  if (existing) {
    // Same data: keep the track we have and only refresh its recency.
    //
    // Replacing it would be wasteful twice over — a fresh `Float64Array` view and
    // a rebuilt Track per re-send — and the bytes are the same trajectory. This
    // matters because the pool re-sends whenever it thinks a thread lacks the
    // entry, so a re-send is routine, not exceptional.
    //
    // "Same data" includes the covariance buffer: a linked dispatch sends the
    // merged variant (with covariance) and an unlinked one sends the bare file
    // under the same trajectory id. Treating those as identical made a thread that
    // had seen the merged copy keep serving its covariance to an unlinked job.
    const haveCov = existing.covs !== null;
    const wantCov = incomingCovBytes > 0;
    if (existing.data.byteLength === msg.buffer.byteLength && haveCov === wantCov) {
      touchShared(msg.trajectoryId);
      return;
    }
    // Different variant: replace, and refund the bytes the old one held.
    sharedTracks.delete(msg.trajectoryId);
    usedBytes -= existing.data.byteLength + (haveCov ? existing.count * 36 * 8 : 0);
  }

  const data = new Float64Array(msg.buffer);
  const covs = msg.covBuffer ? new Float64Array(msg.covBuffer) : null;
  const track = trackFromPacked(
    {
      trajectoryId: msg.trajectoryId,
      objectId: msg.objectId,
      objectName: msg.objectName,
      hardBodyRadiusKm: msg.hardBodyRadiusKm,
    },
    data,
    covs,
  );
  sharedTracks.set(msg.trajectoryId, track);
  usedBytes += data.byteLength + (covs?.byteLength ?? 0);

  // The same data may still sit in the content cache (`parsed`) under this id:
  // a worker that parsed a trajectory for an earlier job kept every wire state
  // object — ~400 bytes each, 10 000 per file, ~350 files — alive in its heap.
  // Nothing in a sweep reads that form: the sweep looks tracks up in
  // `sharedTracks`, and the packed buffer supersedes it. Evicting it here is
  // what keeps a 24-thread sweep inside RAM.
  if (parsed.delete(msg.trajectoryId)) {
    const raw = sources[msg.trajectoryId];
    if (raw) {
      cachedChars -= raw.length;
      delete sources[msg.trajectoryId];
      stateCache.delete(msg.trajectoryId);
    }
  }

  evictUntilUnderBudget();
}

/** Bytes currently held by this thread's packed tracks. */
export function sharedBytes(): number {
  return usedBytes;
}

/** Ids currently resident, oldest first. Exported for tests. */
export function sharedIds(): string[] {
  return [...sharedTracks.keys()];
}

/**
 * Which stored feeds are available for a trajectory id.
 *
 * A Starlink object resolves to two: the requested trajectory and, when it is in
 * the cache, its companion. `combineFeeds` then picks the better input -- the OCM's
 * long arc plus the ITC's covariance when the OCM has none.
 */
function feedsFor(id: string): FeedSource[] {
  const feeds: FeedSource[] = [];
  const own = sources[id];
  if (own) {
    feeds.push({ trajectoryId: id, format: formatOf(own), states: statesOf(id, own) });
  }
  const companionId = companions.get(id);
  if (companionId) {
    const raw = sources[companionId];
    if (raw) {
      feeds.push({
        trajectoryId: companionId,
        format: formatOf(raw),
        states: statesOf(companionId, raw),
      });
    }
  }
  return feeds;
}

/** Parse once per id and cache; the same satellite appears in many pairs. */
function statesOf(id: string, raw: string): ItcState[] {
  const hit = stateCache.get(id);
  if (hit) return hit;
  const states = normaliseTrajectory(raw).states.map((s) => ({
    ms: s.ms,
    position: [s.position[0], s.position[1], s.position[2]] as [number, number, number],
    velocity: [s.velocity[0], s.velocity[1], s.velocity[2]] as [number, number, number],
    covariance: s.covariance,
  }));
  stateCache.set(id, states);
  return states;
}

function formatOf(raw: string): string {
  if (raw.startsWith("CCSDS_OCM") || raw.includes("CCSDS_OCM_VERS")) return "ocm";
  if (/^created:/m.test(raw)) return "itc";
  if (/META_START/.test(raw)) return "ocm";
  if (/CCSDS_OEM_VERS/.test(raw)) return "oem";
  return "unknown";
}

function materialise(sample: TrajectorySampleMsg): TrajectorySampleMsg | null {
  if (sample.states && sample.states.length > 0) return sample;

  const cached = parsed.get(sample.trajectoryId);
  if (cached) {
    // Report the id/name the caller asked for, not whatever the first caller
    // happened to pass: two jobs may label the same trajectory differently.
    return cached;
  }

  if (!sources[sample.trajectoryId]) return null;

  const combined = combineFeeds(feedsFor(sample.trajectoryId));
  if (!combined) return null;

  const built: TrajectorySampleMsg = {
    trajectoryId: sample.trajectoryId,
    objectId: sample.objectId || sample.trajectoryId,
    objectName: sample.objectName || sample.trajectoryId,
    hardBodyRadiusKm: sample.hardBodyRadiusKm || 0.005,
    stateSource: sample.stateSource || "operator_ephemeris",
    states: combined.states.map((s) => ({
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
  parsed.set(sample.trajectoryId, built);
  return built;
}

/**
 * Screen a slice of pairs from the tracks this thread already holds.
 *
 * Pairs whose tracks are not resident are counted as missing rather than reported
 * as errors: the caller keeps the counts so a partial sweep is visible instead of
 * looking complete.
 */
/**
 * Parse and pack raw text, returning the bytes rather than keeping them.
 *
 * A sweep needs every thread to hold *every* trajectory, not just the ones it
 * happened to parse: with each thread keeping only its own share, six thousand of
 * seven thousand pairs were skipped as "track not resident". So the parse is
 * parallel here and the buffers go back to the caller, which ships the same
 * `SharedArrayBuffer` to every thread — the bytes then exist once in the process.
 */
export function prepareTracks(msg: PrepareMessage): PrepareResultMessage {
  const failed: Array<{ trajectoryId: string; error: string }> = [];
  const results: PreparedTrajectory[] = [];

  for (const item of msg.items) {
    try {
      const text =
        typeof item.raw === "string"
          ? item.raw
          : new TextDecoder().decode(item.raw);
      const normalised = normaliseTrajectory(text, { enforceFutureWindow: false });
      const data = packStates({
        trajectoryId: item.trajectoryId,
        objectId: item.objectId,
        objectName: item.objectName,
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
      });
      if (!data) {
        failed.push({ trajectoryId: item.trajectoryId, error: "rejected by the packer" });
        continue;
      }
      const buffer = new SharedArrayBuffer(data.byteLength);
      new Float64Array(buffer).set(data);

      let covBuffer: SharedArrayBuffer | null = null;
      const covData = packCovariances({
        trajectoryId: item.trajectoryId,
        objectId: item.objectId,
        objectName: item.objectName,
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
      });
      if (covData) {
        covBuffer = new SharedArrayBuffer(covData.byteLength);
        new Float64Array(covBuffer).set(covData);
      }

      results.push({
        trajectoryId: item.trajectoryId,
        objectId: item.objectId,
        objectName: item.objectName,
        buffer,
        covBuffer,
      });
    } catch (err) {
      failed.push({ trajectoryId: item.trajectoryId, error: (err as Error).message });
    }
  }

  return {
    type: "prepareResult",
    prepareId: msg.prepareId,
    results,
    failed,
  };
}

export function runBatch(msg: BatchMessage): BatchResultMessage {
  const started = Date.now();
  const hits: BatchApproach[] = [];
  let screenable = 0;
  let missing = 0;
  const maxPoints = msg.maxSamplePoints || 4000;

  const intraEnd = msg.intraEnd ?? 0;
  const outerStart = msg.outerStart ?? 0;

  for (let oi = 0; oi < msg.outer.length; oi += 1) {
    const outerId = msg.outer[oi];
    const a = sharedTracks.get(outerId);
    if (!a) {
      missing += msg.inner.length;
      continue;
    }
    touchShared(outerId);

    for (let k = 0; k < msg.inner.length; k += 1) {
      // Inside the intra-block prefix only look *forward* from this outer object, so
      // each intra-block pair is screened once and never in both orders. Beyond the
      // prefix the inner list starts at the block's first index, so every entry
      // there is a genuine cross-block pair.
      if (k < intraEnd && k <= outerStart + oi) continue;
      const innerId = msg.inner[k];
      const b = sharedTracks.get(innerId);
      if (!b) {
        missing += 1;
        continue;
      }
      screenable += 1;
      const output = screenTracks(a, b, maxPoints, msg.windowMs);
      if (output.approaches.length > 0) {
        hits.push({ primaryId: outerId, secondaryId: innerId, approaches: output.approaches });
      }
    }
  }

  return {
    type: "batchResult",
    batchId: msg.batchId,
    pairsScreenable: screenable,
    pairsMissing: missing,
    hits,
    computeMs: Date.now() - started,
  };
}

export function runInline(job: ScreeningJobMsg): ScreeningResultMsg {
  const started = Date.now();

  try {
    // Shared path: both sides already packed by the main thread.
    const packedPrimary = sharedTracks.get(job.primary.trajectoryId) ?? null;
    const packedSecondary = sharedTracks.get(job.secondary.trajectoryId) ?? null;
    if (packedPrimary && packedSecondary) {
      touchShared(job.primary.trajectoryId);
      touchShared(job.secondary.trajectoryId);
      const output = screenTracks(
        packedPrimary,
        packedSecondary,
        job.maxSamplePoints || 4000,
        job.windowMs,
      );
      return {
        jobId: job.jobId,
        status: "JOB_STATUS_COMPLETED",
        approaches: output.approaches,
        error: "",
        computeMs: Date.now() - started,
      };
    }

    const primary = materialise(job.primary);
    const secondary = materialise(job.secondary);

    if (!primary || !secondary) {
      return {
        jobId: job.jobId,
        status: "JOB_STATUS_FAILED",
        approaches: [],
        error:
          `trajectory not available on this worker ` +
          `(primary=${job.primary?.trajectoryId}, secondary=${job.secondary?.trajectoryId})`,
        computeMs: Date.now() - started,
      };
    }

    const output = screen({
      jobId: job.jobId,
      primary,
      secondary,
      maxSamplePoints: job.maxSamplePoints || 4000,
      windowMs: job.windowMs,
    });

    return {
      jobId: job.jobId,
      status: "JOB_STATUS_COMPLETED",
      approaches: output.approaches,
      error: "",
      computeMs: Date.now() - started,
    };
  } catch (err) {
    return {
      jobId: job.jobId,
      status: "JOB_STATUS_FAILED",
      approaches: [],
      error: err instanceof Error ? err.message : String(err),
      computeMs: Date.now() - started,
    };
  }
}

/**
 * Thread entry point.
 *
 * Guarded on `parentPort` so this module can also be imported from the main
 * thread to run a job *inline* (`runInline`) when the pool is configured with no
 * threads. Without the guard the import itself would throw.
 */
if (parentPort) {
  parentPort.on(
    "message",
    (
      msg:
        | LoadMessage
        | PackedMessage
        | JobMessage
        | CompanionMessage
        | BatchMessage
        | PrepareMessage,
    ) => {
    if (msg?.type === "load") {
      loadTrajectory(msg.id, msg.raw);
      return;
    }
    if (msg?.type === "packed") {
      loadPacked(msg);
      // Acknowledge only when asked: the sweep driver needs to know its tracks are
      // resident before dispatching batches, or the first slices are screened
      // against an empty cache and report every pair as "not resident".
      if (msg.ack) {
        parentPort!.postMessage({ type: "packedAck", ackId: msg.ack, trajectoryId: msg.trajectoryId });
      }
      return;
    }
    if (msg?.type === "companion") {
      loadCompanion(msg.id, msg.companionId);
      return;
    }
    if (msg?.type === "batch") {
      parentPort!.postMessage(runBatch(msg));
      return;
    }
    if (msg?.type === "prepare") {
      parentPort!.postMessage(prepareTracks(msg));
      return;
    }
    if (msg?.type !== "job") return;
    const result = runInline(msg.job);
    parentPort!.postMessage({ type: "result", result });
  });

  parentPort.postMessage({ type: "ready" });
}
