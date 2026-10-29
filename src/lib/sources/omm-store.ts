/**
 * Store Space-Track OMMs.
 *
 * ## What an OMM is, and is not
 *
 * The OMM is the *same orbit* as the TLE, re-encoded: `REF_FRAME = TEME` and
 * `MEAN_ELEMENT_THEORY = SGP4` on every record. It is not a more precise source
 * and must not be used to replace an operator ephemeris.
 *
 * What it does give, which the TLE does not:
 *
 *   - **Named, typed fields.** No fixed columns or checksum digits to parse.
 *   - **Derived quantities**: `SEMIMAJOR_AXIS`, `PERIOD`, `APOGEUS`/`PERIGEUS`,
 *     `OBJECT_TYPE`, `RCS_SIZE`, `LAUNCH_DATE`, `DECAY_DATE`.
 *   - **An international designator** (`2026-160A`) linking the object to a launch.
 *
 * So it is stored as `state_source = "omm"` for catalogue metadata and identity,
 * alongside — not instead of — the TLE, which stays the trajectory used for SGP4.
 */

import type { OmmRecord } from "./space-track";
import { formatOmm } from "./omm-format";

export interface StoredOmmRow {
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
 * A single-epoch element set, exactly like a TLE — `point_count = 1` keeps it out
 * of screening as an arc. The stored text is CCSDS OMM KVN, so the same parser
 * that reads vendor OCM/OMM files can read what we store.
 */
export function toStoredOmm(
  objectId: string,
  operatorId: string,
  seq: number,
  omm: OmmRecord,
): StoredOmmRow {
  const now = new Date().toISOString();
  const epoch = new Date(omm.epochMs).toISOString();
  return {
    objectId,
    operatorId,
    seq,
    uploadType: "catalog",
    stateSource: "omm",
    fileText: formatOmm(omm),
    fileFormat: "omm",
    startAt: epoch,
    endAt: epoch,
    pointCount: 1,
    uploadedAt: now,
    createdAt: now,
    hasCovariance: false,
  };
}
