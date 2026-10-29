/**
 * SGP4 propagation of TLEs.
 *
 * ## What SGP4 is, and is not
 *
 * SGP4 (Simplified General Perturbations 4) is the analytic propagator that
 * *defines* a TLE: the element set is fitted so that SGP4 reproduces the observed
 * orbit, and using any other model with those elements is not a re-derivation but
 * a different orbit. So TLE → state is not a choice; it is SGP4.
 *
 * It is not high precision. It carries a mean-element model with a low-order
 * gravity field, a crude drag term (B*), and no luni-solar perturbation, and it
 * degrades noticeably beyond a few days from epoch. For conjunction screening at
 * the 53 km box scale that is usually ample; for the sub-kilometre accuracy a real
 * CDM needs, an operator-supplied ephemeris (OCM/OEM) is required. That is why the
 * platform treats TLE as a *catalogue and NORAD-id* source and operator ephemerides
 * as the authoritative trajectory.
 *
 * ## Frames
 *
 * SGP4 emits TEME (True Equator, Mean Equinox). The screening kernel works in
 * EME2000 (J2000). They differ by precession and nutation — up to ~20 km in
 * position — so states are rotated here rather than silently mixed. See
 * `frames-sgp4.ts`.
 *
 * ## Library choice
 *
 * `satellite.js` is a direct port of Vallado's reference implementation, which is
 * the version Space-Track itself documents. Writing SGP4 by hand is possible but
 * the deep-space branch (SDP4) and the drag model have many edge cases, and a
 * subtle error is invisible — it produces plausible numbers. Using the reference
 * port and testing it against known states is the safer engineering choice.
 */

import * as satellite from "satellite.js";

import type { ItcState } from "./itc";
import { temeToEme2000 } from "./frames-sgp4";
import type { Tle } from "./tle";

/** One propagated sample. */
export interface TleState {
  /** Unix epoch milliseconds (UTC). */
  ms: number;
  /** km, EME2000. */
  position: [number, number, number];
  /** km/s, EME2000. */
  velocity: [number, number, number];
}

/** Why SGP4 could not produce a state. */
export type Sgp4Failure =
  | "decayed"
  | "not-converged"
  | "epoch-out-of-range"
  | "invalid-elements";

export interface Sgp4Result {
  states: TleState[];
  /** Samples that failed, with a reason, so callers can report rather than hide. */
  failures: Array<{ ms: number; reason: Sgp4Failure }>;
}

/**
 * How far past epoch SGP4 remains usable, hours.
 *
 * Beyond roughly this the drag term dominates the error and positions stop being
 * meaningful for screening. The caller can override, but the default refuses
 * rather than returning confident-looking garbage.
 */
export const SGP4_MAX_AGE_HOURS = 7 * 24;

/**
 * Build a `satrec` from a parsed TLE.
 *
 * Returns null when the elements are outside the model's valid domain, which
 * `satellite.js` reports through a non-zero `error` code rather than throwing.
 */
export function makeSatrec(tle: Tle): satellite.SatRec | null {
  const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
  if (!satrec || (satrec.error as number) !== 0) return null;
  return satrec;
}

/** Map a `satellite.js` error code to a reason. */
function failureReason(code: number): Sgp4Failure {
  switch (code) {
    case 1:
      // Mean eccentricity outside [0, 1): elements are inconsistent.
      return "invalid-elements";
    case 2:
      // Mean motion <= 0 after perturbation.
      return "invalid-elements";
    case 3:
      // Perturbed eccentricity out of range — typically a decayed object.
      return "decayed";
    case 4:
      // Semi-latus rectum < 1: the orbit intersects the Earth.
      return "decayed";
    case 6:
      // Satellite has decayed.
      return "decayed";
    default:
      return "not-converged";
  }
}

