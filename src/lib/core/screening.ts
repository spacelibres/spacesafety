/**
 * Conjunction screening pipeline.
 *
 * This is the computational heart of the replica and runs on the local compute
 * node, never on the VPS. It consumes a `ScreeningJob` (two trajectories already
 * converted to an inertial frame) and returns zero or more close approaches.
 *
 * Algorithm, matching the documented vendor behaviour
 * (`docs/starlink-space-safety/tutorial-basics/architecture.md`):
 *
 *   1. **Screening box.** Half-widths in RTN of the *primary*:
 *        R = 2 km, T = 44 km, N = 51 km.
 *      The box is oriented by the primary's velocity (RTN rotates with it).
 *   2. **Coarse search.** Walk the secondary's states; whenever one falls inside
 *      the box in the primary's frame, refine locally.
 *   3. **Refinement.** Golden-section search on relative distance to locate the
 *      TCA to sub-second precision, sampling both trajectories by interpolation.
 *   4. **Local minima.** A close approach is a *local minimum* of relative
 *      distance inside the box, which is why the search looks for sign changes
 *      in the range rate rather than just the first in-box sample.
 *   5. **Probability.** Alfano 2D Pc at TCA with the combined covariance.
 *
 * The check is bidirectional per the docs: primary-in-secondary's-box is also a
 * valid encounter. We implement that by running the box test with the *primary*
 * box and, when it misses, retrying with the roles swapped.
 */

import { alfano2d, type AlfanoResult } from "./alfano";
import {
  dot,
  rtnBasis,
  sub,
  type Mat3,
  type Vec3,
} from "./linalg";
import { RE_EARTH } from "./propagator";
import { SCREENING_BOX_KM, SCREENING_BOX_REACH_KM } from "./screening-box";
import {
  buildEnclosure,
  buildWindows,
  enclosuresIntersect,
  pairNeedsScreening,
  type PositionEnclosure,
  type WindowBox,
} from "./time-windows";
import type { CloseApproachMsg, ScreeningJobMsg, TrajectorySampleMsg } from "@/lib/grpc/proto";

export { SCREENING_BOX_KM } from "./screening-box";

/** Refuse to screen against anything below this radius (surface or decayed). */
const MIN_RADIUS_KM = RE_EARTH + 100;
const MIN_RADIUS_SQ = MIN_RADIUS_KM * MIN_RADIUS_KM;
/** Documented 70 km/s speed cap. */
const MAX_SPEED_SQ = 70 * 70;

interface Sample {
  tMs: number;
  r: Vec3;
  v: Vec3;
  /** 3x3 position block of the covariance (km^2), or null when absent. */
  cov: Mat3 | null;
}

/**
 * Stride of the flat sample buffer: `[tMs, px, py, pz, vx, vy, vz]`.
 *
 * Screening a full constellation means touching the same tracks tens of
 * thousands of times, so the representation matters more than the arithmetic.
 * A single contiguous `Float64Array` per track avoids per-state object headers
 * and pointer chasing, keeps the hot loop in L2, and lets the interpolator work
 * on plain numbers with no allocation at all.
 */
const STRIDE = 7;

interface Track {
  id: string;
  objectId: string;
  objectName: string;
  hardBodyRadiusKm: number;
  /** Flat `[tMs, px, py, pz, vx, vy, vz]` samples, ascending in time. */
  data: Float64Array;
  count: number;
  /**
   * Covariances, flat `count x 36`, or null when the trajectory carries none.
   *
   * This used to be `number[][]`, which cost ~4.5 MB of JS array headers for a
   * 10 081-state track and made a full-catalog sweep need a terabyte. A flat
   * `Float64Array` is 2.9 MB and can be shared between threads as one buffer.
   */
  covs: Float64Array | null;
  /** Epoch of the first sample, so propagation times are relative. */
  t0Ms: number;
  /** Epoch of the last sample; cached to keep span checks off the array. */
  t1Ms: number;
  /**
   * Spatial windows over the track, built lazily on first use.
   *
   * Null until a screening job needs them. Building costs one pass over the
   * track, which is wasted for the many pairs the radial pre-filter already
   * rejects before reaching the kernel.
   */
  windows: WindowBox[] | null;
  /**
   * Coarse sample times, built on first use.
   *
   * A 7-day OCM overlaps every other track over the same 7 days, so the pair's
   * overlap interval — and therefore the coarse step and the sample times — is
   * the same for every pair. Recomputing `start + k * step` per sample was a
   * measurable share of the per-pair cost; the times depend on the track alone,
   * so they are built once.
   */
  coarseTimes?: Float64Array | null;
  /** Position bounds over the whole arc, padded by the box reach. */
  enclosure?: PositionEnclosure | null;
}

export interface ScreeningOutput {
  approaches: CloseApproachMsg[];
  /** Diagnostics surfaced in logs, not in the CDM. */
  stats: {
    samplesCompared: number;
    boxHits: number;
    minRangeKm: number;
    /**
     * True when the spatial-window pre-test rejected the pair before any
     * sampling. Set only on the pruning path, so `samplesCompared` stays 0.
     */
    pruned?: boolean;
  };
}

