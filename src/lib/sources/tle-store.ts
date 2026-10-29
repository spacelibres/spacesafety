/**
 * Build the `trajectories` row for a stored TLE.
 *
 * Kept separate from the script so the shape is testable without a database: the
 * row has more required columns than a TLE obviously suggests, and getting one
 * of them wrong (a nullable `start_at`, a zero `point_count`) makes the object
 * look broken everywhere that reads it.
 */

import type { Tle } from "../orbit/tle";

export interface StoredTleRow {
  objectId: string;
  operatorId: string;
  seq: number;
  uploadType: string;
  stateSource: string;
  fileText: string;
  fileFormat: string;
  startAt: string | null;
  endAt: string | null;
  pointCount: number;
  uploadedAt: string;
  createdAt: string;
  hasCovariance: boolean;
}

/**
 * A TLE is a single-epoch element set, so its "trajectory" is one point at the
 * epoch. Screening treats it as a seed for SGP4, not as an arc: `point_count = 1`
 * is what marks it as preliminary in `source-policy`.
 */
export function toStoredTrajectory(
  objectId: string,
  operatorId: string,
  seq: number,
  tle: Tle,
): StoredTleRow {
  const now = new Date().toISOString();
  const epoch = new Date(tle.epochMs).toISOString();
  return {
    objectId,
    operatorId,
    seq,
    uploadType: "catalog",
    stateSource: "tle",
    fileText: [tle.name ?? "", tle.line1, tle.line2].filter(Boolean).join("\n"),
    fileFormat: "tle",
    startAt: epoch,
    endAt: epoch,
    pointCount: 1,
    uploadedAt: now,
    createdAt: now,
    // SGP4 carries no covariance, which is why a TLE-sourced conjunction has a
    // NULL Pc by construction rather than by a failure.
    hasCovariance: false,
  };
}
