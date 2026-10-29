/**
 * Orbit characteristics for display.
 *
 * Mirrors the "Mean Orbital Elements" panel in the official trajectory page
 * (`docs/UI-SPEC.md`): SMA altitude, inclination, eccentricity, RAAN,
 * argument of perigee and mean anomaly, all derivable from a single state.
 *
 * These are deliberately *osculating* elements from a Cartesian state, not the
 * "mean" elements the vendor derives by fitting across the whole arc. They are
 * what the UI needs, and they are exact for the state they are computed from.
 */

import type { ItcState } from "../orbit/itc";
import { toKeplerian, deg } from "./propagator";
import type { Vec3 } from "./linalg";

export interface OrbitalElements {
  /** Semi-major axis, km. */
  a: number;
  /** Semi-major axis altitude above the equator, km. */
  smaAltitudeKm: number;
  /** Eccentricity, 0..1. */
  e: number;
  /** Inclination, degrees. */
  inclinationDeg: number;
  /** Right ascension of the ascending node, degrees. */
  raanDeg: number;
  /** Argument of perigee, degrees. */
  argPerigeeDeg: number;
  /** Mean anomaly, degrees. */
  meanAnomalyDeg: number;
  /** Orbital period, minutes. */
  periodMin: number;
  /** Current altitude (not SMA) above the equator, km. */
  altitudeKm: number;
}

/** True anomaly -> mean anomaly via eccentric anomaly. */
function trueToMean(trueAnomaly: number, e: number): number {
  const E = 2 * Math.atan2(
    Math.sqrt(1 - e) * Math.sin(trueAnomaly / 2),
    Math.sqrt(1 + e) * Math.cos(trueAnomaly / 2),
  );
  return E - e * Math.sin(E);
}

const wrapDeg = (d: number) => ((d % 360) + 360) % 360;

/** Derive display elements from one state vector. */
export function elementsFromState(
  position: Vec3,
  velocity: Vec3,
): OrbitalElements {
  const k = toKeplerian(position, velocity);
  const meanTrue = trueToMean(k.trueAnomaly, k.e);
  const radius = Math.hypot(position[0], position[1], position[2]);

  return {
    a: k.a,
    smaAltitudeKm: k.a - 6378.137,
    e: k.e,
    inclinationDeg: deg(k.i),
    raanDeg: wrapDeg(deg(k.raan)),
    argPerigeeDeg: wrapDeg(deg(k.argp)),
    meanAnomalyDeg: wrapDeg(deg(meanTrue)),
    periodMin: k.periodMin,
    altitudeKm: radius - 6378.137,
  };
}

/** One-line summary, useful in logs and smoke tests. */
export function toKinematicSummary(state: ItcState): string {
  const el = elementsFromState(state.position, state.velocity);
  return [
    `alt=${el.altitudeKm.toFixed(1)}km`,
    `sma=${el.smaAltitudeKm.toFixed(1)}km`,
    `e=${el.e.toFixed(5)}`,
    `i=${el.inclinationDeg.toFixed(2)}deg`,
    `raan=${el.raanDeg.toFixed(2)}deg`,
    `T=${el.periodMin.toFixed(2)}min`,
  ].join(" ");
}

/** Elements for a whole trajectory, for the trend chart. */
export function elementsSeries(states: ItcState[]): OrbitalElements[] {
  return states.map((s) => elementsFromState(s.position, s.velocity));
}