/**
 * Default spatial-window length, ms.
 *
 * Chosen on measured end-to-end cost, not prune rate. On a 150-satellite
 * three-shell constellation, an unpruned sweep runs 12.6 s; windowed sweeps
 * measure:
 *
 *     0.5 min  80% pruned  3.7 s
 *     1 min    77% pruned  4.0 s
 *     2 min    72% pruned  3.9 s
 *     5 min    58% pruned  5.2 s
 *     7.5 min  46% pruned  6.4 s
 *
 * Below ~2 minutes the curve is flat: the prune rate keeps rising but each
 * window holds only one or two samples, so there is little box to compute and
 * more windows to walk. Two minutes sits on the flat part and keeps the window
 * comfortably wider than a Starlink sample spacing (60 s), which leaves margin
 * for sparser ephemerides.
 *
 * Correctness does not depend on this value: `tests/time-windows.test.ts` sweeps
 * 1–180 minutes and asserts zero lost approaches at every length.
 */
export const DEFAULT_WINDOW_MS = 2 * 60 * 1000;

/**
 * Bounded LRU of compiled tracks.
 *
 * A real screening sweep evaluates each satellite against many others, so the
 * same track is compiled over and over. Caching turns `toTrack` from a per-pair
 * cost into a per-satellite one.
 *
 * The key is a content fingerprint, not the trajectory id: ids are only unique
 * per upload, and callers (tests, and the worker when a trajectory is revised)
 * legitimately reuse an id for different states. Fingerprinting on id alone would
 * serve a stale track for fresh states — a correctness bug, not just a cache
 * miss — so the key covers count, first and last epoch, and bricked coordinates.
 *
 * Bounded because a full constellation is ~11k tracks; unbounded growth would
 * keep every ephemeris resident forever.
 */
const TRACK_CACHE_MAX = Number(process.env.SPACE_SAFETY_TRACK_CACHE ?? 4096);
const trackCache = new Map<string, Track>();

function cacheKey(t: TrajectorySampleMsg): string {
  const s = t.states;
  const n = s.length;
  const first = s[0];
  const last = s[n - 1];
  // Cheap fingerprint: endpoints plus a few interior states. Two uploads that
  // agree on all of these and still differ are not a case that matters here.
  const mid = s[n >> 1];
  return [
    t.trajectoryId,
    n,
    first.epochMs, first.px, first.py, first.pz,
    mid.epochMs, mid.px, mid.py, mid.pz,
    last.epochMs, last.px, last.py, last.pz,
    // Covariance presence changes the result (Pc vs NULL), so it is part of the
    // identity even when the geometry is identical.
    first.covariance?.length ?? 0,
    t.hardBodyRadiusKm,
  ].join("|");
}

function cachedTrack(t: TrajectorySampleMsg): Track | null {
  if (TRACK_CACHE_MAX <= 0) return toTrack(t);
  const key = cacheKey(t);
  const hit = trackCache.get(key);
  if (hit) {
    // Refresh recency: Map preserves insertion order, so re-inserting moves the
    // entry to the most-recently-used end.
    trackCache.delete(key);
    trackCache.set(key, hit);
    return hit;
  }

  const built = toTrack(t);
  if (!built) return null;
  if (trackCache.size >= TRACK_CACHE_MAX) {
    const oldest = trackCache.keys().next().value;
    if (oldest !== undefined) trackCache.delete(oldest);
  }
  trackCache.set(key, built);
  return built;
}

/**
 * Build a track from an already-packed `[t, px, py, pz, vx, vy, vz]` buffer.
 *
 * Lets a worker thread consume a `Float64Array` the main thread parsed once and
 * shared, instead of re-parsing the source text per thread. Parsing a 3-day ITC
 * file costs ~89 ms against ~1.5 ms of compute, so per-thread parsing dominated
 * everything else when a pool had more than a handful of trajectories.
 *
 * The buffer must already be sorted by time and already validated — this skips
 * both the sort and the sanity checks `toTrack` performs.
 */
export function trackFromPacked(
  meta: { trajectoryId: string; objectId: string; objectName: string; hardBodyRadiusKm: number },
  data: Float64Array,
  covs?: Float64Array | null,
): Track {
  const count = data.length / STRIDE;
  return {
    id: meta.trajectoryId,
    objectId: meta.objectId,
    objectName: meta.objectName,
    hardBodyRadiusKm: meta.hardBodyRadiusKm,
    data,
    count,
    // Covariance rides in a parallel buffer with the same stride, so a packed
    // trajectory behaves exactly like one built by `toTrack`. Without this the
    // packed path silently produced trajectories with no covariance at all and
    // every CDM came out with a NULL Pc, while the inline path computed one fine.
    covs: covs && covs.length === count * 36 ? covs : null,
    t0Ms: data[0],
    t1Ms: data[(count - 1) * STRIDE],
    windows: null,
  };
}

