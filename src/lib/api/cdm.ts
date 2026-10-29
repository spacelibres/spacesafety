/**
 * CDM generation and serialization.
 *
 * A Conjunction Data Message is the vendor's primary output primitive: it is
 * produced for *every* pair of trajectories that fall inside the screening box,
 * even when Pc evaluates to zero (`docs/SPEC-BEHAVIOR.md` §2, §4.4).
 *
 * CCSDS 508.0-B-1 defines the message. We emit the KVN serialization for the
 * `?format=kvn` download and a JSON projection for everything else, keeping both
 * views of the same record so they can never disagree.
 */

import { dateToGpsNanos } from "../space-safety/gps";
import type { CloseApproachMsg } from "../grpc/proto";

export interface CdmParties {
  object1Id: string;
  object1Name: string;
  object1Maneuverable: boolean;
  object1HardBodyRadiusKm: number;
  operator1Id: string;
  operator1Name: string;

  object2Id: string;
  object2Name: string;
  object2Maneuverable: boolean;
  object2HardBodyRadiusKm: number;
  operator2Id: string;
  operator2Name: string;
}

export interface CdmTrajectories {
  trajectory1Id: string;
  trajectory1Source: string;
  trajectory1CreatedAt: string;
  trajectory2Id: string;
  trajectory2Source: string;
  trajectory2CreatedAt: string;
}

export interface CdmInput {
  id: string;
  createdAt: string;
  originator: string;
  /** Close-approach geometry from the screening kernel. */
  approach: CloseApproachMsg;
  parties: CdmParties;
  trajectories: CdmTrajectories;
}

/** The vendor's exact comment when Pc cannot be computed. */
export const COMMENT_PC_FAILED =
  "COMMENT_FAILED_COLLISION_PROBABILITY_CALCULATION_ALFANO = Collision probability calculation failed.";

export const COMMENT_LOW_RELATIVE_SPEED =
  "COMMENT_LOW_RELATIVE_VELOCITY_2D_ALFANO = Two-dimensional probability may be inaccurate at low relative velocity.";

/** JSON projection stored in the database and served by `?format=json`. */
export interface CdmJson {
  CCSDS_CDM_VERS: string;
  CREATION_DATE: string;
  ORIGINATOR: string;
  MESSAGE_ID: string;
  COMMENT: string[];

  TCA: string;
  MISS_DISTANCE: number | null;
  RELATIVE_SPEED: number | null;
  RELATIVE_POSITION_R: number | null;
  RELATIVE_POSITION_T: number | null;
  RELATIVE_POSITION_N: number | null;
  COLLISION_PROBABILITY: number | null;

  OBJECT1: {
    OBJECT: string;
    OBJECT_DESIGNATOR: string;
    CATALOG_NAME: string;
    MANEUVERABLE: boolean;
    REF_FRAME: string;
    HARD_BODY_RADIUS: number;
    COVARIANCE_MATRIX: number[] | null;
  };
  OBJECT2: {
    OBJECT: string;
    OBJECT_DESIGNATOR: string;
    CATALOG_NAME: string;
    MANEUVERABLE: boolean;
    REF_FRAME: string;
    HARD_BODY_RADIUS: number;
    COVARIANCE_MATRIX: number[] | null;
  };
}

/** Build the JSON projection of a CDM. */
export function buildCdmJson(input: CdmInput): CdmJson {
  const { approach, parties, trajectories } = input;

  const comments: string[] = [];
  if (approach.probabilityOfCollision === undefined) {
    comments.push(COMMENT_PC_FAILED);
    if (approach.pcFailureReason) {
      comments.push(`COMMENT_PC_FAILURE_REASON = ${approach.pcFailureReason}`);
    }
  }
  if (approach.lowRelativeSpeed) comments.push(COMMENT_LOW_RELATIVE_SPEED);

  // The encounter-plane 2x2 covariance is what Alfano used.
  const cov =
    approach.covXx || approach.covXy || approach.covYy
      ? [approach.covXx, approach.covXy, approach.covYy]
      : null;

  return {
    CCSDS_CDM_VERS: "1.0",
    CREATION_DATE: input.createdAt,
    ORIGINATOR: input.originator,
    MESSAGE_ID: input.id,
    COMMENT: comments,

    // `tcaEpochMs` is Unix milliseconds (the kernel's native unit), not GPS
    // nanoseconds — converting it through gpsNanosToDate would render a date in
    // 1980.
    TCA: new Date(Number(approach.tcaEpochMs)).toISOString(),
    MISS_DISTANCE: Number.isFinite(approach.missDistanceKm)
      ? approach.missDistanceKm
      : null,
    RELATIVE_SPEED: Number.isFinite(approach.relativeSpeedKmS)
      ? approach.relativeSpeedKmS
      : null,
    RELATIVE_POSITION_R: approach.rtnR,
    RELATIVE_POSITION_T: approach.rtnT,
    RELATIVE_POSITION_N: approach.rtnN,
    COLLISION_PROBABILITY:
      approach.probabilityOfCollision === undefined
        ? null
        : approach.probabilityOfCollision,

    OBJECT1: {
      OBJECT: parties.object1Name,
      OBJECT_DESIGNATOR: parties.object1Id,
      CATALOG_NAME: parties.operator1Name,
      MANEUVERABLE: parties.object1Maneuverable,
      REF_FRAME: "J2000",
      HARD_BODY_RADIUS: parties.object1HardBodyRadiusKm * 1000,
      COVARIANCE_MATRIX: cov,
    },
    OBJECT2: {
      OBJECT: parties.object2Name,
      OBJECT_DESIGNATOR: parties.object2Id,
      CATALOG_NAME: parties.operator2Name,
      MANEUVERABLE: parties.object2Maneuverable,
      REF_FRAME: "J2000",
      HARD_BODY_RADIUS: parties.object2HardBodyRadiusKm * 1000,
      COVARIANCE_MATRIX: cov,
    },
  } as CdmJson & {
    TRAJECTORY1_ID: string;
    TRAJECTORY1_SOURCE: string;
    TRAJECTORY2_ID: string;
    TRAJECTORY2_SOURCE: string;
  };
}

