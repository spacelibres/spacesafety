/**
 * Orbit propagation.
 *
 * The vendor documents that their screening propagates the ephemeris the
 * operator supplies; they do not specify the model. We use a J2-perturbed
 * two-body propagation (RK4 fixed-step), which is the standard fidelity for
 * LEO conjunction screening between ephemeris-stated states:
 *
 * - Error over a 1-3 day horizon is dominated by atmospheric drag, not by
 *   neglecting higher-order gravity terms, so J2 captures most of the secular
 *   drift (nodal regression, argument-of-perigee drift).
 * - Screening only needs *local* geometry near the TCA, where both trajectories
 *   are interpolated from their own states, so propagation error cancels.
 *
 * Trajectories are never extrapolated beyond their own span: conjunctions are
 * only reported inside the overlap of both spans.
 */

import { add, dot, norm, scale, sub, type Mat6, type Vec3 } from "./linalg";

export const MU_EARTH = 398600.4418; // km^3/s^2
export const RE_EARTH = 6378.137; // km (WGS-84 equatorial)
export const J2 = 1.08262668e-3;

/** State vector in km / km/s. */
export interface State {
  /** Seconds since the trajectory's epoch. */
  t: number;
  /** Position in km (inertial). */
  r: Vec3;
  /** Velocity in km/s (inertial). */
  v: Vec3;
}

/** J2-perturbed acceleration. */
export function acceleration(r: Vec3): Vec3 {
  const rMag = norm(r);
  const r2 = rMag * rMag;
  const k = MU_EARTH / (rMag * r2); // two-body term coefficient
  const ax2 = (-MU_EARTH * r[0]) / (rMag ** 3);
  const ay2 = (-MU_EARTH * r[1]) / (rMag ** 3);
  const az2 = (-MU_EARTH * r[2]) / (rMag ** 3);

  const z2 = r[2] * r[2];
  const f = (1.5 * J2 * MU_EARTH * RE_EARTH * RE_EARTH) / (rMag ** 5);
  const zFactor = (5 * z2) / r2;

  return [
    ax2 + f * r[0] * (zFactor - 1),
    ay2 + f * r[1] * (zFactor - 1),
    az2 + f * r[2] * (zFactor - 3),
  ];
  void k;
}

/** One RK4 step of duration `dt` seconds. */
export function rk4Step(state: State, dt: number): State {
  const { r, v } = state;

  const a1 = acceleration(r);
  const k1r = v;
  const k1v = a1;

  const r2 = add(r, scale(k1r, dt / 2));
  const v2 = add(v, scale(k1v, dt / 2));
  const k2r = v2;
  const k2v = acceleration(r2);

  const r3 = add(r, scale(k2r, dt / 2));
  const v3 = add(v, scale(k2v, dt / 2));
  const k3r = v3;
  const k3v = acceleration(r3);

  const r4 = add(r, scale(k3r, dt));
  const v4 = add(v, scale(k3v, dt));
  const k4r = v4;
  const k4v = acceleration(r4);

  return {
    t: state.t + dt,
    r: [
      r[0] + (dt / 6) * (k1r[0] + 2 * k2r[0] + 2 * k3r[0] + k4r[0]),
      r[1] + (dt / 6) * (k1r[1] + 2 * k2r[1] + 2 * k3r[1] + k4r[1]),
      r[2] + (dt / 6) * (k1r[2] + 2 * k2r[2] + 2 * k3r[2] + k4r[2]),
    ],
    v: [
      v[0] + (dt / 6) * (k1v[0] + 2 * k2v[0] + 2 * k3v[0] + k4v[0]),
      v[1] + (dt / 6) * (k1v[1] + 2 * k2v[1] + 2 * k3v[1] + k4v[1]),
      v[2] + (dt / 6) * (k1v[2] + 2 * k2v[2] + 2 * k3v[2] + k4v[2]),
    ],
  };
}

