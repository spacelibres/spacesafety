/**
 * Screening-box geometry, in one place.
 *
 * Every module that reasons about "could these two be close enough to matter"
 * needs these numbers — the kernel, the radial pre-filter, and the time-window
 * pruner. Keeping them in a leaf module means those three cannot drift apart,
 * which matters because a pre-filter using a *smaller* box than the kernel is
 * exactly how conjunctions get silently dropped.
 *
 * Values from the vendor architecture doc
 * (`docs/starlink-space-safety/tutorial-basics/architecture.md`).
 */

/** Screening-box half-widths in RTN, km. */
export const SCREENING_BOX_KM = {
  radial: 2,
  alongTrack: 44,
  crossTrack: 51,
} as const;

/**
 * Farthest a reported encounter can sit from the primary's position, km.
 *
 * The box's half-diagonal. Anything beyond this cannot be inside the box in any
 * orientation, so it is the natural padding for any spatial pre-test.
 */
export const SCREENING_BOX_REACH_KM = Math.hypot(
  SCREENING_BOX_KM.radial,
  SCREENING_BOX_KM.alongTrack,
  SCREENING_BOX_KM.crossTrack,
);
