/**
 * Time-window pruning for constellation-scale screening.
 *
 * ## The problem
 *
 * The radial pre-filter (`radial-prefilter.ts`) is safe but weak inside a single
 * constellation: Starlink's shells sit 10–22.5 km apart while the screening box
 * reaches 53 km, so it rejects nothing. Screening 11k satellites still means
 * ~62M pair evaluations.
 *
 * ## The insight
 *
 * A satellite does not occupy its whole orbit for the whole window. It sweeps
 * around a ring, and at any instant it is in one place. Two satellites can only
 * meet when they are **somewhere near each other at the same time**. So instead
 * of comparing whole trajectories, compare time slices:
 *
 *   1. Cut both tracks into fixed-length windows (default: one orbital period /
 *      12, so ≈8 minutes for LEO).
 *   2. For each window, compute a bounding box of the occupied positions,
 *      padded by the box reach.
 *   3. Two windows can only contain an encounter if their boxes intersect in
 *      space *and* overlap in time.
 *
 * A satellite covers ~1/12 of its ring per window, so the bounding box of a
 * window is far smaller than the box of a whole orbit — that is where the
 * pruning comes from.
 *
 * ## Correctness
 *
 * This mirrors `radial-prefilter.ts` in spirit: it may only reject pairs that
 * provably cannot produce a close approach. Two guarantees make that true:
 *
 *   - **Padding.** Each window's box is inflated by the screening-box half-
 *     diagonal, because an encounter is reported when the *relative* position
 *     lands in the box, not when the two positions coincide.
 *   - **Interpolation slack.** Samples inside a window are sparse (we take the
 *     raw states, which for Starlink are 60 s apart). A linear interpolant
 *     between two states stays inside the segment's convex hull, so taking the
 *     min/max over the window's samples bounds every interpolated position —
 *     but only for the window's *interior*. Encounters found in the 1-sample gap
 *     between windows are covered by the temporal overlap test, which uses
 *     `[start, end]` inclusive with a one-sample margin.
 *
 * The bench asserts the pruned sweep finds every approach the unpruned one does,
 * so a violation of either guarantee fails the build rather than losing a CDM.
 */

import { SCREENING_BOX_REACH_KM } from "./screening-box";