/**
 * The 3x3 upper-left position block of state `index`'s covariance.
 *
 * Only the position block is ever read: Pc combines the two position blocks and
 * the rest is never read. Reading it straight out of the flat buffer
 * avoids two 36-element arrays per sampled state.
 *
 * This used to copy the whole 6x6 into a fresh `number[]` on every lookup. Those
 * arrays live on the V8 heap, not in the shared buffer, so each of the 24 worker
 * threads accumulated its own copy of every covariance it touched — at ~220
 * bytes per state across 10 081 states and 3 700 tracks that is gigabytes per
 * thread, which is what drove the machine into swap and got the full sweep
 * killed. Reading nine doubles into a reusable scratch array keeps the cost
 * off-heap and bounded.
 */
function covPosAt(track: Track, index: number, out: Mat3): boolean {
  const covs = track.covs;
  if (!covs || index < 0 || (index + 1) * 36 > covs.length) return false;
  const base = index * 36;
  // Row-major 6x6: the position block is rows 0-2, columns 0-2 => offsets
  // 0..2, 6..8, 12..14.
  out[0] = covs[base]; out[1] = covs[base + 1]; out[2] = covs[base + 2];
  out[3] = covs[base + 6]; out[4] = covs[base + 7]; out[5] = covs[base + 8];
  out[6] = covs[base + 12]; out[7] = covs[base + 13]; out[8] = covs[base + 14];
  return true;
}

/**
 * Pack covariances into the flat `count x 36` layout `trackFromPacked` expects.
 *
 * Returns null when no state carries a full 6x6, which keeps the common
 * covariance-less case from allocating (and shipping) an all-zero buffer that
 * the kernel would then have to treat as "covariance known and zero" — a
 * different and much worse thing than "unknown".
 */
export function packCovariances(t: TrajectorySampleMsg): Float64Array | null {
  const states = t?.states;
  if (!states?.length) return null;
  const hasAny = states.some((s) => s.covariance && s.covariance.length === 36);
  if (!hasAny) return null;

  const flat = new Float64Array(states.length * 36);
  states.forEach((s, i) => {
    const cov = s.covariance;
    if (cov && cov.length === 36) flat.set(cov, i * 36);
    // A state without its own matrix keeps zeros; `stateAt` only combines pairs of
    // states that both carry one, so a zero row is treated as absent.
  });
  return flat;
}

/**
 * Register an externally packed track in the cache under `key`.
 *
 * Sweep workers must not use this for their bulk tracks. They already hold every
 * packed track in their own map, so a cache entry is a second reference that
 * outlives eviction: with the content LRU at 4 096, a worker's "evicted" tracks
 * stayed reachable and each of 24 workers held a 6.4 GB share of the catalog.
 */
export function cacheTrack(key: string, track: Track): void {
  trackCache.set(key, track);
}

/** Drop a cached track by key; used when an owner replaces or evicts one. */
export function uncacheTrack(key: string): void {
  trackCache.delete(key);
}

/** The stride of the packed `[t, r, v]` representation. */
export const PACKED_STRIDE = STRIDE;

/** Drop cached tracks — used by tests and by the worker between jobs. */
export function clearTrackCache(): void {
  trackCache.clear();
}

/** Run the full screening job. Never throws for bad astronomy; returns [] . */
export function screen(job: ScreeningJobMsg): ScreeningOutput {
  return screenTracks(
    cachedTrack(job.primary),
    cachedTrack(job.secondary),
    job.maxSamplePoints,
    job.windowMs,
  );
}

/**
 * Coarse sample instants for a (step, start, end) triple, memoised.
 *
 * The coarse loop advances one fixed step from the overlap start, so every pair
 * in a sweep asks for the same list: Starlink's operator ephemerides all cover
 * the same seven days, so `startMs` and `endMs` are identical in 11 000 of the
 * 11 001 comparisons. Building it per pair allocated an array per pair (62M
 * allocations for a full sweep) and recomputed `start + k * step` for each of
 * ~10 000 samples.
 *
 * The cache is keyed on the triple and holds at most a handful of entries, since
 * step lengths come from a small set. A new triple evicts the oldest.
 */
const coarseCache = new Map<string, Float64Array>();
const COARSE_CACHE_MAX = 8;
function coarseSeries(stepMs: number, startMs: number, endMs: number): Float64Array {
  const key = `${stepMs}|${startMs}|${endMs}`;
  const hit = coarseCache.get(key);
  if (hit) return hit;
  const n = Math.floor((endMs - startMs) / stepMs) + 1;
  const out = new Float64Array(Math.max(n, 0));
  for (let i = 0; i < out.length; i += 1) out[i] = startMs + i * stepMs;
  if (coarseCache.size >= COARSE_CACHE_MAX) {
    const oldest = coarseCache.keys().next().value;
    if (oldest !== undefined) coarseCache.delete(oldest);
  }
  coarseCache.set(key, out);
  return out;
}

/**
 * Screen two already-compiled tracks.
 *
 * Split out from `screen` so a worker thread can pass tracks built from shared
 * buffers: the thread compiles nothing and parses nothing, it just screens.
 */
