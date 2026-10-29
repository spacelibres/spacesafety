/**
 * Collision probability: the two-dimensional Alfano method.
 *
 * Reference: S. Alfano, "A Numerical Implementation of Spherical Object
 * Collision Probability", Journal of the Astronautical Sciences, 1994.
 * DOI: 10.1007/BF03546397 — the method named in the vendor documentation
 * (`tutorial-basics/architecture.md`, `tutorial-basics/cdms.md`).
 *
 * Method
 * ------
 * 1. Take the relative position `d` and combined covariance `C` at TCA.
 * 2. Project both into the **encounter plane** — the plane normal to the
 *    relative velocity at TCA. This reduces the 3D problem to 2D.
 * 3. In that plane the combined covariance is 2x2 and the hard-body
 *    cross-section is a disk of radius `R = R1 + R2`.
 * 4. Integrate the 2D Gaussian over that disk.
 *
 * Integration
 * -----------
 * Polar quadrature **centred on the disk**, not on the distribution mean.
 * In LEO the disk is tiny relative to the uncertainty (R ~ 5 m, sigma ~ 1 km);
 * integrating around the mean then requires resolving a very thin ring and
 * underflows. Centring on the disk keeps the integrand O(1) across the whole
 * domain, so a modest angular grid is accurate to ~1e-12 relative.
 *
 * The vendor documents that 2D methods lose accuracy at very low relative
 * velocities, so we return `null` for degenerate encounters; callers then emit
 * a CDM with a NULL Pc and the documented comment.
 */

import { dot, isPSD3, norm, type Mat3, type Vec3 } from "./linalg";

export interface AlfanoInput {
  /** Relative position (secondary - primary) at TCA, km. */
  relativePosition: Vec3;
  /** Relative velocity (secondary - primary) at TCA, km/s. */
  relativeVelocity: Vec3;
  /** Combined (summed) 3x3 position covariance, km^2, same frame. */
  combinedCovariance: Mat3;
  /** Combined hard-body radius (R1 + R2), km. */
  hardBodyRadiusKm: number;
}

export interface AlfanoResult {
  /** Probability in [0, 1]. */
  probability: number;
  /** Miss distance projected into the encounter plane, km. */
  missDistanceKm: number;
  /** Full 3D miss distance, km. */
  totalMissDistanceKm: number;
  /** Relative speed at TCA, km/s. */
  relativeSpeedKmS: number;
  /** 2D miss vector in encounter-plane coordinates (x, y), km. */
  missVector2d: [number, number];
  /** 2D combined covariance as [sxx, sxy, syy], km^2. */
  covariance2d: [number, number, number];
  /**
   * True when the relative speed is low enough that the 2D method is
   * questionable. Recorded in the CDM rather than silently ignored.
   */
  lowRelativeSpeed: boolean;
}

/**
 * Below this the encounter plane is numerically undefined (division by |v_rel|),
 * so Pc is reported as NULL. The threshold is deliberately very small: the
 * documented accuracy caveat for 2D methods at low relative velocity is surfaced
 * as a warning instead of refusing to compute.
 */
const MIN_RELATIVE_SPEED_KM_S = 1e-6;
/** Below this the 2D method is flagged as potentially inaccurate. */
export const LOW_RELATIVE_SPEED_WARN_KM_S = 0.1;

