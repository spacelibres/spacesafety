/**
 * Small linear-algebra kernel.
 *
 * Deliberately self-contained (no external numeric dependency): the screening
 * path must stay auditable, and every routine here feeds the Alfano probability
 * calculation, which is numerically sensitive.
 */

export type Vec3 = [number, number, number];
/** Row-major 3x3 matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];
/** Row-major 6x6 matrix; symmetric positive semi-definite in our use. */
export type Mat6 = number[];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.sqrt(dot(a, a));
export const normalize = (a: Vec3): Vec3 => {
  const n = norm(a);
  return n === 0 ? [0, 0, 0] : scale(a, 1 / n);
};

export const mat3Vec = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/**
 * RTN (radial / transverse / normal) basis for a state, as row vectors.
 *
 * - **R** is the unit position vector (radial, away from Earth).
 * - **N** is the orbit normal from the specific angular momentum h = r x v.
 * - **T** completes the right-handed set (along-track, in the orbital plane).
 *
 * Rows of the returned matrix map an inertial vector into RTN components, i.e.
 * `v_rtn = M * v_eci`.
 */
export function rtnBasis(position: Vec3, velocity: Vec3): Mat3 {
  const rHat = normalize(position);
  const h = cross(position, velocity);
  const nHat = normalize(h);
  const tHat = cross(nHat, rHat); // Right-handed: R x T = N
  return [
    rHat[0], rHat[1], rHat[2],
    tHat[0], tHat[1], tHat[2],
    nHat[0], nHat[1], nHat[2],
  ];
}

/** Rotate a 3x3 covariance into RTN: C_rtn = M C M^T. */
export function rotateCov3(cov: Mat3, basis: Mat3): Mat3 {
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      let s = 0;
      for (let k = 0; k < 3; k += 1) {
        for (let l = 0; l < 3; l += 1) {
          s += basis[i * 3 + k] * cov[k * 3 + l] * basis[j * 3 + l];
        }
      }
      out[i * 3 + j] = s;
    }
  }
  return out as Mat3;
}

/** Rotate a 6x6 covariance block-wise: S C S^T with S = diag(M, M). */
export function rotateCov6(cov6: Mat6, basis: Mat3): Mat6 {
  const block = (i: 0 | 1, j: 0 | 1): Mat3 => {
    const m = new Array<number>(9).fill(0);
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        m[r * 3 + c] = cov6[(i * 3 + r) * 6 + (j * 3 + c)];
      }
    }
    return m as Mat3;
  };

  const pp = rotateCov3(block(0, 0), basis);
  const pv = rotateCov3(block(0, 1), basis);
  const vp = rotateCov3(block(1, 0), basis);
  const vv = rotateCov3(block(1, 1), basis);

  const out = new Array<number>(36).fill(0);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 6 + c] = pp[r * 3 + c];
      out[r * 6 + (c + 3)] = pv[r * 3 + c];
      out[(r + 3) * 6 + c] = vp[r * 3 + c];
      out[(r + 3) * 6 + (c + 3)] = vv[r * 3 + c];
    }
  }
  return out;
}

/** Extract the 3x3 upper-left (position) block of a 6x6 covariance. */
export function posCov6(cov6: Mat6): Mat3 {
  return [
    cov6[0], cov6[1], cov6[2],
    cov6[6], cov6[7], cov6[8],
    cov6[12], cov6[13], cov6[14],
  ];
}

/** Build a full 6x6 covariance from explicit sub-blocks. */
export function buildCov6(posPos: Mat3, posVel: Mat3, velVel: Mat3): Mat6 {
  const m = new Array<number>(36).fill(0);
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      m[i * 6 + j] = posPos[i * 3 + j];
      m[i * 6 + (j + 3)] = posVel[i * 3 + j];
      m[(i + 3) * 6 + j] = posVel[j * 3 + i];
      m[(i + 3) * 6 + (j + 3)] = velVel[i * 3 + j];
    }
  }
  return m;
}

/** Expand a 3x3 position covariance into a 6x6 with zero velocity blocks. */
export function cov6FromPos(cov: Mat3): Mat6 {
  const m = new Array<number>(36).fill(0);
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      m[i * 6 + j] = cov[i * 3 + j];
    }
  }
  return m;
}

/** Multiply two 3x3 matrices. */
export function mul3(a: Mat3, b: Mat3): Mat3 {
  const o = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      let s = 0;
      for (let k = 0; k < 3; k += 1) s += a[i * 3 + k] * b[k * 3 + j];
      o[i * 3 + j] = s;
    }
  }
  return o as Mat3;
}

/**
 * Symmetric 3x3 eigen-decomposition via cyclical Jacobi rotations.
 *
 * Eigenvalues come back in ascending order with matching unit eigenvectors.
 */
export function symEigen3(m: Mat3): {
  values: [number, number, number];
  vectors: [Vec3, Vec3, Vec3];
} {
  const a = [
    [m[0], m[1], m[2]],
    [m[3], m[4], m[5]],
    [m[6], m[7], m[8]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let sweep = 0; sweep < 40; sweep += 1) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-18) break;

    for (let p = 0; p < 2; p += 1) {
      for (let q = p + 1; q < 3; q += 1) {
        if (Math.abs(a[p][q]) < 1e-20) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        const apq = a[p][q];
        a[p][p] -= t * apq;
        a[q][q] += t * apq;
        a[p][q] = 0;
        a[q][p] = 0;

        for (let k = 0; k < 3; k += 1) {
          if (k !== p && k !== q) {
            const akp = a[k][p];
            const akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[p][k] = a[k][p];
            a[k][q] = s * akp + c * akq;
            a[q][k] = a[k][q];
          }
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const idx = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  const pick = (i: number): Vec3 => [v[0][i], v[1][i], v[2][i]];
  return {
    values: [a[idx[0]][idx[0]], a[idx[1]][idx[1]], a[idx[2]][idx[2]]],
    vectors: [pick(idx[0]), pick(idx[1]), pick(idx[2])],
  };
}

export function det3(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

/** Invert a 3x3 matrix; null when singular. */
export function inv3(m: Mat3): Mat3 | null {
  const d = det3(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-30) return null;
  const invD = 1 / d;
  return [
    (m[4] * m[8] - m[5] * m[7]) * invD,
    (m[2] * m[7] - m[1] * m[8]) * invD,
    (m[1] * m[5] - m[2] * m[4]) * invD,
    (m[5] * m[6] - m[3] * m[8]) * invD,
    (m[0] * m[8] - m[2] * m[6]) * invD,
    (m[2] * m[3] - m[0] * m[5]) * invD,
    (m[3] * m[7] - m[4] * m[6]) * invD,
    (m[1] * m[6] - m[0] * m[7]) * invD,
    (m[0] * m[4] - m[1] * m[3]) * invD,
  ];
}

/** True when a symmetric 3x3 matrix is positive semi-definite. */
export function isPSD3(m: Mat3, tol = -1e-12): boolean {
  if (!m.every(Number.isFinite)) return false;
  const { values } = symEigen3(m);
  return values[0] >= tol;
}

export const identity3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const zero3: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