/** Cartesian bounding box of the positions in one time window, km (inertial). */
export interface WindowBox {
  /** Window start, ms since epoch (inclusive). */
  startMs: number;
  /** Window end, ms since epoch (inclusive). */
  endMs: number;
  /**
   * Bounds of the *sampled* positions, km inertial.
   *
   * By the time these leave `buildWindows` they are already inflated by
   * `windowPaddingKm`, so an intersection test needs no extra margin and two
   * windows built with different window lengths still compare correctly.
   */
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * Padding for a window, km.
 *
 * Two contributions, added:
 *
 *   1. The screening box's half-diagonal — the farthest a *reported* encounter
 *      can sit from the primary while still being inside its box.
 *   2. One **sample step** of orbital motion. This is the part that is easy to
 *      miss: the bounding box covers the sampled positions, but the kernel
 *      interpolates *between* samples. A window holding a single sample has a
 *      one-point box, and the interpolated position can be much of a step away
 *      from it. At 60 s spacing and 7.6 km/s that is ~460 km — enough to lose
 *      every approach whose TCA falls between samples.
 *
 * Note the step is derived from the sample spacing, **not** the window length.
 * Deriving it from the window length looks reasonable and is wrong: it inflates
 * a 7.5-minute window by 3 400 km, which makes every box overlap everything and
 * the prune does nothing. What the interpolant can stray by depends solely on
 * how far apart the samples are.
 */
const NOMINAL_LEO_SPEED_KM_S = 7.6;

export function windowPaddingKm(sampleSpacingMs: number): number {
  const stepKm = NOMINAL_LEO_SPEED_KM_S * (Math.max(0, sampleSpacingMs) / 1000);
  return SCREENING_BOX_REACH_KM + stepKm;
}

/** Padding at a 60 s sample spacing, km. Exported for tests. */
export const WINDOW_PADDING_KM = windowPaddingKm(60_000);

/**
 * Cut a track into spatial windows.
 *
 * `samples` must be a flat `[tMs, x, y, z, ...]` buffer, ascending in time — the
 * same layout `screening.ts` uses, passed by the caller so this module does not
 * depend on the kernel's internals.
 *
 * `paddingKm` overrides the spacing-derived padding above. The default inflates
 * every box by a full sample step, which is right when the caller interpolates
 * between samples but far too much when it only compares sampled states: measured
 * on 300 real Starlinks, the default made 100% of pairs inside one shell pass the
 * window test (mean sampled separation 771 km). The screening loop walks exactly
 * the instants it sampled, so it can pass a padding of the box reach alone.
 *
 * Windows are cut on an **absolute** time grid (`floor(t / windowMs)`), not one
 * anchored per track. That matters: two tracks compared against each other then
 * share window boundaries, so the temporal overlap test compares aligned slices.
 * A per-track anchor would offset every window by the two tracks' start times and
 * the overlap test would report spurious mismatches.
 */
export function buildWindows(
  samples: Float64Array,
  count: number,
  stride: number,
  windowMs: number,
  paddingKm?: number,
): WindowBox[] {
  if (count === 0) return [];

  // Sample spacing, taken from the data rather than assumed. Using the window
  // length would over-inflate long windows and defeat the purpose.
  const spacingMs = count > 1 ? samples[stride] - samples[0] : 0;
  const pad = paddingKm ?? windowPaddingKm(spacingMs);
  const windows: WindowBox[] = [];
  let current: WindowBox | null = null;
  let currentSlot = -Infinity;

  const close = (w: WindowBox) => {
    w.minX -= pad; w.minY -= pad; w.minZ -= pad;
    w.maxX += pad; w.maxY += pad; w.maxZ += pad;
    windows.push(w);
  };

  for (let i = 0; i < count; i += 1) {
    const o = i * stride;
    const t = samples[o];
    const x = samples[o + 1];
    const y = samples[o + 2];
    const z = samples[o + 3];

    const slot = Math.floor(t / windowMs);
    if (!current || slot !== currentSlot) {
      if (current) close(current);
      current = {
        startMs: slot * windowMs,
        endMs: (slot + 1) * windowMs,
        minX: x, maxX: x,
        minY: y, maxY: y,
        minZ: z, maxZ: z,
      };
      currentSlot = slot;
      continue;
    }

    if (x < current.minX) current.minX = x;
    if (x > current.maxX) current.maxX = x;
    if (y < current.minY) current.minY = y;
    if (y > current.maxY) current.maxY = y;
    if (z < current.minZ) current.minZ = z;
    if (z > current.maxZ) current.maxZ = z;
  }
  if (current) close(current);

  return windows;
}

/**
 * Position bounds over a range of a track's samples, padded by the box reach.
 *
 * Used as a time-window pair test that does not depend on how the windows were
 * cut. Two stations can only meet when they occupy overlapping space *and* time,
 * so a pair needs no screening when no sample of one falls inside the position
 * enclosure of the other while both tracks are alive.
 *
 * This is exact rather than heuristic in the direction that matters: it only
 * rejects pairs whose sampled positions are provably more than one screening
 * reach apart. The caller must therefore compare sampled instants, not
 * interpolated ones — see `buildWindows`'s `paddingKm` for why that distinction
 * is the difference between pruning 77% of pairs and pruning none.
 *
 * `startMs`/`endMs` narrow the enclosure to the instant range the caller will
 * actually sample, which keeps the box tight when two tracks overlap for only
 * part of their arcs.
 */
export interface PositionEnclosure {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export function buildEnclosure(
  samples: Float64Array,
  count: number,
  stride: number,
  startMs: number,
  endMs: number,
  floorMs: number,
  ceilingMs: number,
  paddingKm: number = SCREENING_BOX_REACH_KM,
): PositionEnclosure | null {
  const lo = Math.max(startMs, floorMs);
  const hi = Math.min(endMs, ceilingMs);
  if (!(hi >= lo)) return null;
  const first = lowerBoundMs(samples, count, stride, lo);
  if (first < 0) return null;
  // Include the sample before the range start as well: the track's position at
  // `lo` lies between that sample and the first one after it, so omitting it
  // would clip the enclosure on the side the pair is entering from.
  const from = Math.max(0, first - 1);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let seen = 0;
  for (let i = from; i < count; i += 1) {
    const o = i * stride;
    if (i > first && samples[o] > hi) break;
    const x = samples[o + 1];
    const y = samples[o + 2];
    const z = samples[o + 3];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    seen += 1;
  }
  if (seen === 0) return null;
  return {
    minX: minX - paddingKm, minY: minY - paddingKm, minZ: minZ - paddingKm,
    maxX: maxX + paddingKm, maxY: maxY + paddingKm, maxZ: maxZ + paddingKm,
  };
}

/** Index of the first sample at or after `tMs`, or -1 past the end. */
export function lowerBoundMs(
  samples: Float64Array,
  count: number,
  stride: number,
  tMs: number,
): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid * stride] < tMs) lo = mid + 1;
    else hi = mid;
  }
  return lo < count ? lo : -1;
}

