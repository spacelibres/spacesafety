/**
 * CCSDS OCM (Orbital Comprehensive Message) parser.
 *
 * This is the richer of the two formats Starlink publishes:
 *
 *   https://www.starlink.com/public-files/ephemerides/STARLINK-<nnnnn>.txt
 *
 * Compared with the Modified ITC files listed in MANIFEST.txt, an OCM adds:
 *   - a 7-day horizon (ITC: 3 days) and ITRF2000 states (the screening
 *     engine's native frame),
 *   - **an explicit maneuver plan** (`MAN_*` sections): which is the whole point,
 *     since it lets a peer know about a burn *before* it happens.
 *
 * Supported subset, matching `docs/starlink-space-safety/api__upload-a-trajectory.md`:
 *   TRAJ_REF_FRAME ∈ {ITRF, ITRF2000, EME2000}, TRAJ_TYPE = CARTPV,
 *   COV_REF_FRAME ∈ {ITRF, ITRF2000, EME2000}, COV_ORDERING = LTM,
 *   MAN_REF_FRAME = NTW_ROTATING, MAN_BASIS = PLANNED.
 *
 * Spec: CCSDS 502.0-B-3 §6.
 */

import { formatDoyTimestamp, lowerTriangleTo6x6 } from "./itc";

export type OcmFrame = "ITRF" | "ITRF2000" | "EME2000" | string;

export interface OcmTrajectoryPoint {
  /** Unix epoch ms (UTC). */
  ms: number;
  position: [number, number, number];
  velocity: [number, number, number];
}

export interface OcmCovariancePoint {
  ms: number;
  /** Row-major 6x6. */
  matrix: number[];
}

/**
 * One planned thrust arc.
 *
 * `acceleration` is expressed in the rotating NTW basis of the spacecraft at
 * the maneuver epoch: N = orbit normal, T = along-track, W = radial outward.
 */
export interface OcmManeuver {
  id: number;
  basis: "PLANNED" | string;
  referenceFrame: "NTW_ROTATING" | string;
  deviceId: string;
  dutyCycleType: "CONTINUOUS" | "TIME" | string;
  /** Absolute start of the burn, Unix ms. */
  startMs: number;
  /** Burn duration in seconds. */
  durationSec: number;
  /** Acceleration in km/s^2 along (N, T, W). */
  acceleration: [number, number, number];
}

export interface Ocm {
  version: string;
  creationDate: string;
  originator: string;
  messageId: string;
  objectName: string;
  objectDesignator: string;
  /**
   * NORAD catalogue number, derived from `OBJECT_DESIGNATOR`.
   *
   * The OCM is the only feed that states the catalogue number, so this is the
   * authoritative source for object identity. Null when the designator is absent
   * or is not a plain number (some operators put an internal id there).
   */
  noradId: number | null;
  operator: string;
  timeSystem: string;
  epochTzero: string;
  startTime: string;
  stopTime: string;

  trajectoryFrame: OcmFrame;
  trajectoryType: string;
  trajectoryUnits: string;

  covarianceFrame: OcmFrame | null;
  covarianceOrdering: string;

  trajectory: OcmTrajectoryPoint[];
  covariance: OcmCovariancePoint[];
  maneuvers: OcmManeuver[];
}