/**
 * Serialize a CDM to CCSDS KVN.
 *
 * Only the keywords we can populate are emitted; CCSDS treats unknown keys as
 * comments, so a peer parser that expects more will not choke.
 */
export function toKvn(cdm: CdmJson): string {
  const lines: string[] = [];
  const push = (...kv: (string | number | boolean | null | undefined)[]) => {
    lines.push(kv.filter((v) => v !== null && v !== undefined).join(" = "));
  };

  push("CCSDS_CDM_VERS", cdm.CCSDS_CDM_VERS);
  push("COMMENT generated by Space Eyes (space-safety replica)");
  push("CREATION_DATE", cdm.CREATION_DATE);
  push("ORIGINATOR", cdm.ORIGINATOR);
  push("MESSAGE_ID", cdm.MESSAGE_ID);
  for (const c of cdm.COMMENT) {
    // Comments already carry their own "COMMENT ... = ..." prefix.
    lines.push(c);
  }
  lines.push("");

  // --- header ------------------------------------------------------------
  push("TCA", cdm.TCA);
  push("MISS_DISTANCE", fmtNum(cdm.MISS_DISTANCE));
  push("RELATIVE_SPEED", fmtNum(cdm.RELATIVE_SPEED));
  push("RELATIVE_POSITION_R", fmtNum(cdm.RELATIVE_POSITION_R));
  push("RELATIVE_POSITION_T", fmtNum(cdm.RELATIVE_POSITION_T));
  push("RELATIVE_POSITION_N", fmtNum(cdm.RELATIVE_POSITION_N));
  // CCSDS allows NULL when the probability could not be evaluated.
  push(
    "COLLISION_PROBABILITY",
    cdm.COLLISION_PROBABILITY === null ? "NULL" : fmtSci(cdm.COLLISION_PROBABILITY),
  );
  lines.push("");

  // --- object 1 ----------------------------------------------------------
  push("OBJECT", cdm.OBJECT1.OBJECT);
  push("OBJECT_DESIGNATOR", cdm.OBJECT1.OBJECT_DESIGNATOR);
  push("CATALOG_NAME", cdm.OBJECT1.CATALOG_NAME);
  push("MANEUVERABLE", cdm.OBJECT1.MANEUVERABLE);
  push("REF_FRAME", cdm.OBJECT1.REF_FRAME);
  push("HARD_BODY_RADIUS", fmtNum(cdm.OBJECT1.HARD_BODY_RADIUS));
  lines.push("");

  // --- object 2 ----------------------------------------------------------
  push("OBJECT", cdm.OBJECT2.OBJECT);
  push("OBJECT_DESIGNATOR", cdm.OBJECT2.OBJECT_DESIGNATOR);
  push("CATALOG_NAME", cdm.OBJECT2.CATALOG_NAME);
  push("MANEUVERABLE", cdm.OBJECT2.MANEUVERABLE);
  push("REF_FRAME", cdm.OBJECT2.REF_FRAME);
  push("HARD_BODY_RADIUS", fmtNum(cdm.OBJECT2.HARD_BODY_RADIUS));

  return lines.join("\n") + "\n";
}

function fmtNum(v: number | null | undefined): string | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return v.toPrecision(12);
}

function fmtSci(v: number): string {
  if (v === 0) return "0";
  return v.toExponential(6);
}

/** Serialize with a stable key order, for storage. */
export function stringifyCdm(cdm: CdmJson): string {
  return JSON.stringify(cdm);
}

export { dateToGpsNanos };