/** True when two enclosures share a point on every axis. */
export function enclosuresIntersect(a: PositionEnclosure, b: PositionEnclosure): boolean {
  if (a.maxX < b.minX) return false;
  if (b.maxX < a.minX) return false;
  if (a.maxY < b.minY) return false;
  if (b.maxY < a.minY) return false;
  if (a.maxZ < b.minZ) return false;
  if (b.maxZ < a.minZ) return false;
  return true;
}

/** True when two padded boxes might contain a common point. */
export function boxesMaybeIntersect(a: WindowBox, b: WindowBox): boolean {
  // Bounds are already inflated by `buildWindows`, so this is a plain AABB
  // overlap test. Separated on any axis means separated in space.
  if (a.maxX < b.minX) return false;
  if (b.maxX < a.minX) return false;
  if (a.maxY < b.minY) return false;
  if (b.maxY < a.minY) return false;
  if (a.maxZ < b.minZ) return false;
  if (b.maxZ < a.minZ) return false;
  return true;
}

/** True when two windows overlap in time (inclusive, per the correctness note). */
export function windowsOverlapInTime(a: WindowBox, b: WindowBox): boolean {
  return a.startMs <= b.endMs && b.startMs <= a.endMs;
}

/**
 * Do this pair of window sets contain *any* window pair worth screening?
 *
 * Both inputs must be sorted by `startMs` (which `buildWindows` guarantees).
 *
 * The two-pointer walk here is subtle and got this wrong once. A naive version
 * advanced whichever window ended first and only ever compared the current pair:
 * with equal window lengths and no gaps that is fine, but a track with a *gap*
 * (a dropped sample, or a short arc) leaves one side with empty slots, and the
 * cursors then slide past each other without ever comparing the windows that do
 * overlap. That lost 13 of 367 approaches at a 30-second window length.
 *
 * The correct form mirrors a merge join: for each window of `a`, advance `j` to
 * the first `b` window that *could* overlap it, then scan while it still does.
 * Windows in `b` that end before `a` starts are discarded for good — but only
 * those, so a gap cannot cause a skip.
 */
export function pairNeedsScreening(a: WindowBox[], b: WindowBox[]): boolean {
  let jStart = 0;
  for (let i = 0; i < a.length; i += 1) {
    const wa = a[i];

    // Drop b-windows that end before this a-window begins. Everything before
    // `jStart` is also before every later a-window, so this is safe to keep.
    while (jStart < b.length && b[jStart].endMs < wa.startMs) jStart += 1;

    for (let j = jStart; j < b.length && b[j].startMs <= wa.endMs; j += 1) {
      if (boxesMaybeIntersect(wa, b[j])) return true;
    }
  }
  return false;
}
