/**
 * Radial pre-filter for conjunction screening.
 *
 * ## Why this exists
 *
 * Screening a constellation is O(n²) if every pair reaches the kernel. A cheap
 * test that rejects most pairs is therefore essential — but only if it is
 * *provably* safe. The bench harness asserts that the filtered sweep finds every
 * approach the unfiltered one finds, so a pre-filter that drops a real
 * conjunction fails the build.
 *
 * ## Why the obvious versions are wrong
 *
 * **`R·θ < box`** (orbit planes closer than the box reach): valid only for equal
 * radii. Two orbits 12 km apart radially but 4.7° apart in plane can meet at the
 * node crossing, where both planes coincide — so this test dropped 1299 real
 * approaches in the benchmark.
 *
 * **Single-point apogee/perigee bands**: derived from one state vector, so they
 * describe one instant, not the revolution. For a slightly eccentric orbit the
 * radius sweeps a whole band, and two orbits can be far apart at the sampled
 * instant yet coincident elsewhere in the revolution.
 *
 * ## What we do instead
 *
 * Summarise the *sampled* radius history of each trajectory into a histogram of
 * occupancy over radial bins, then reject a pair only when their occupied bins
 * never come within the box reach of each other. This is conservative by
 * construction: if no sample of A is radially near any sample of B, no in-box
 * state can exist, because the box is only 2 km wide radially.
 *
 * The honest caveat: because the histogram is built from the states we actually
 * hold, it inherits their radial spread. A 3-day Starlink arc with 1e-3
 * eccentricity sweeps several km of radius and will overlap its neighbours'
 * bands — so on real data the rejection rate is modest. That is reported, not
 * hidden. The point is that whatever it rejects is provably safe.
 */

import { RE_EARTH } from "./propagator";
import { SCREENING_BOX_KM } from "./screening-box";

export { SCREENING_BOX_KM } from "./screening-box";
/**
 * How far apart two occupied radial bins may be and still admit an encounter.
 *
 * The box reach in the orbital plane is `hypot(2, 51)` ≈ 51 km; two spacecraft
 * that far apart radially can still be inside *each other's* box along track.
 * Keep one bin of slack (plus the radial half-width) so that bin quantisation
 * can never cause a rejection: a pair whose true gap is just under the limit
 * must never be separated by a bin boundary.
 */
export const PREFILTER_REACH_KM = Math.hypot(
  SCREENING_BOX_KM.radial,
  SCREENING_BOX_KM.crossTrack,
) + SCREENING_BOX_KM.radial;

/** Width of one radial histogram bin, km. */
export const RADIAL_BIN_KM = 5;

/**
 * Radial occupancy summary for one trajectory.
 *
 * `minBin`/`maxBin` are inclusive indices of the occupied range; together with
 * `occupied` they let the pairwise test skip anything that never comes near.
 */
export interface RadialProfile {
  /** Lowest occupied bin index (can be negative). */
  minBin: number;
  /** Highest occupied bin index. */
  maxBin: number;
  /** Occupied bin indices, ascending, for the sparse test. */
  occupied: Int32Array;
  /** Occupied fraction, for diagnostics. */
  coverage: number;
}

const binOf = (altitudeKm: number): number => Math.floor(altitudeKm / RADIAL_BIN_KM);

/**
 * Build a radial profile from a trajectory's sampled radii.
 *
 * Uses every state, so a trajectory with a 3-day arc captures the full radial
 * sweep of its orbit rather than one instant of it.
 */
export function buildRadialProfile(radiiKm: number[]): RadialProfile {
  if (radiiKm.length === 0) {
    return { minBin: 0, maxBin: -1, occupied: new Int32Array(0), coverage: 0 };
  }

  let minBin = Infinity;
  let maxBin = -Infinity;
  for (const r of radiiKm) {
    const b = binOf(r);
    if (b < minBin) minBin = b;
    if (b > maxBin) maxBin = b;
  }

  const span = maxBin - minBin + 1;
  const seen = new Uint8Array(span);
  for (const r of radiiKm) seen[binOf(r) - minBin] = 1;

  let count = 0;
  for (let i = 0; i < span; i += 1) count += seen[i];

  const occupied = new Int32Array(count);
  let k = 0;
  for (let i = 0; i < span; i += 1) {
    if (seen[i]) occupied[k++] = i + minBin;
  }

  return { minBin, maxBin, occupied, coverage: count / span };
}

/** Convenience: profile straight from inertial position vectors (km). */
export function profileFromStates(
  states: ArrayLike<{ position: ArrayLike<number> }>,
): RadialProfile {
  const radii: number[] = [];
  for (let i = 0; i < states.length; i += 1) {
    const p = states[i].position;
    radii.push(Math.hypot(p[0], p[1], p[2]) - RE_EARTH);
  }
  return buildRadialProfile(radii);
}

/**
 * True when the two profiles never come within reach of each other.
 *
 * Exported mostly so tests can assert the rejection directly; callers should use
 * `radiallyReachable`.
 */
export function radiallySeparated(a: RadialProfile, b: RadialProfile): boolean {
  // Cheap interval test first: if the occupied ranges are far apart, skip the
  // sparse walk entirely. This is the common case across distinct shells.
  const binReach = Math.ceil(PREFILTER_REACH_KM / RADIAL_BIN_KM);
  if (b.minBin - a.maxBin > binReach) return true;
  if (a.minBin - b.maxBin > binReach) return true;

  // Ranges overlap or nearly touch: walk the shorter list and probe the other.
  const [short, long] = a.occupied.length <= b.occupied.length ? [a, b] : [b, a];
  const longSet = new Set(long.occupied);
  for (let i = 0; i < short.occupied.length; i += 1) {
    const bin = short.occupied[i];
    // Neighbouring bins within reach both count.
    for (let d = -binReach; d <= binReach; d += 1) {
      if (longSet.has(bin + d)) return false;
    }
  }
  return true;
}

/**
 * The pre-filter predicate: may this pair produce a close approach?
 *
 * Conservative in the only direction that matters — it can return `true` for a
 * pair that turns out to be harmless (lost time), but never `false` for a pair
 * that would have been reported (lost finding).
 */
export function radiallyReachable(a: RadialProfile, b: RadialProfile): boolean {
  return !radiallySeparated(a, b);
}

/** Bin index range covered by a profile, for the sweep's early exit. */
export function profileRange(p: RadialProfile): { minBin: number; maxBin: number } {
  return { minBin: p.minBin, maxBin: p.maxBin };
}

/** How far apart two profiles' ranges may be before the sweep can stop. */
export const SWEEP_EXIT_BINS = Math.ceil(PREFILTER_REACH_KM / RADIAL_BIN_KM);