export class OcmParseError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line ? `${message} (line ${line})` : message);
    this.name = "OcmParseError";
  }
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Parse a CCSDS OCM in KVN serialization. */
export function parseOcm(raw: string): Ocm {
  if (!raw.includes("CCSDS_OCM_VERS")) {
    throw new OcmParseError("not a CCSDS OCM file (missing CCSDS_OCM_VERS)");
  }

  const lines = raw.split(/\r?\n/);

  const ocm: Ocm = {
    version: "",
    creationDate: "",
    originator: "",
    messageId: "",
    objectName: "",
    objectDesignator: "",
    noradId: null,
    operator: "",
    timeSystem: "UTC",
    epochTzero: "",
    startTime: "",
    stopTime: "",
    trajectoryFrame: "",
    trajectoryType: "CARTPV",
    trajectoryUnits: "[km,km,km,km/s,km/s,km/s]",
    covarianceFrame: null,
    covarianceOrdering: "LTM",
    trajectory: [],
    covariance: [],
    maneuvers: [],
  };

  type Section = "none" | "meta" | "traj" | "cov" | "man";
  let section: Section = "none";
  let currentMan: Partial<OcmManeuver> | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("COMMENT")) continue;

    switch (line) {
      case "META_START":
        section = "meta";
        continue;
      case "META_STOP":
        section = "none";
        continue;
      case "TRAJ_START":
        section = "traj";
        continue;
      case "TRAJ_STOP":
        section = "none";
        continue;
      case "COV_START":
        section = "cov";
        continue;
      case "COV_STOP":
        section = "none";
        continue;
      case "MAN_START":
        section = "man";
        currentMan = {};
        continue;
      case "MAN_STOP":
        if (currentMan?.startMs !== undefined && currentMan.durationSec !== undefined) {
          ocm.maneuvers.push(currentMan as OcmManeuver);
        }
        currentMan = null;
        section = "none";
        continue;
      default:
        break;
    }

    // ---- data lines -----------------------------------------------------
    if (section === "traj" && ISO_RE.test(line.split(/\s+/)[0] ?? "")) {
      const parts = line.split(/\s+/);
      if (parts.length < 7) {
        throw new OcmParseError("trajectory line needs 7 fields", i + 1);
      }
      const ms = Date.parse(parts[0]);
      const n = parts.slice(1, 7).map(Number);
      if (Number.isNaN(ms) || n.some((v) => !Number.isFinite(v))) {
        throw new OcmParseError("malformed trajectory line", i + 1);
      }
      ocm.trajectory.push({
        ms,
        position: [n[0], n[1], n[2]],
        velocity: [n[3], n[4], n[5]],
      });
      continue;
    }

    if (section === "cov" && ISO_RE.test(line.split(/\s+/)[0] ?? "")) {
      const parts = line.split(/\s+/);
      const ms = Date.parse(parts[0]);
      const values = parts.slice(1).map(Number);
      if (Number.isNaN(ms) || values.length < 21) {
        throw new OcmParseError("malformed covariance line", i + 1);
      }
      ocm.covariance.push({
        ms,
        matrix: lowerTriangleTo6x6(values.slice(0, 21)),
      });
      continue;
    }

    if (section === "man" && currentMan) {
      // A maneuver data line starts with an absolute ISO timestamp.
      if (ISO_RE.test(line.split(/\s+/)[0] ?? "")) {
        const parts = line.split(/\s+/);
        const ms = Date.parse(parts[0]);
        // MAN_COMPOSITION: TIME_ABSOLUTE, MAN_DURA, ACC_X, ACC_Y, ACC_Z.
        const dur = Number(parts[1]);
        const acc = [Number(parts[2] ?? 0), Number(parts[3] ?? 0), Number(parts[4] ?? 0)];
        if (
          Number.isNaN(ms) ||
          !Number.isFinite(dur) ||
          acc.some((v) => !Number.isFinite(v))
        ) {
          throw new OcmParseError("malformed maneuver line", i + 1);
        }
        currentMan.startMs = ms;
        currentMan.durationSec = dur;
        // The file declares NTW order; expose it as documented.
        currentMan.acceleration = [acc[0], acc[1], acc[2]];
        continue;
      }
      // Otherwise it is a MAN_* keyword.
      const kv = parseKeyValue(line);
      if (!kv) continue;
      const [key, value] = kv;
      switch (key) {
        case "MAN_ID":
          currentMan.id = Number(value);
          break;
        case "MAN_BASIS":
          currentMan.basis = value;
          break;
        case "MAN_REF_FRAME":
          currentMan.referenceFrame = value;
          break;
        case "MAN_DEVICE_ID":
          currentMan.deviceId = value;
          break;
        case "DC_TYPE":
          currentMan.dutyCycleType = value;
          break;
        default:
          break;
      }
      continue;
    }

    // ---- key/value lines -------------------------------------------------
    const kv = parseKeyValue(line);
    if (!kv) continue;
    const [key, value] = kv;

    switch (key) {
      case "CCSDS_OCM_VERS":
        ocm.version = value;
        break;
      case "CREATION_DATE":
        ocm.creationDate = value;
        break;
      case "ORIGINATOR":
        ocm.originator = value;
        break;
      case "MESSAGE_ID":
        ocm.messageId = value;
        break;
      case "OBJECT_NAME":
        ocm.objectName = value;
        break;
      case "OBJECT_DESIGNATOR":
        ocm.objectDesignator = value;
        break;
      case "OPERATOR":
        ocm.operator = value;
        break;
      case "TIME_SYSTEM":
        ocm.timeSystem = value;
        break;
      case "EPOCH_TZERO":
        ocm.epochTzero = value;
        break;
      case "START_TIME":
        ocm.startTime = value;
        break;
      case "STOP_TIME":
        ocm.stopTime = value;
        break;
      case "TRAJ_REF_FRAME":
        ocm.trajectoryFrame = value;
        break;
      case "TRAJ_TYPE":
        ocm.trajectoryType = value;
        break;
      case "TRAJ_UNITS":
        ocm.trajectoryUnits = value;
        break;
      case "COV_REF_FRAME":
        ocm.covarianceFrame = value;
        break;
      case "COV_ORDERING":
        ocm.covarianceOrdering = value;
        break;
      default:
        break;
    }
  }

  if (ocm.trajectory.length === 0) {
    throw new OcmParseError("OCM contains no trajectory state vectors");
  }
  if (!ocm.trajectoryFrame) {
    throw new OcmParseError("OCM is missing TRAJ_REF_FRAME");
  }
  if (ocm.timeSystem.toUpperCase() !== "UTC") {
    throw new OcmParseError(`unsupported TIME_SYSTEM ${ocm.timeSystem}`);
  }

  ocm.trajectory.sort((a, b) => a.ms - b.ms);
  ocm.covariance.sort((a, b) => a.ms - b.ms);

  // Catalogue number: only plain decimal designators are usable as a NORAD id.
  // Alpha-5 values (`A1193`) are valid catalogue ids too, but they are rare
  // enough that mapping them here would need the same decoder `tle.ts` uses;
  // until then a non-numeric designator is honestly reported as unknown.
  const designator = ocm.objectDesignator.trim();
  if (/^\d{1,6}$/.test(designator)) {
    const n = Number.parseInt(designator, 10);
    if (n > 0 && n <= 339_999) ocm.noradId = n;
  }

  return ocm;
}