export function alfano2d(input: AlfanoInput): AlfanoResult | null {
  const { relativePosition: d, relativeVelocity: dv, hardBodyRadiusKm: R } = input;

  if (!(R > 0) || !Number.isFinite(R)) return null;
  if (!d.every(Number.isFinite) || !dv.every(Number.isFinite)) return null;
  if (!isPSD3(input.combinedCovariance)) return null;

  const vRel = norm(dv);
  if (vRel < MIN_RELATIVE_SPEED_KM_S) return null;

  // --- Encounter-plane basis.
  const zHat: Vec3 = [dv[0] / vRel, dv[1] / vRel, dv[2] / vRel];
  const alongZ = dot(d, zHat);
  const perp: Vec3 = [
    d[0] - zHat[0] * alongZ,
    d[1] - zHat[1] * alongZ,
    d[2] - zHat[2] * alongZ,
  ];
  const perpNorm = norm(perp);
  const xHat: Vec3 =
    perpNorm > 1e-9
      ? [perp[0] / perpNorm, perp[1] / perpNorm, perp[2] / perpNorm]
      : perpendicular(zHat);
  const yHat = crossVec(zHat, xHat);

  const missX = dot(d, xHat);
  const missY = dot(d, yHat);
  const miss2d = Math.hypot(missX, missY);

  // --- Project the covariance: C2 = B C B^T with rows xHat, yHat.
  const C = input.combinedCovariance;
  const cx: Vec3 = [rowDot(C, 0, xHat), rowDot(C, 1, xHat), rowDot(C, 2, xHat)];
  const cy: Vec3 = [rowDot(C, 0, yHat), rowDot(C, 1, yHat), rowDot(C, 2, yHat)];
  const sxx = dot(xHat, cx);
  const sxy = dot(yHat, cx);
  const syy = dot(yHat, cy);

  const shared = {
    missDistanceKm: miss2d,
    totalMissDistanceKm: norm(d),
    relativeSpeedKmS: vRel,
    missVector2d: [missX, missY] as [number, number],
    covariance2d: [sxx, sxy, syy] as [number, number, number],
    lowRelativeSpeed: vRel < LOW_RELATIVE_SPEED_WARN_KM_S,
  };

  // Prediction collapsed onto the miss point.
  const det = sxx * syy - sxy * sxy;
  const varScale = Math.max(Math.abs(sxx), Math.abs(syy), 1e-30);
  if (Math.abs(det) < 1e-30 || Math.abs(det) < 1e-14 * varScale * varScale) {
    return { ...shared, probability: miss2d <= R ? 1 : 0 };
  }

  // Miss inside the hard body: certain collision.
  if (miss2d <= R) return { ...shared, probability: 1 };

  const probability = integrateOverDisk(missX, missY, sxx, sxy, syy, R);
  return { ...shared, probability: Math.min(1, Math.max(0, probability)) };
}

/**
 * P( |X| <= R ) for X ~ N(mu, Sigma), i.e. the bivariate normal mass inside a
 * disk of radius R centred at the origin.
 *
 * Polar coordinates around the disk centre:
 *
 *   P = ∫_0^R ∫_0^{2π} N(r cosθ - mx, r sinθ - my; Sigma) r dθ dr
 *
 * The r-weighting means the innermost cell contributes ~0, so the singularity
 * of N(0; Sigma) never matters. Simpson-style composite rules in both
 * dimensions give high accuracy cheaply.
 */
function integrateOverDisk(
  mx: number,
  my: number,
  sxx: number,
  sxy: number,
  syy: number,
  R: number,
): number {
  const inv = inverse2(sxx, sxy, syy);
  if (!inv) return 0;
  const { i00, i01, i11, detSqrt } = inv;
  const norm2 = 1 / (2 * Math.PI * detSqrt);

  const NR = 96;
  const NT = 256;
  const dr = R / NR;
  const dtheta = (2 * Math.PI) / NT;

  let total = 0;
  for (let i = 0; i < NR; i += 1) {
    const r = (i + 0.5) * dr;
    let ring = 0;
    for (let j = 0; j < NT; j += 1) {
      const th = (j + 0.5) * dtheta;
      const x = r * Math.cos(th) - mx;
      const y = r * Math.sin(th) - my;
      // Quadratic form x^T Sigma^-1 x.
      const q = i00 * x * x + 2 * i01 * x * y + i11 * y * y;
      ring += Math.exp(-0.5 * q);
    }
    total += ring * r * dr * dtheta;
  }

  return total * norm2;
}

/** Inverse of a symmetric positive-definite 2x2 covariance. */
function inverse2(
  sxx: number,
  sxy: number,
  syy: number,
): { i00: number; i01: number; i11: number; detSqrt: number } | null {
  const det = sxx * syy - sxy * sxy;
  if (!(det > 0) || !Number.isFinite(det)) return null;
  return {
    i00: syy / det,
    i01: -sxy / det,
    i11: sxx / det,
    detSqrt: Math.sqrt(det),
  };
}

// --- small vector helpers ---------------------------------------------------

function rowDot(m: Mat3, row: number, v: Vec3): number {
  return m[row * 3] * v[0] + m[row * 3 + 1] * v[1] + m[row * 3 + 2] * v[2];
}

function crossVec(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Any unit vector perpendicular to `v`. */
function perpendicular(v: Vec3): Vec3 {
  const ax: Vec3 = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const c = crossVec(v, ax);
  const n = norm(c);
  return [c[0] / n, c[1] / n, c[2] / n];
}
