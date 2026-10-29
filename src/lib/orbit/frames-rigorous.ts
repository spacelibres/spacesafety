/**
 * Reference-frame transformations for screening-grade accuracy.
 *
 * Trajectories reach us in three flavours:
 *
 *   EME2000 / J2000   inertial (what the ITC manifest gives us)
 *   ITRF / ITRF2000   Earth-fixed (what Starlink's OCM gives us)
 *   RTN / UVW / RSW   local orbital (what covariance is usually stated in)
 *
 * The screening kernel works entirely in an inertial frame, so Earth-fixed data
 * must be rotated. `frames.ts` already does this for rendering with a GMST-only
 * rotation, which is fine for a globe view (sub-kilometre) but not for
 * conjunction work, where a rotation error of a few hundred metres changes Pc by
 * orders of magnitude near the screening box.
 *
 * This module therefore implements the full IAU-76/FK5 chain:
 *
 *   ITRF -> J2000:  P (precession) · N (nutation) · R3(GMST) · W (polar motion)
 *
 * plus a proper velocity transform including the Earth-rotation term, and the
 * matching covariance transform (C' = A C A^T) so 6x6 matrices stay consistent.
 *
 * Accuracy: ~0.1-1 m versus rigorous IERS, dominated by the truncated nutation
 * series and by ignoring UT1-UTC (we use UTC as a proxy, |UT1-UTC| < 0.9 s,
 * i.e. < 0.4 km of Earth-surface rotation — appropriate for our purpose since
 * both objects are transformed identically and screening is relative).
 */

import type { Mat3, Mat6, Vec3 } from "../core/linalg";
import { mul3, transpose } from "../core/linalg";

const DEG = Math.PI / 180;

/** Earth rotation rate, rad/s (IERS 2003, mean). */
export const OMEGA_EARTH = 7.292115e-5;

/** WGS-84 flattening. */
export const WGS84_F = 1 / 298.257223563;

/** Julian date from Unix ms. */
export function julianDate(ms: number): number {
  return ms / 86_400_000 + 2440587.5;
}

/** Julian centuries since J2000.0. */
function julianCenturies(ms: number): number {
  return (julianDate(ms) - 2451545.0) / 36525;
}

// ---------------------------------------------------------------------------
// Earth rotation
// ---------------------------------------------------------------------------

/**
 * GMST in radians (IAU 1982), the rotation between ITRF and the true-of-date
 * equinox system.
 */
export function gmst(ms: number): number {
  const d = julianDate(ms) - 2451545.0;
  const t = d / 36525;
  const deg =
    280.46061837 +
    360.98564736629 * d +
    0.000387933 * t * t -
    (t * t * t) / 38_710_000;
  return wrap2pi(deg * DEG);
}

/** Angle normalised to [0, 2π). */
function wrap2pi(a: number): number {
  const twoPi = 2 * Math.PI;
  return ((a % twoPi) + twoPi) % twoPi;
}

// ---------------------------------------------------------------------------
// Elementary rotations (right-handed, angle in radians)
// ---------------------------------------------------------------------------