export function screenTracks(
  primary: Track | null,
  secondary: Track | null,
  maxSamplePoints: number,
  windowMsOverride?: number,
): ScreeningOutput {
  const stats: ScreeningOutput["stats"] = {
    samplesCompared: 0,
    boxHits: 0,
    minRangeKm: Infinity,
  };

  if (!primary || !secondary) return { approaches: [], stats };

  // Only the overlap of both spans can produce a valid encounter.
  const startMs = Math.max(primary.t0Ms, secondary.t0Ms);
  const endMs = Math.min(primary.t1Ms, secondary.t1Ms);
  if (!(endMs > startMs)) return { approaches: [], stats };

  // --- Spatial pruning before any sampling.
  //
  // Two spacecraft can only meet when they are near each other at the same time.
  // Slicing both tracks into short windows and comparing window boxes rejects
  // most same-shell pairs cheaply — the radial pre-filter cannot, because
  // Starlink's shells are closer together than the box reach.
  //
  // Enclosure first: it is O(log n) searches plus a short scan, and on a real
  // constellation it rejects ~77% of pairs on its own. The window walk below is
  // the fallback for the rest.
  //
  // It is sound because the coarse loop only ever evaluates samples that lie in
  // the tracks' own buffers: if no sampled position of one track is within one
  // screening reach of the other over the shared instant range, no sampled pair
  // can be inside the box. (The interpolated position between samples is *not*
  // covered — the loop does not use it, and `buildWindows`'s spacing padding
  // exists for callers that do.)
  const ea = primary.enclosure ??= buildEnclosure(
    primary.data, primary.count, STRIDE,
    startMs, endMs, primary.t0Ms, primary.t1Ms, SCREENING_BOX_REACH_KM,
  );
  const eb = secondary.enclosure ??= buildEnclosure(
    secondary.data, secondary.count, STRIDE,
    startMs, endMs, secondary.t0Ms, secondary.t1Ms, SCREENING_BOX_REACH_KM,
  );
  if (!ea || !eb || !enclosuresIntersect(ea, eb)) {
    stats.pruned = true;
    return { approaches: [], stats };
  }

  // Windows stay as the second filter. They are cut with the box reach alone as
  // padding: the enclosure above has already handled the sample-spacing case, and
  // keeping the spacing padding here (1 106 km at 60 s spacing) would let every
  // same-shell pair through — measured, it pruned exactly 0 of 10 000 pairs.
  const windowMs = windowMsOverride && windowMsOverride > 0 ? windowMsOverride : DEFAULT_WINDOW_MS;
  if (primary.windows === null) {
    primary.windows = buildWindows(
      primary.data, primary.count, STRIDE, windowMs, SCREENING_BOX_REACH_KM,
    );
  }
  if (secondary.windows === null) {
    secondary.windows = buildWindows(
      secondary.data, secondary.count, STRIDE, windowMs, SCREENING_BOX_REACH_KM,
    );
  }
  if (!pairNeedsScreening(primary.windows, secondary.windows)) {
    stats.pruned = true;
    return { approaches: [], stats };
  }

  const approaches: CloseApproachMsg[] = [];

  // --- Coarse pass over the shared window.
  const coarseStepMs = chooseCoarseStep(startMs, endMs, maxSamplePoints);

  // The sampled instants depend on the step and the interval, not on the pair
  // beyond that, so they are built once per distinct (step, start) and reused.
  // A whole sweep shares one step, so this is built once for the catalog.
  const series = coarseSeries(coarseStepMs, startMs, endMs);

  let prevRange: number | null = null;
  let prevRangeRate: number | null = null;
  let prevT: number | null = null;
  let insideCount = 0;
  let firstInsideMs: number | null = null;

  // Monotone cursors: the coarse loop walks time forward, so both tracks can be
  // advanced instead of binary-searched on every sample.
  const ca = { track: primary, index: 0 };
  const cb = { track: secondary, index: 0 };

  // Hot-loop scratch. Allocation per sample would dominate the sweep cost.
  const ra: Vec3 = [0, 0, 0];
  const va: Vec3 = [0, 0, 0];
  const rb: Vec3 = [0, 0, 0];
  const vb: Vec3 = [0, 0, 0];

  for (let i = 0; i < series.length; i += 1) {
    const t = series[i];
    if (!advanceTo(ca, t, ra, va)) continue;
    if (!advanceTo(cb, t, rb, vb)) continue;
    stats.samplesCompared += 1;

    const relX = rb[0] - ra[0];
    const relY = rb[1] - ra[1];
    const relZ = rb[2] - ra[2];
    const range = Math.sqrt(relX * relX + relY * relY + relZ * relZ);
    if (range < stats.minRangeKm) stats.minRangeKm = range;

    const rangeRate =
      (relX * (vb[0] - va[0]) + relY * (vb[1] - va[1]) + relZ * (vb[2] - va[2])) /
      (range || 1);

    // Primary's box first; the secondary's basis is only built if that
    // survives. The primary radial test rejects virtually everything, so the
    // second basis is almost never computed.
    const inside =
      inBoxScalar(relX, relY, relZ, ra[0], ra[1], ra[2], va[0], va[1], va[2]) ||
      inBoxScalar(-relX, -relY, -relZ, rb[0], rb[1], rb[2], vb[0], vb[1], vb[2]);
    if (inside) {
      stats.boxHits += 1;
      insideCount += 1;
      firstInsideMs ??= t;
    }

    // A close approach is a local minimum of relative distance: the range rate
    // flips from closing (negative) to opening (positive).
    if (
      prevRangeRate !== null &&
      prevT !== null &&
      prevRangeRate < 0 &&
      rangeRate >= 0
    ) {
      const tcaMs = refineTca(primary, secondary, prevT, t);
      if (tcaMs !== null) {
        const approach = buildApproach(primary, secondary, tcaMs);
        if (approach) approaches.push(approach);
      }
    }

    prevRange = range;
    prevRangeRate = rangeRate;
    prevT = t;
  }

  // Co-orbiting or physically locked pairs produce a *constant* range, so there
  // is no sign change to detect. If the pair stays inside the screening volume
  // for the whole overlap, that is an encounter too — report the earliest
  // in-box instant, which is where the operator can first act.
  if (approaches.length === 0 && insideCount > 0 && firstInsideMs !== null) {
    // Only treat as a persistent conjunction when it spans most of the window;
    // isolated in-box samples without a sign change are grazing passes whose
    // minimum lies outside the sampled overlap.
    if (insideCount >= stats.samplesCompared * 0.9) {
      const approach = buildApproach(primary, secondary, firstInsideMs);
      if (approach) approaches.push(approach);
    }
  }

  void prevRange;

  // Deduplicate approaches that refine to nearly the same TCA.
  return { approaches: dedupe(approaches), stats };
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Convert a wire trajectory into the track the kernel works on.
 *
 * `keepCovariance` lets the caller skip the 36-float copy per state. Bulk
 * screening does not need covariance at all — the coarse pass never reads it
 * TCA refinement never reads it, and the only consumer is the Pc step in
 * `buildApproach`. Dropping it makes a 3-day, 4321-state trajectory cost ~100
 * bytes per state instead of ~400, which is the difference between a screening
 * sweep that fits in cache and one that thrashes it.
 */
/**
 * Validate and pack a wire trajectory into the flat `[t, r, v]` layout.
 *
 * Returns null for anything physically impossible. Sorts by time, because wire
 * order is not guaranteed.
 *
 * Exported so the main thread can do this *once* and share the result with
 * worker threads as a `SharedArrayBuffer`, instead of every thread repeating it.
 * Parsing plus packing a 3-day ITC file costs ~90 ms; screening the result costs
 * ~1.5 ms. Paying that 90 ms once per trajectory instead of once per thread is
 * what makes a multi-threaded pool faster than one core.
 */
export function packStates(t: TrajectorySampleMsg): Float64Array | null {
  if (!t?.states?.length) return null;
  const n = t.states.length;
  const data = new Float64Array(n * STRIDE);

  for (let i = 0; i < n; i += 1) {
    const s = t.states[i];
    const px = s.px;
    const py = s.py;
    const pz = s.pz;
    const vx = s.vx;
    const vy = s.vy;
    const vz = s.vz;

    // Reject physically impossible states rather than screening garbage.
    const radiusSq = px * px + py * py + pz * pz;
    if (!Number.isFinite(radiusSq) || radiusSq < MIN_RADIUS_SQ) return null;
    const speedSq = vx * vx + vy * vy + vz * vz;
    if (!Number.isFinite(speedSq) || speedSq > MAX_SPEED_SQ) return null; // 70 km/s cap

    const o = i * STRIDE;
    data[o] = Number(s.epochMs);
    data[o + 1] = px;
    data[o + 2] = py;
    data[o + 3] = pz;
    data[o + 4] = vx;
    data[o + 5] = vy;
    data[o + 6] = vz;
  }

  let sorted = true;
  for (let i = 1; i < n; i += 1) {
    if (data[i * STRIDE] < data[(i - 1) * STRIDE]) { sorted = false; break; }
  }
  if (!sorted) {
    const order = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => data[a * STRIDE] - data[b * STRIDE]
    );
    const tmp = new Float64Array(n * STRIDE);
    for (let i = 0; i < n; i += 1) {
      const from = order[i] * STRIDE;
      const to = i * STRIDE;
      for (let k = 0; k < STRIDE; k += 1) tmp[to + k] = data[from + k];
    }
    data.set(tmp);
  }

  return data;
}