function parseKeyValue(line: string): [string, string] | null {
  const eq = line.indexOf("=");
  if (eq === -1) return null;
  const key = line.slice(0, eq).trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) return null;
  return [key, line.slice(eq + 1).trim()];
}

/**
 * Merge trajectory states with the nearest covariance epoch.
 *
 * OCM keeps the covariance in a separate section. The vendor's own files carry
 * one matrix per trajectory epoch, but pairing by exact timestamp is fragile, so
 * we snap each state to the closest covariance epoch within a tolerance.
 */
export function mergeOcmCovariance(
  ocm: Ocm,
  toleranceMs = 1_000,
): { ms: number; position: [number, number, number]; velocity: [number, number, number]; covariance: number[] | null }[] {
  if (ocm.covariance.length === 0) {
    return ocm.trajectory.map((p) => ({ ...p, covariance: null }));
  }

  return ocm.trajectory.map((p) => {
    // Binary search for the nearest covariance epoch.
    const cov = ocm.covariance;
    let lo = 0;
    let hi = cov.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cov[mid].ms <= p.ms) lo = mid;
      else hi = mid;
    }
    const best =
      Math.abs(cov[lo].ms - p.ms) <= Math.abs(cov[hi].ms - p.ms) ? cov[lo] : cov[hi];
    const within = Math.abs(best.ms - p.ms) <= toleranceMs;
    return { ...p, covariance: within ? best.matrix : null };
  });
}

/** Human summary of a maneuver, for logs and the UI. */
export function describeManeuver(m: OcmManeuver): string {
  const accMs2 = m.acceleration.map((a) => a * 1000); // km/s^2 -> m/s^2
  const dv = m.acceleration.map((a) => Math.abs(a) * m.durationSec * 1000); // m/s
  return [
    `#${m.id}`,
    new Date(m.startMs).toISOString(),
    `${m.durationSec.toFixed(1)}s`,
    `acc=[${accMs2.map((v) => v.toExponential(2)).join(", ")}] m/s²`,
    `|Δv|≈${Math.hypot(...dv).toFixed(3)} m/s`,
  ].join("  ");
}

export { formatDoyTimestamp };
