/**
 * Which trajectory is the object's screening reference.
 *
 * `catalog` answers "given this object, which stored trajectory should it be
 * screened against?" It is keyed `(object_id, state_source)`, so one object can
 * have several entries — an OCM, an ITC, a TLE and an OMM for the same Starlink
 * satellite are all legitimate rows.
 *
 * ## Why only one entry may be used per object
 *
 * Screening pairs objects, and `enqueueScreening` reads *every* catalog row for a
 * partner. With four entries per object the same satellite pair would be screened
 * four times with different inputs, producing four CDMs for one physical event —
 * the dedupe window would keep whichever arrived first, so the result would be
 * whichever source happened to be dispatched first. That is not a precision
 * question; it is a wrong answer.
 *
 * So the reference is chosen by *source quality*, and the rest stay in
 * `trajectories` for cross-checks and the accuracy report:
 *
 *   operator_ephemeris  >  tle/omm
 *
 * `operator_ephemeris` is Starlink's own propagated solution (OCM or Modified
 * ITC): the operator's states, a multi-day arc, and 6x6 covariance. A TLE/OMM is
 * SGP4 mean elements at a single epoch with no covariance — usable for
 * preliminary candidate identification of objects that publish nothing better,
 * and never a replacement for an operator ephemeris.
 */

/** Lower number wins. */
const SOURCE_PRIORITY: Record<string, number> = {
  operator_ephemeris: 0,
  // Vendor-equivalent: both are SGP4 mean elements. Equal rank, so when an object
  // somehow has both the tie breaks on recency.
  tle: 1,
  omm: 1,
  spacex_optical: 2,
};

export function sourceRank(stateSource: string): number {
  return SOURCE_PRIORITY[stateSource] ?? 99;
}

export interface CatalogCandidate {
  trajectoryId: string;
  stateSource: string;
  /** ISO-8601; used to break ties between equally-ranked sources. */
  uploadedAt: string;
  /** Number of state vectors; a proxy for arc length when spans tie. */
  pointCount?: number;
  /** Coverage span in milliseconds, when known. */
  spanMs?: number;
}

/**
 * Pick the reference trajectory from everything stored for one object.
 *
 * Order of preference:
 *
 *   1. Better source quality (`operator_ephemeris` beats `tle`/`omm`).
 *   2. Longer coverage. Starlink holds the same orbit twice — an OCM with a
 *      7-day arc and a Modified ITC with 3 days — and the OCM is the one to screen:
 *      a shorter arc cannot contain a conjunction that happens on day 4, so
 *      choosing the ITC would silently miss approaches rather than merely
 *      compute them less precisely.
 *   3. More state vectors, then the newest upload.
 */
export function selectReference(candidates: CatalogCandidate[]): CatalogCandidate | null {
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => {
    const rank = sourceRank(a.stateSource) - sourceRank(b.stateSource);
    if (rank !== 0) return rank;

    const span = (b.spanMs ?? 0) - (a.spanMs ?? 0);
    if (span !== 0) return span;

    const points = (b.pointCount ?? 0) - (a.pointCount ?? 0);
    if (points !== 0) return points;

    // ISO-8601 sorts lexicographically; newest first.
    return a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0;
  })[0];
}
