/**
 * Serialise a Space-Track OMM record back to CCSDS OMM KVN.
 *
 * Storing the record as the standard text form (rather than as our own JSON)
 * means it round-trips through the same parser used for vendor files, and the
 * archive stays readable by any CCSDS tool.
 */

import type { OmmRecord } from "./space-track";

/** Celsius to the KVN `YYYY-MM-DDTHH:MM:SS` form, dropping the trailing `Z`. */
function isoNoZ(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

/**
 * The vendor's `CREATION_DATE`, falling back to the epoch.
 *
 * Never `Date.now()`: the file must describe when the vendor created the record,
 * not when we wrote the file, or two exports of the same data differ.
 */
function creationDate(omm: OmmRecord): string {
  const raw = omm.raw?.CREATION_DATE;
  return raw ? raw.replace("T", " ").replace(/Z$/, "").trim() : isoNoZ(omm.epochMs);
}

export function formatOmm(omm: OmmRecord): string {
  const lines = [
    "CCSDS_OMM_VERS = 3.0",
    "COMMENT GENERATED VIA SPACE-TRACK.ORG API",
    // Take the vendor's own creation date from the raw record when present. Using
    // `Date.now()` here made the KVN disagree with the JSON it accompanies, and
    // claimed the file was created now rather than issued by 18 SPCS.
    `CREATION_DATE = ${creationDate(omm)}`,
    `ORIGINATOR = ${omm.raw?.ORIGINATOR ?? "18 SPCS"}`,
    "",
    "META_START",
    `OBJECT_NAME = ${omm.objectName}`,
    `OBJECT_ID = ${omm.objectId}`,
    "CENTER_NAME = EARTH",
    `REF_FRAME = ${omm.refFrame}`,
    "TIME_SYSTEM = UTC",
    `MEAN_ELEMENT_THEORY = ${omm.meanElementTheory}`,
    "META_STOP",
    "",
    "EPOCH = " + isoNoZ(omm.epochMs),
    `MEAN_MOTION = ${omm.meanMotionRevPerDay}`,
    `ECCENTRICITY = ${omm.eccentricity}`,
    `INCLINATION = ${omm.inclinationDeg}`,
    `RA_OF_ASC_NODE = ${omm.raanDeg}`,
    `ARG_OF_PERICENTER = ${omm.argPericenterDeg}`,
    `MEAN_ANOMALY = ${omm.meanAnomalyDeg}`,
    `EPHEMERIS_TYPE = ${omm.ephemerisType}`,
    "CLASSIFICATION_TYPE = U",
    `NORAD_CAT_ID = ${omm.noradId}`,
    `ELEMENT_SET_NO = ${omm.elementSetNo}`,
    `REV_AT_EPOCH = ${omm.revAtEpoch}`,
    `BSTAR = ${omm.bstar}`,
    `MEAN_MOTION_DOT = ${omm.meanMotionDot}`,
    `MEAN_MOTION_DDOT = ${omm.meanMotionDdot}`,
  ];

  // Catalogue extras are optional in the standard; emit only what we have.
  if (omm.semimajorAxisKm !== null) lines.push(`SEMIMAJOR_AXIS = ${omm.semimajorAxisKm}`);
  if (omm.periodMin !== null) lines.push(`PERIOD = ${omm.periodMin}`);
  if (omm.apogeeKm !== null) lines.push(`APOAPSIS = ${omm.apogeeKm}`);
  if (omm.perigeeKm !== null) lines.push(`PERIAPSIS = ${omm.perigeeKm}`);
  if (omm.objectType) lines.push(`OBJECT_TYPE = ${omm.objectType}`);
  if (omm.rcsSize) lines.push(`RCS_SIZE = ${omm.rcsSize}`);
  if (omm.launchDate) lines.push(`LAUNCH_DATE = ${omm.launchDate}`);
  if (omm.decayDate) lines.push(`DECAY_DATE = ${omm.decayDate}`);

  lines.push("", "DATA_START", "DATA_STOP");
  return lines.join("\n") + "\n";
}