/** Propagate a state by `seconds`, choosing a stable internal step. */
export function propagate(state: State, seconds: number, stepSec = 30): State {
  if (seconds === 0) return state;
  const sign = Math.sign(seconds);
  let remaining = Math.abs(seconds);
  let current = state;
  while (remaining > 1e-9) {
    const dt = Math.min(stepSec, remaining) * sign;
    current = rk4Step(current, dt);
    remaining -= Math.abs(dt);
    // Guard against numerical blow-up (state below the surface).
    if (!Number.isFinite(norm(current.r)) || norm(current.r) < RE_EARTH * 0.9) {
      break;
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Covariance propagation
// ---------------------------------------------------------------------------

/**
 * State-transition matrix via finite differences.
 *
 * Φ(t0 -> t) maps a 6x6 state deviation forward. We approximate it numerically
 * with central differences on position and velocity, then propagate the
 * covariance as C(t) = Φ C0 Φ^T. This is the same linearised approach used in
 * most operational screenings; it is cheap and accurate enough while the
 * uncertainty stays small relative to the orbit.
 */
export function stateTransitionMatrix(
  state: State,
  seconds: number,
  eps = 1e-4,
): number[][] {
  const n = 6;
  const phi: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const base = propagate(state, seconds);

  for (let col = 0; col < n; col += 1) {
    const delta = new Array<number>(6).fill(0);
    delta[col] = eps;

    const plus: State = {
      t: state.t,
      r: [state.r[0] + delta[0], state.r[1] + delta[1], state.r[2] + delta[2]],
      v: [state.v[0] + delta[3], state.v[1] + delta[4], state.v[2] + delta[5]],
    };
    const minus: State = {
      t: state.t,
      r: [state.r[0] - delta[0], state.r[1] - delta[1], state.r[2] - delta[2]],
      v: [state.v[0] - delta[3], state.v[1] - delta[4], state.v[2] - delta[5]],
    };

    const fp = propagate(plus, seconds);
    const fm = propagate(minus, seconds);

    const d = [
      (fp.r[0] - fm.r[0]) / (2 * eps),
      (fp.r[1] - fm.r[1]) / (2 * eps),
      (fp.r[2] - fm.r[2]) / (2 * eps),
      (fp.v[0] - fm.v[0]) / (2 * eps),
      (fp.v[1] - fm.v[1]) / (2 * eps),
      (fp.v[2] - fm.v[2]) / (2 * eps),
    ];
    for (let row = 0; row < n; row += 1) phi[row][col] = d[row];
  }

  void base;
  return phi;
}

/** Propagate a 6x6 covariance: C(t) = Φ C0 Φ^T. */
export function propagateCovariance(
  cov: Mat6,
  state: State,
  seconds: number,
): Mat6 {
  if (seconds === 0) return cov.slice();
  const phi = stateTransitionMatrix(state, seconds);
  const n = 6;

  // tmp = Φ C
  const tmp: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      let s = 0;
      for (let k = 0; k < n; k += 1) s += phi[i][k] * cov[k * n + j];
      tmp[i][j] = s;
    }
  }

  // out = tmp Φ^T
  const out = new Array<number>(n * n).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      let s = 0;
      for (let k = 0; k < n; k += 1) s += tmp[i][k] * phi[j][k];
      out[i * n + j] = s;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keplerian conversion (for display and range checks)
// ---------------------------------------------------------------------------

export interface Keplerian {
  /** km */
  a: number;
  /** 0..1 */
  e: number;
  /** radians */
  i: number;
  /** radians */
  raan: number;
  /** radians */
  argp: number;
  /** radians */
  trueAnomaly: number;
  /** minutes */
  periodMin: number;
  /** km */
  altitudeKm: number;
}

export function toKeplerian(r: Vec3, v: Vec3): Keplerian {
  const rMag = norm(r);
  const vMag = norm(v);
  const h = [
    r[1] * v[2] - r[2] * v[1],
    r[2] * v[0] - r[0] * v[2],
    r[0] * v[1] - r[1] * v[0],
  ] as Vec3;
  const hMag = norm(h);

  // Eccentricity vector.
  const vxh = [
    v[1] * h[2] - v[2] * h[1],
    v[2] * h[0] - v[0] * h[2],
    v[0] * h[1] - v[1] * h[0],
  ] as Vec3;
  const eVec = sub(scale(vxh, 1 / MU_EARTH), scale(r, 1 / rMag));
  const e = norm(eVec);

  const energy = (vMag * vMag) / 2 - MU_EARTH / rMag;
  const a = -MU_EARTH / (2 * energy);

  const i = Math.acos(Math.min(1, Math.max(-1, h[2] / hMag)));

  const nVec: Vec3 = [-h[1], h[0], 0];
  const nMag = norm(nVec);
  let raan = nMag > 1e-12 ? Math.acos(Math.min(1, Math.max(-1, nVec[0] / nMag))) : 0;
  if (nVec[1] < 0) raan = 2 * Math.PI - raan;

  let argp = 0;
  if (nMag > 1e-12 && e > 1e-12) {
    argp = Math.acos(
      Math.min(1, Math.max(-1, dot(nVec, eVec) / (nMag * e))),
    );
    if (eVec[2] < 0) argp = 2 * Math.PI - argp;
  }

  let trueAnomaly = 0;
  if (e > 1e-12) {
    trueAnomaly = Math.acos(
      Math.min(1, Math.max(-1, dot(eVec, r) / (e * rMag))),
    );
    if (dot(r, v) < 0) trueAnomaly = 2 * Math.PI - trueAnomaly;
  }

  return {
    a,
    e,
    i,
    raan,
    argp,
    trueAnomaly,
    periodMin: (2 * Math.PI * Math.sqrt(a ** 3 / MU_EARTH)) / 60,
    altitudeKm: a * (1 - e) - RE_EARTH,
  };
}

export const deg = (rad: number) => (rad * 180) / Math.PI;
export const rad = (deg: number) => (deg * Math.PI) / 180;