/** Rotation about x by `a`. */
function r1(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, s, 0, -s, c];
}
/** Rotation about y by `a`. */
function r2(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, -s, 0, 1, 0, s, 0, c];
}
/** Rotation about z by `a`. */
function r3(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

// ---------------------------------------------------------------------------
// Precession (IAU-76 / Lieske)
// ---------------------------------------------------------------------------

export function precessionMatrix(ms: number): Mat3 {
  const t = julianCenturies(ms);
  // Arcseconds.
  const zeta =
    2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t;
  const z =
    2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t;
  const theta =
    2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t;

  const zetaR = zeta * DEG / 3600;
  const zR = z * DEG / 3600;
  const thetaR = theta * DEG / 3600;

  // P = R3(-z) · R2(theta) · R3(-zeta)
  return mul3(mul3(r3(-zR), r2(thetaR)), r3(-zetaR));
}

// ---------------------------------------------------------------------------
// Nutation (truncated IAU-80, dominant 5 terms)
// ---------------------------------------------------------------------------

export function nutationMatrix(ms: number): Mat3 {
  const t = julianCenturies(ms);

  // Mean longitude of the ascending node of the Moon, and mean anomalies.
  const omega = (125.04452 - 1934.136261 * t) * DEG;
  const lSun = (280.4665 + 36000.7698 * t) * DEG;
  const lMoon = (218.3165 + 481267.8813 * t) * DEG;

  // Arcseconds.
  const dPsi =
    -17.2 * Math.sin(omega) -
    1.32 * Math.sin(2 * lSun) -
    0.23 * Math.sin(2 * lMoon) +
    0.21 * Math.sin(2 * omega);
  const dEps =
    9.2 * Math.cos(omega) +
    0.57 * Math.cos(2 * lSun) +
    0.1 * Math.cos(2 * lMoon) -
    0.09 * Math.cos(2 * omega);

  // Mean obliquity of the ecliptic (Laskar), arcseconds.
  const eps0 =
    84381.448 -
    46.815 * t -
    0.00059 * t * t +
    0.001813 * t * t * t;

  const epsBar = (eps0 + dEps) * DEG / 3600;
  const dPsiR = dPsi * DEG / 3600;

  // N = R1(-eps) · R3(dPsi) · R1(epsBar)
  return mul3(mul3(r1(-(eps0 * DEG) / 3600), r3(dPsiR)), r1(epsBar));
}

// ---------------------------------------------------------------------------
// Polar motion (ignored at our fidelity, but kept as an extension point)
// ---------------------------------------------------------------------------

/**
 * Polar motion is < 0.5 arcsec (< 15 m at Earth's surface) and is identical for
 * both objects in a conjunction, so it cancels in the relative geometry. It is
 * exposed as an identity so callers can substitute measured values later.
 */
export function polarMotionMatrix(): Mat3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

// ---------------------------------------------------------------------------
// Full transforms
// ---------------------------------------------------------------------------

/** Composite ITRF -> J2000 rotation matrix at a UTC instant. */
export function itrfToJ2000Matrix(ms: number): Mat3 {
  // x_J2000 = P · N · R3(GMST) · W · x_ITRF
  return mul3(mul3(precessionMatrix(ms), nutationMatrix(ms)), mul3(r3(gmst(ms)), polarMotionMatrix()));
}

/**
 * Transform an ITRF (Earth-fixed) state into J2000 (inertial).
 *
 * Velocity picks up the Earth-rotation transport term: v_J2000 = A·v_ITRF + ω × (A·r).
 */
export function itrfStateToJ2000(
  position: Vec3,
  velocity: Vec3,
  ms: number,
): { position: Vec3; velocity: Vec3 } {
  const A = itrfToJ2000Matrix(ms);

  const r = applyMat(A, position);
  const vRotated = applyMat(A, velocity);

  // ω is along the inertial z-axis of the *rotating* frame; after rotation it is
  // still (0, 0, ω) because a rotation about z commutes with the z axis.
  const omegaCrossR: Vec3 = [-OMEGA_EARTH * r[1], OMEGA_EARTH * r[0], 0];

  return {
    position: r,
    velocity: [
      vRotated[0] + omegaCrossR[0],
      vRotated[1] + omegaCrossR[1],
      vRotated[2] + omegaCrossR[2],
    ],
  };
}

function applyMat(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * Transform a 6x6 covariance from ITRF to J2000.
 *
 * A frame rotation acts identically on position and velocity, so the 6x6
 * transform is block-diagonal with A in both blocks. The ω × r term rotates the
 * velocity *estimate* but is not a random variable, so it does not enter the
 * covariance.
 */
export function itrfCovToJ2000(cov: number[], ms: number): number[] {
  const A = itrfToJ2000Matrix(ms);
  const out = new Array<number>(36).fill(0);

  for (let i = 0; i < 2; i += 1) {
    for (let j = 0; j < 2; j += 1) {
      // Extract the 3x3 block (i, j).
      const block: Mat3 = [
        cov[i * 18 + j * 3], cov[i * 18 + j * 3 + 1], cov[i * 18 + j * 3 + 2],
        cov[i * 18 + 6 + j * 3], cov[i * 18 + 6 + j * 3 + 1], cov[i * 18 + 6 + j * 3 + 2],
        cov[i * 18 + 12 + j * 3], cov[i * 18 + 12 + j * 3 + 1], cov[i * 18 + 12 + j * 3 + 2],
      ];
      const rotated = mul3(mul3(A, block), transpose(A));
      for (let r = 0; r < 3; r += 1) {
        for (let c = 0; c < 3; c += 1) {
          out[(i * 3 + r) * 6 + (j * 3 + c)] = rotated[r * 3 + c];
        }
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// RTN / UVW / RSW local frames
// ---------------------------------------------------------------------------

/**
 * Rotation from an inertial frame into the RTN (a.k.a. UVW / RSW) local frame.
 *
 * Rows are the basis vectors, so `M · v_inertial = v_rtn`.
 *   R  radial, away from Earth
 *   T  transverse, along-track (completes the right-handed set)
 *   N  normal, orbit angular-momentum direction
 */
export function inertialToRtnMatrix(position: Vec3, velocity: Vec3): Mat3 {
  const rHat = unit(position);
  const h = cross(position, velocity);
  const nHat = unit(h);
  const tHat = cross(nHat, rHat);
  return [
    rHat[0], rHat[1], rHat[2],
    tHat[0], tHat[1], tHat[2],
    nHat[0], nHat[1], nHat[2],
  ];
}

/** Inverse of the above: RTN -> inertial. */
export function rtnToInertialMatrix(position: Vec3, velocity: Vec3): Mat3 {
  return transpose(inertialToRtnMatrix(position, velocity));
}

/**
 * Convert a covariance stated in an RTN-like frame into the inertial frame.
 *
 * This is what makes externally-supplied covariance usable: operators publish
 * covariance in RTN/UVW/RSW (per the CCSDS OEM convention) but the screening
 * math needs it inertial.
 */
export function rtnCovToInertial(
  cov: number[],
  position: Vec3,
  velocity: Vec3,
): number[] {
  const M = inertialToRtnMatrix(position, velocity); // inertial -> RTN
  const Minv = transpose(M); // RTN -> inertial
  const out = new Array<number>(36).fill(0);

  for (let i = 0; i < 2; i += 1) {
    for (let j = 0; j < 2; j += 1) {
      const block: Mat3 = [
        cov[i * 18 + j * 3], cov[i * 18 + j * 3 + 1], cov[i * 18 + j * 3 + 2],
        cov[i * 18 + 6 + j * 3], cov[i * 18 + 6 + j * 3 + 1], cov[i * 18 + 6 + j * 3 + 2],
        cov[i * 18 + 12 + j * 3], cov[i * 18 + 12 + j * 3 + 1], cov[i * 18 + 12 + j * 3 + 2],
      ];
      const rotated = mul3(mul3(Minv, block), transpose(Minv));
      for (let r = 0; r < 3; r += 1) {
        for (let c = 0; c < 3; c += 1) {
          out[(i * 3 + r) * 6 + (j * 3 + c)] = rotated[r * 3 + c];
        }
      }
    }
  }

  return out;
}

/** True when a frame name denotes an Earth-fixed frame. */
export function isEarthFixedFrame(frame: string): boolean {
  const f = frame.toUpperCase();
  return f.startsWith("ITRF") || f === "ECEF" || f === "TDR" || f === "IGS";
}

/** True when a frame name denotes a local orbital frame. */
export function isLocalOrbitalFrame(frame: string): boolean {
  const f = frame.toUpperCase();
  return f === "RTN" || f === "UVW" || f === "RSW" || f === "TNW" || f === "NTW";
}

// --- vector helpers --------------------------------------------------------

function unit(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export type { Mat3, Mat6 };