function toTrack(t: TrajectorySampleMsg, keepCovariance = true): Track | null {
  const data = packStates(t);
  if (!data) return null;
  const n = t.states.length;

  // Flat `count x 36`. A state without a matrix keeps zeros; `covAt` reports the
  // row, and the Pc step rejects a degenerate matrix, so such a state yields NULL
  // rather than a wrong number.
  let covs: Float64Array | null = null;
  if (keepCovariance && t.states.some((s) => s.covariance && s.covariance.length === 36)) {
    covs = new Float64Array(n * 36);
    t.states.forEach((s, i) => {
      if (s.covariance && s.covariance.length === 36) covs!.set(s.covariance, i * 36);
    });
  }

  return {
    id: t.trajectoryId,
    objectId: t.objectId,
    objectName: t.objectName,
    hardBodyRadiusKm: t.hardBodyRadiusKm,
    data,
    count: n,
    covs,
    t0Ms: data[0],
    t1Ms: data[(n - 1) * STRIDE],
    windows: null,
  };
}


/**
 * Interpolate a state, writing into caller-supplied arrays.
 *
 * Taking output buffers avoids allocating two arrays per sample, which dominates
 * the cost of a sweep through thousands of pairs.
 */
function interpolateInto(
  track: Track,
  lo: number,
  tMs: number,
  outR: Vec3,
  outV: Vec3,
): void {
  const d = track.data;
  const a = lo * STRIDE;
  const b = a + STRIDE;
  const ta = d[a];
  const dt = d[b] - ta;
  const f = dt === 0 ? 0 : (tMs - ta) / dt;
  const g = 1 - f;

  outR[0] = d[a + 1] * g + d[b + 1] * f;
  outR[1] = d[a + 2] * g + d[b + 2] * f;
  outR[2] = d[a + 3] * g + d[b + 3] * f;
  outV[0] = d[a + 4] * g + d[b + 4] * f;
  outV[1] = d[a + 5] * g + d[b + 5] * f;
  outV[2] = d[a + 6] * g + d[b + 6] * f;
}