/**
 * Propagate a TLE over an evenly spaced window.
 *
 * `stepSeconds` defaults to 60 s, matching Starlink's public ephemeris cadence so
 * TLE-derived tracks drop straight into the same screening path.
 *
 * The window is anchored at `startMs` and inclusive at both ends; `spanHours`
 * determines how many samples. Samples that fail are recorded and skipped, which
 * is what a real catalogue needs — a decayed object should not abort a sweep.
 */
export function propagateTle(
  tle: Tle,
  opts: {
    startMs?: number;
    spanHours?: number;
    stepSeconds?: number;
    satrec?: satellite.SatRec;
  } = {},
): Sgp4Result {
  const satrec = opts.satrec ?? makeSatrec(tle);
  if (!satrec) {
    return {
      states: [],
      failures: [{ ms: opts.startMs ?? tle.epochMs, reason: "invalid-elements" }],
    };
  }

  const stepSeconds = opts.stepSeconds && opts.stepSeconds > 0 ? opts.stepSeconds : 60;
  const spanHours = opts.spanHours && opts.spanHours > 0 ? opts.spanHours : 24;
  const startMs = opts.startMs ?? tle.epochMs;
  const stepMs = stepSeconds * 1000;
  const steps = Math.floor((spanHours * 3_600_000) / stepMs);

  const states: TleState[] = [];
  const failures: Sgp4Result["failures"] = [];

  for (let i = 0; i <= steps; i += 1) {
    const ms = startMs + i * stepMs;
    const ageHours = Math.abs(ms - tle.epochMs) / 3_600_000;
    if (ageHours > SGP4_MAX_AGE_HOURS) {
      failures.push({ ms, reason: "epoch-out-of-range" });
      continue;
    }

    let pv: satellite.PositionAndVelocity | null = null;
    try {
      pv = satellite.propagate(satrec, new Date(ms));
    } catch {
      pv = null;
    }

    if (!pv || !pv.position || !pv.velocity) {
      failures.push({ ms, reason: "not-converged" });
      continue;
    }

    // `satrec.error` is set on the record by the propagator; a non-zero value
    // means the position is not trustworthy even though one was returned. The
    // library types it as a non-zero-only enum, so compare numerically.
    const code = satrec.error as number;
    if (code !== 0) {
      failures.push({ ms, reason: failureReason(code) });
      continue;
    }

    const teme = {
      position: [pv.position.x, pv.position.y, pv.position.z] as [number, number, number],
      velocity: [pv.velocity.x, pv.velocity.y, pv.velocity.z] as [number, number, number],
    };
    const eme = temeToEme2000(teme.position, teme.velocity, ms);

    if (!eme) {
      failures.push({ ms, reason: "not-converged" });
      continue;
    }

    states.push({ ms, position: eme.position, velocity: eme.velocity });
  }

  return { states, failures };
}

/** Convert SGP4 output into the kernel's state shape. SGP4 carries no covariance. */
export function toItcStates(result: Sgp4Result): ItcState[] {
  return result.states.map((s) => ({
    ms: s.ms,
    position: s.position,
    velocity: s.velocity,
    covariance: null,
  }));
}

/**
 * Osculating elements at epoch, from the TLE itself.
 *
 * Convenience for the UI: mean elements are what the TLE states, and for a
 * near-circular LEO they track the osculating values closely. Use
 * `elementsFromState` on a propagated state when exact osculating values matter.
 */
export function tleElements(tle: Tle): {
  altitudeKm: number;
  periodMin: number;
  apogeeKm: number;
  perigeeKm: number;
} {
  const MU = 398600.4418;
  const RE = 6378.137;
  const nRad = (tle.meanMotionRevPerDay * 2 * Math.PI) / 86_400;
  const a = Math.cbrt(MU / (nRad * nRad));
  const e = tle.eccentricity;
  return {
    altitudeKm: a - RE,
    periodMin: 1440 / tle.meanMotionRevPerDay,
    apogeeKm: a * (1 + e) - RE,
    perigeeKm: a * (1 - e) - RE,
  };
}
