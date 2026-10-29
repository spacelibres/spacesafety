/**
 * CCSDS OEM parsing and orbital geometry for 3D rendering.
 *
 * The vendor accepts several formats (OEM, OCM, Modified ITC, JSpOC, UTC, NASA),
 * but every trajectory they publish is OEM/ITRF — which is also the frame the
 * screening engine prefers. We implement OEM fully and fail loudly on anything
 * else rather than silently mis-rendering an orbit.
 *
 * Spec: CCSDS 502.0-B-3 §5 (KVN serialization).
 */

/** One state vector at one instant. Units: km and km/s. */
export interface OemState {
  /** ISO-8601 UTC timestamp exactly as it appeared in the file. */
  time: string;
  /** Milliseconds since Unix epoch, for cheap interpolation. */
  tMs: number;
  /** Position (km) in the file's reference frame. */
  position: [number, number, number];
  /** Velocity (km/s) in the file's reference frame. */
  velocity: [number, number, number];
}

export type OemReferenceFrame = "ITRF" | "EME2000" | string;

export interface Oem {
  version: string;
  creationDate?: string;
  originator?: string;
  objectName?: string;
  objectId?: string;
  centerName?: string;
  refFrame: OemReferenceFrame;
  timeSystem: string;
  startTime?: string;
  stopTime?: string;
  states: OemState[];
}

export class OemParseError extends Error {
  constructor(
    message: string,
    /** 1-based line number in the source file, when known. */
    readonly line?: number,
  ) {
    super(line ? `${message} (line ${line})` : message);
    this.name = "OemParseError";
  }
}

const DATA_LINE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s.*)?$/;

/**
 * Parse an OEM file (KVN). Covariance blocks are skipped: rendering only needs
 * position/velocity, and covariance semantics belong to the screening engine.
 */
export function parseOem(raw: string): Oem {
  if (!raw.includes("CCSDS_OEM_VERS")) {
    throw new OemParseError(
      "not a CCSDS OEM file (missing CCSDS_OEM_VERS header)",
    );
  }

  const lines = raw.split(/\r?\n/);
  const oem: Oem = {
    version: "",
    refFrame: "",
    timeSystem: "UTC",
    states: [],
  };
  let inCovariance = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("COMMENT")) continue;

    switch (line) {
      case "META_START":
      case "META_STOP":
        continue;
      case "COVARIANCE_START":
        inCovariance = true;
        continue;
      case "COVARIANCE_STOP":
        inCovariance = false;
        continue;
      default:
        break;
    }
    if (inCovariance) continue;

    const eq = line.indexOf("=");
    if (eq !== -1) {
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === "CCSDS_OEM_VERS") oem.version = value;
      else if (key === "CREATION_DATE") oem.creationDate = value;
      else if (key === "ORIGINATOR") oem.originator = value;
      else if (key === "OBJECT_NAME") oem.objectName = value;
      else if (key === "OBJECT_ID") oem.objectId = value;
      else if (key === "CENTER_NAME") oem.centerName = value;
      else if (key === "REF_FRAME") oem.refFrame = value;
      else if (key === "TIME_SYSTEM") oem.timeSystem = value;
      else if (key === "START_TIME") oem.startTime = value;
      else if (key === "STOP_TIME") oem.stopTime = value;
      continue;
    }

    const m = DATA_LINE.exec(line);
    if (!m) {
      throw new OemParseError(`unrecognised line: ${line.slice(0, 80)}`, i + 1);
    }

    const tMs = Date.parse(m[1]);
    if (Number.isNaN(tMs)) {
      throw new OemParseError(`invalid timestamp: ${m[1]}`, i + 1);
    }
    const nums = m.slice(2, 8).map(Number);
    if (nums.some((n) => !Number.isFinite(n))) {
      throw new OemParseError("non-numeric state vector component", i + 1);
    }

    oem.states.push({
      time: m[1],
      tMs,
      position: [nums[0], nums[1], nums[2]],
      velocity: [nums[3], nums[4], nums[5]],
    });
  }

  if (oem.states.length === 0) {
    throw new OemParseError("OEM contains no state vectors");
  }
  if (!oem.refFrame) {
    throw new OemParseError("OEM is missing REF_FRAME");
  }
  if (oem.timeSystem.toUpperCase() !== "UTC") {
    // The API itself only accepts UTC, so anything else is malformed.
    throw new OemParseError(`unsupported TIME_SYSTEM ${oem.timeSystem}`);
  }

  return oem;
}

/** Linearly interpolate position/velocity at an arbitrary instant. */
export function interpolateState(
  oem: Oem,
  tMs: number,
):
  | { position: [number, number, number]; velocity: [number, number, number] }
  | null {
  const { states } = oem;
  if (states.length === 0) return null;
  if (tMs <= states[0].tMs) {
    return { position: states[0].position, velocity: states[0].velocity };
  }
  const last = states[states.length - 1];
  if (tMs >= last.tMs) {
    return { position: last.position, velocity: last.velocity };
  }

  // Binary search for the bracketing pair.
  let lo = 0;
  let hi = states.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (states[mid].tMs <= tMs) lo = mid;
    else hi = mid;
  }

  const a = states[lo];
  const b = states[hi];
  const f = (tMs - a.tMs) / (b.tMs - a.tMs || 1);
  const lerp = (x: number, y: number) => x + (y - x) * f;

  return {
    position: [
      lerp(a.position[0], b.position[0]),
      lerp(a.position[1], b.position[1]),
      lerp(a.position[2], b.position[2]),
    ],
    velocity: [
      lerp(a.velocity[0], b.velocity[0]),
      lerp(a.velocity[1], b.velocity[1]),
      lerp(a.velocity[2], b.velocity[2]),
    ],
  };
}

const EARTH_MU = 398600.4418; // km^3/s^2
export const WGS84_EQUATORIAL_RADIUS_KM = 6378.137;

/** Rough orbital period from the radius, in minutes (frame-independent). */
export function orbitalPeriodMinutes(oem: Oem): number {
  const { states } = oem;
  if (states.length < 2) return 90;
  const r = Math.hypot(...states[0].position);
  return (2 * Math.PI * Math.sqrt(r ** 3 / EARTH_MU)) / 60;
}

/** Altitude in km above the WGS-84 equatorial radius. */
export function altitudeKm(oem: Oem): number {
  return Math.hypot(...oem.states[0].position) - WGS84_EQUATORIAL_RADIUS_KM;
}