/** Index of the sample bracketing `tMs` (binary search). */
function bracket(track: Track, tMs: number): number {
  const d = track.data;
  let lo = 0;
  let hi = track.count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (d[mid * STRIDE] <= tMs) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Linear interpolation of state (and covariance when present). */
/**
 * State at an instant.
 *
 * `withCovariance` is false for the TCA refinement, which runs the golden-section
 * search ~30 times per candidate approach and only compares positions. Building the
 * interpolated 36-value matrix there was pure waste: it allocates an array and reads
 * 72 doubles from the covariance buffer on every iteration, for data the caller
 * discards.
 */
function stateAt(track: Track, tMs: number, withCovariance = true): Sample | null {
  if (tMs < track.t0Ms || tMs > track.t1Ms) return null;
  if (track.count === 1) {
    const d = track.data;
    return {
      tMs,
      r: [d[1], d[2], d[3]],
      v: [d[4], d[5], d[6]],
      cov: withCovariance ? interpCov(track, 0, 0, 0) : null,
    };
  }

  const lo = bracket(track, tMs);
  const r: Vec3 = [0, 0, 0];
  const v: Vec3 = [0, 0, 0];
  interpolateInto(track, lo, tMs, r, v);

  let cov: Mat3 | null = null;
  if (withCovariance && track.covs) {
    const d = track.data;
    const f = (tMs - d[lo * STRIDE]) / (d[(lo + 1) * STRIDE] - d[lo * STRIDE] || 1);
    cov = interpCov(track, lo, lo + 1, f);
  }

  return { tMs, r, v, cov };
}

/**
 * Linearly interpolate the 3x3 position blocks of states `ia` and `ib`.
 *
 * Reports null unless *both* ends carry a matrix, matching the old rule: a state
 * with no covariance makes Pc unknown at that epoch rather than zero.
 */
function interpCov(track: Track, ia: number, ib: number, f: number): Mat3 | null {
  const a: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const b: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  if (!covPosAt(track, ia, a) || !covPosAt(track, ib, b)) return null;
  const g = 1 - f;
  for (let i = 0; i < 9; i += 1) a[i] = a[i] * g + b[i] * f;
  return a;
}

/** Mutable cursor for strictly forward sampling of one track. */
export interface TrackCursor {
  track: Track;
  index: number;
}

/**
 * Advance a cursor to time `tMs` and interpolate, without allocating.
 *
 * The coarse pass hits times in ascending order, so the bracketing pair is
 * either the current one or a later one — advancing is O(1) amortised and there
 * is no binary search in the hot loop.
 */
function advanceTo(cursor: TrackCursor, tMs: number, outR: Vec3, outV: Vec3): boolean {
  const track = cursor.track;
  if (tMs < track.t0Ms || tMs > track.t1Ms) return false;
  const d = track.data;
  const last = track.count - 1;
  if (track.count === 1) {
    outR[0] = d[1]; outR[1] = d[2]; outR[2] = d[3];
    outV[0] = d[4]; outV[1] = d[5]; outV[2] = d[6];
    return true;
  }

  let i = cursor.index;
  while (i < last - 1 && d[(i + 1) * STRIDE] <= tMs) i += 1;
  cursor.index = i;
  interpolateInto(track, i, tMs, outR, outV);
  return true;
}

/** Coarse step so the whole window is covered within the sample budget. */
function chooseCoarseStep(startMs: number, endMs: number, budget: number): number {
  const span = endMs - startMs;
  // ~60 s keeps a 1-day overlap at ~1440 samples; budget tightens it further.
  const preferred = 60_000;
  if (!budget || budget <= 0) return preferred;
  const byBudget = span / Math.max(32, budget);
  return Math.max(1_000, Math.min(preferred, byBudget));
}

// ---------------------------------------------------------------------------
// Box test
// ---------------------------------------------------------------------------

/** Pre-allocated RTN scratch for the hot loop. Module-level: `screen` is
 * synchronous, so there is no re-entrancy hazard, and this keeps the inner
 * sampling loop allocation-free. */
/**
 * Box test in RTN, written with scalars rather than a precomputed matrix.
 *
 * Equivalent to building the RTN basis and projecting, but inlineable: no 9-
 * element array is created per sample, and the radial term (the one that
 * rejects nearly everything, since it is only 2 km wide) is tested first and
 * short-circuits before the orbit normal is even needed.
 */
function inBoxScalar(
  relX: number,
  relY: number,
  relZ: number,
  rx: number,
  ry: number,
  rz: number,
  vx: number,
  vy: number,
  vz: number,
): boolean {
  // R axis: unit position.
  const rn = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (rn === 0) return false;
  const ux = rx / rn;
  const uy = ry / rn;
  const uz = rz / rn;

  const alongR = relX * ux + relY * uy + relZ * uz;
  if (alongR > SCREENING_BOX_KM.radial || alongR < -SCREENING_BOX_KM.radial) return false;

  // N axis: orbit normal, h = r x v.
  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const hn = Math.sqrt(hx * hx + hy * hy + hz * hz);
  if (hn === 0) return false;
  const nx = hx / hn;
  const ny = hy / hn;
  const nz = hz / hn;

  // T axis: N x R, completing the right-handed set.
  const tx = ny * uz - nz * uy;
  const ty = nz * ux - nx * uz;
  const tz = nx * uy - ny * ux;

  const alongT = relX * tx + relY * ty + relZ * tz;
  if (alongT > SCREENING_BOX_KM.alongTrack || alongT < -SCREENING_BOX_KM.alongTrack) return false;
  const alongN = relX * nx + relY * ny + relZ * nz;
  if (alongN > SCREENING_BOX_KM.crossTrack || alongN < -SCREENING_BOX_KM.crossTrack) return false;

  return true;
}

/**
 * Box test against a precomputed RTN basis.
 *
 * The radial half-width is only 2 km against 44/51 km along/cross track, so the
 * radial term rejects almost every sample on its own. Testing it first and
 * returning early is what makes this cheap — the remaining dot products are
 * only needed for the handful of samples that get that far.
 */
function inScreeningBoxPrecomputed(rel: Vec3, basis: Mat3): boolean {
  const rx = rel[0];
  const ry = rel[1];
  const rz = rel[2];

  // Primary's R axis (= unit position). Cheapest possible first filter.
  const x = basis[0] * rx + basis[1] * ry + basis[2] * rz;
  if (x > SCREENING_BOX_KM.radial || x < -SCREENING_BOX_KM.radial) return false;
  const y = basis[3] * rx + basis[4] * ry + basis[5] * rz;
  if (y > SCREENING_BOX_KM.alongTrack || y < -SCREENING_BOX_KM.alongTrack) return false;
  const z = basis[6] * rx + basis[7] * ry + basis[8] * rz;
  if (z > SCREENING_BOX_KM.crossTrack || z < -SCREENING_BOX_KM.crossTrack) return false;

  // Inside the primary's box.
  return true;
}

/**
 * Bidirectional box test: primary-in-secondary's-box is an encounter too.
 * Split out so the hot path can bail after the primary test alone.
 */
function inScreeningBoxBidirectional(rel: Vec3, primaryBasis: Mat3, secondaryBasis: Mat3): boolean {
  if (inScreeningBoxPrecomputed(rel, primaryBasis)) return true;
  return inScreeningBoxPrecomputed([-rel[0], -rel[1], -rel[2]], secondaryBasis);
}

/** True when `rel` (in inertial km) lands inside the box centred on (r, v). */
function inScreeningBox(rel: Vec3, r: Vec3, v: Vec3): boolean {
  return inScreeningBoxPrecomputed(rel, rtnBasis(r, v));
}

/**
 * True when the RTN components of a miss vector fall inside the screening box.
 *
 * The box is axis-aligned in RTN, so this is the exact test — a bounding sphere
 * would wrongly admit approaches up to ~67 km out.
 */
function rtnInsideBox(rtn: Vec3): boolean {
  return (
    Math.abs(rtn[0]) <= SCREENING_BOX_KM.radial &&
    Math.abs(rtn[1]) <= SCREENING_BOX_KM.alongTrack &&
    Math.abs(rtn[2]) <= SCREENING_BOX_KM.crossTrack
  );
}

// ---------------------------------------------------------------------------
// TCA refinement
// ---------------------------------------------------------------------------

/**
 * Golden-section search for the minimum relative distance in [loMs, hiMs].
 *
 * The range-rate sign change bounds the minimum; this narrows it to ~1 ms.
 */
function refineTca(primary: Track, secondary: Track, loMs: number, hiMs: number): number | null {
  const INV_PHI = (Math.sqrt(5) - 1) / 2;
  let a = loMs;
  let b = hiMs;
  let c = b - INV_PHI * (b - a);
  let d = a + INV_PHI * (b - a);

  const rangeAt = (t: number): number | null => {
    const pa = stateAt(primary, t, false);
    const pb = stateAt(secondary, t, false);
    if (!pa || !pb) return null;
    const gap = sub(pb.r, pa.r);
    return Math.hypot(gap[0], gap[1], gap[2]);
  };

  const fc = rangeAt(c);
  const fd = rangeAt(d);
  if (fc === null || fd === null) return null;

  let fcv = fc;
  let fdv = fd;

  for (let i = 0; i < 80 && b - a > 1; i += 1) {
    if (fcv < fdv) {
      b = d;
      d = c;
      fdv = fcv;
      c = b - INV_PHI * (b - a);
      const v = rangeAt(c);
      if (v === null) break;
      fcv = v;
    } else {
      a = c;
      c = d;
      fcv = fdv;
      d = a + INV_PHI * (b - a);
      const v = rangeAt(d);
      if (v === null) break;
      fdv = v;
    }
  }

  return (a + b) / 2;
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

function buildApproach(
  primary: Track,
  secondary: Track,
  tcaMs: number,
): CloseApproachMsg | null {
  const pa = stateAt(primary, tcaMs);
  const pb = stateAt(secondary, tcaMs);
  if (!pa || !pb) return null;

  const rel = sub(pb.r, pa.r);
  const relVel = sub(pb.v, pa.v);
  const totalMiss = Math.hypot(rel[0], rel[1], rel[2]);

  // RTN components of the miss vector, relative to the primary.
  const basis = rtnBasis(pa.r, pa.v);
  const rtn = [
    basis[0] * rel[0] + basis[1] * rel[1] + basis[2] * rel[2],
    basis[3] * rel[0] + basis[4] * rel[1] + basis[5] * rel[2],
    basis[6] * rel[0] + basis[7] * rel[1] + basis[8] * rel[2],
  ];

  const combinedRadius = primary.hardBodyRadiusKm + secondary.hardBodyRadiusKm;

  // A close approach only exists inside the screening volume. Check against the
  // reported TCA state rather than the coarse sample that triggered the search.
  //
  // This must be **bidirectional** and use the same test the coarse pass uses:
  // primary-in-secondary's-box is the same encounter as
  // secondary-in-primary's-box. An earlier version checked only the primary's
  // box here (via the matrix path) while the coarse pass checked both (via the
  // scalar path), so the same pair reported 7 approaches forwards and 5
  // backwards — the boundary cases fell on opposite sides of the two
  // implementations. One predicate, used everywhere.
  const insidePrimary = inBoxScalar(
    rel[0], rel[1], rel[2],
    pa.r[0], pa.r[1], pa.r[2],
    pa.v[0], pa.v[1], pa.v[2]
  );
  const insideSecondary = inBoxScalar(
    -rel[0], -rel[1], -rel[2],
    pb.r[0], pb.r[1], pb.r[2],
    pb.v[0], pb.v[1], pb.v[2]
  );
  if (!insidePrimary && !insideSecondary) return null;

  // Pc requires covariance on *both* sides, per the documented CDM rule.
  let alfano: AlfanoResult | null = null;
  let failure = "";
  if (!pa.cov || !pb.cov) {
    failure =
      "One or both trajectories supplied no covariance; Pc is NULL.";
  } else {
    alfano = alfano2d({
      relativePosition: rel,
      relativeVelocity: relVel,
      combinedCovariance: addMat3(pa.cov, pb.cov),
      hardBodyRadiusKm: combinedRadius,
    });
    if (!alfano) {
      failure =
        "Collision probability calculation failed (degenerate covariance or relative velocity).";
    }
  }

  return {
    tcaEpochMs: String(Math.round(tcaMs)),
    missDistanceKm: alfano?.missDistanceKm ?? totalMiss,
    totalMissDistanceKm: totalMiss,
    relativeSpeedKmS: alfano?.relativeSpeedKmS ?? Math.hypot(relVel[0], relVel[1], relVel[2]),
    probabilityOfCollision: alfano?.probability ?? undefined,
    pcFailureReason: failure,
    rtnR: rtn[0],
    rtnT: rtn[1],
    rtnN: rtn[2],
    covXx: alfano?.covariance2d[0] ?? 0,
    covXy: alfano?.covariance2d[1] ?? 0,
    covYy: alfano?.covariance2d[2] ?? 0,
    lowRelativeSpeed: alfano?.lowRelativeSpeed ?? false,
  };
}

/** Sum two 3x3 position covariances element-wise. */
function addMat3(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0] + b[0], a[1] + b[1], a[2] + b[2],
    a[3] + b[3], a[4] + b[4], a[5] + b[5],
    a[6] + b[6], a[7] + b[7], a[8] + b[8],
  ];
}

/** Collapse approaches whose TCAs are within the event grouping window. */
function dedupe(approaches: CloseApproachMsg[]): CloseApproachMsg[] {
  const WINDOW_MS = 20 * 60_000; // same 20-minute rule used for event grouping
  const sorted = [...approaches].sort(
    (x, y) => Number(x.tcaEpochMs) - Number(y.tcaEpochMs),
  );
  const out: CloseApproachMsg[] = [];
  for (const a of sorted) {
    const last = out[out.length - 1];
    if (
      last &&
      Math.abs(Number(a.tcaEpochMs) - Number(last.tcaEpochMs)) < WINDOW_MS
    ) {
      // Keep the closer approach.
      if (a.totalMissDistanceKm < last.totalMissDistanceKm) out[out.length - 1] = a;
      continue;
    }
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exports used by tests and by the trajectory upsampler
// ---------------------------------------------------------------------------

export { stateAt as interpolateTrack, toTrack, inScreeningBox, refineTca };
export type { Track, Sample };
