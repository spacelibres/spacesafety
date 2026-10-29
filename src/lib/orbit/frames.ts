/**
 * Earth-orientation helpers for 3D rendering.
 *
 * Trajectories arrive in ITRF (Earth-fixed). Rendering in an Earth-fixed frame
 * makes every satellite's ground track collapse to a dot, so we rotate ITRF/ECEF
 * into an inertial frame (ECI, essentially GCRF at the fidelity we need) using
 * Greenwich Mean Sidereal Time.
 *
 * Accuracy is ~arcsecond-level from the GMST polynomial below — far beyond what
 * a viewer needs, and enough that co-located TCA pairs render on top of each
 * other instead of a few hundred metres apart.
 */

import {
  interpolateState,
  type Oem,
  type OemState,
  WGS84_EQUATORIAL_RADIUS_KM,
} from "./oem";

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/**
 * Greenwich Mean Sidereal Time in radians (IAU 1982 model).
 *
 * @param date UTC instant
 */
export function gmstRadians(date: Date): number {
  // Julian Date from Unix ms.
  const jd = date.getTime() / 86_400_000 + 2440587.5;
  const d = jd - 2451545.0; // days since J2000.0
  const gmstDeg =
    280.46061837 +
    360.98564736629 * d +
    0.000387933 * (d / 36525) ** 2 -
    (d / 36525) ** 3 / 38710000;
  return ((gmstDeg * DEG) % TWO_PI + TWO_PI) % TWO_PI;
}

export type Vec3 = [number, number, number];

/** Rotate a position/velocity from ECEF (ITRF) to ECI at the given instant. */
export function ecefToEci(
  position: Vec3,
  velocity: Vec3,
  date: Date,
): { position: Vec3; velocity: Vec3 } {
  const theta = gmstRadians(date);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  // Earth rotation rate, rad/s.
  const omega = 7.2921150e-5;

  const x = c * position[0] - s * position[1];
  const y = s * position[0] + c * position[1];
  const z = position[2];

  // Velocity also picks up the frame rotation term omega x r.
  const vx = c * velocity[0] - s * velocity[1] + omega * y;
  const vy = s * velocity[0] + c * velocity[1] - omega * x;
  const vz = velocity[2];

  return { position: [x, y, z], velocity: [vx, vy, vz] };
}

/** Convert one OEM state into ECI, honouring its declared reference frame. */
export function stateToEci(state: OemState, refFrame: string): OemState {
  const frame = refFrame.toUpperCase();
  if (frame.startsWith("EME2000") || frame === "J2000" || frame === "GCRF") {
    return state; // Already inertial.
  }
  // ITRF, ITRF2000, ITRF93, ECEF ... all Earth-fixed.
  const { position, velocity } = ecefToEci(
    state.position,
    state.velocity,
    new Date(state.tMs),
  );
  return { ...state, position, velocity };
}

/** Project a full trajectory into ECI points suitable for a THREE.Line. */
export function toEciPolyline(oem: Oem): { tMs: number; point: Vec3 }[] {
  return oem.states.map((s) => {
    const eci = stateToEci(s, oem.refFrame);
    return { tMs: s.tMs, point: eci.position };
  });
}

/** Unit vector from ECI km coordinates, scaled by the scene's globe radius. */
export function toSceneUnits(
  km: Vec3,
  globeRadius: number,
): Vec3 {
  const scale = globeRadius / WGS84_EQUATORIAL_RADIUS_KM;
  return [km[0] * scale, km[1] * scale, km[2] * scale];
}

/**
 * Sample a trajectory at a fixed cadence. Interpolating a uniform grid keeps
 * the GPU buffer small while still animating smoothly.
 */
export function samplePositions(
  oem: Oem,
  count: number,
): { tMs: number; position: Vec3 }[] {
  const first = oem.states[0].tMs;
  const last = oem.states[oem.states.length - 1].tMs;
  const span = last - first;
  const out: { tMs: number; position: Vec3 }[] = [];

  for (let i = 0; i < count; i += 1) {
    const tMs = first + (span * i) / Math.max(1, count - 1);
    const s = interpolateState(oem, tMs);
    if (!s) continue;
    const eci = stateToEci(
      { time: "", tMs, position: s.position, velocity: s.velocity },
      oem.refFrame,
    );
    out.push({ tMs, position: eci.position });
  }
  return out;
}

/**
 * Scene-space snapshot of two objects at one instant, used for TCA close-approach
 * views.
 */
export function relativeGeometry(
  a: Oem,
  b: Oem,
  tMs: number,
): { a: Vec3; b: Vec3; separationKm: number } | null {
  const sa = interpolateState(a, tMs);
  const sb = interpolateState(b, tMs);
  if (!sa || !sb) return null;

  const pa = stateToEci(
    { time: "", tMs, position: sa.position, velocity: sa.velocity },
    a.refFrame,
  ).position;
  const pb = stateToEci(
    { time: "", tMs, position: sb.position, velocity: sb.velocity },
    b.refFrame,
  ).position;

  const dx = pa[0] - pb[0];
  const dy = pa[1] - pb[1];
  const dz = pa[2] - pb[2];
  return { a: pa, b: pb, separationKm: Math.hypot(dx, dy, dz) };
}
