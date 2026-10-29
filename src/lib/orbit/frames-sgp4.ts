/**
 * TEME → EME2000 rotation.
 *
 * SGP4 outputs TEME: True Equator, Mean Equinox. The screening kernel works in
 * EME2000 (J2000). Leaving SGP4 states in TEME and feeding them to the kernel
 * mixes frames silently, with an error of up to ~20 km — comparable to the
 * screening box itself, so it cannot be left to chance.
 *
 * ## What actually separates the two frames
 *
 * TEME and J2000 share the same z-axis convention at the epoch but differ in the
 * location of the equinox:
 *
 *   - **Precession** of the Earth's equator and equinox since J2000.
 *   - **Nutation** — TEME uses the *mean* equinox, so the equation of the
 *     equinoxes (Δψ cos ε) is what distinguishes it, not the full nutation in
 *     longitude.
 *
 * The resulting rotation is small (arcseconds to arcminutes depending on the
 * year) but grows secularly. For a satellite at 6800 km, one arcminute is ~2 km.
 *
 * ## Method
 *
 * Build the rotation as a sequence of standard matrices using the IAU-76/FK5
 * precession-nutation model already implemented for ITRF↔J2000, then take the
 * product that maps TEME into J2000. Using the same coefficient sets as
 * `frames-rigorous.ts` keeps the two conversions consistent — a state that goes
 * ITRF→J2000 and a TLE that goes TEME→J2000 must agree on where the equator and
 * equinox are.
 *
 * The full derivation is in Vallado, *Fundamentals of Astrodynamics*, §3.5 and
 * the appendix on `teme2eci`. This module implements the same rotation as an
 * explicit matrix so it can be applied to both position and velocity.
 */

/** Julian date from Unix milliseconds. */
function julianDate(ms: number): number {
  return ms / 86_400_000 + 2440587.5;
}

/** Julian centuries since J2000.0. */
function centuriesSinceJ2000(jd: number): number {
  return (jd - 2451545.0) / 36525.0;
}

const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;

/**
 * IAU-76 precession angles (arcseconds) and their rates, for date `T` centuries
 * past J2000. These match the FK5 precession constants used in the ITRF chain.
 */
function precession(T: number): { zeta: number; z: number; theta: number } {
  return {
    zeta:
      2306.2181 * T +
      0.30188 * T * T +
      0.017998 * T * T * T,
    z:
      2306.2181 * T +
      1.09468 * T * T +
      0.018203 * T * T * T,
    theta:
      2004.3109 * T -
      0.42665 * T * T -
      0.041833 * T * T * T,
  };
}

/**
 * IAU-1980 nutation in longitude and obliquity, **radians**.
 *
 * Only the leading terms are kept (the 18.6-year and half-month periods). The
 * sum of the remaining terms is under 2 arcseconds, which is ~60 m at LEO — below
 * the tolerance this conversion exists to enforce, and well under the TLE's own
 * accuracy.
 *
 * The coefficients are given in arcseconds (that is how the IAU-1980 series is
 * tabulated) and converted here, so callers get radians and do not have to know.
 * Mixing the two silently produced a matrix that was off by degrees.
 */
function nutation(T: number): { dpsi: number; deps: number } {
  const omega = (125.04452 - 1934.136261 * T) * DEG;
  const L = (280.4665 + 36000.7698 * T) * DEG; // mean longitude of the Sun
  const Lm = (218.3165 + 481267.8813 * T) * DEG; // mean longitude of the Moon

  const dpsiArcsec =
    -17.2 * Math.sin(omega) -
    1.32 * Math.sin(2 * L) -
    0.23 * Math.sin(2 * Lm) +
    0.21 * Math.sin(2 * omega);

  const depsArcsec =
    9.2 * Math.cos(omega) +
    0.57 * Math.cos(2 * L) +
    0.1 * Math.cos(2 * Lm) -
    0.09 * Math.cos(2 * omega);

  return { dpsi: dpsiArcsec * ARCSEC, deps: depsArcsec * ARCSEC };
}

/** Mean obliquity of the ecliptic, arcseconds (IAU-76). */
function meanObliquity(T: number): number {
  return (84381.448 - 46.815 * T - 0.00059 * T * T + 0.001813 * T * T * T) * ARCSEC;
}

type Mat3 = [number, number, number, number, number, number, number, number, number];

function rotZ(angle: number): Mat3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

function rotX(angle: number): Mat3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

function mul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      let s = 0;
      for (let k = 0; k < 3; k += 1) s += a[i * 3 + k] * b[k * 3 + j];
      out[i * 3 + j] = s;
    }
  }
  return out as Mat3;
}

function apply(m: Mat3, v: readonly [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Cache: the rotation changes slowly and is rebuilt per call otherwise. */
let cached: { key: number; rotation: Mat3 } | null = null;

/**
 * TEME → J2000 rotation matrix at `ms`.
 *
 * Derivation: J2000 → TEME applies precession to the date, then the equation of
 * the equinoxes about the *true* pole. Inverting the composition gives the matrix
 * returned here.
 */
export function temeToEme2000Matrix(ms: number): Mat3 {
  // Quantise to a minute: the matrix changes by microarcseconds over that span,
  // and caching avoids rebuilding it for every sample in a track.
  const key = Math.floor(ms / 60_000);
  if (cached && cached.key === key) return cached.rotation;

  const T = centuriesSinceJ2000(julianDate(ms));
  const { zeta, z, theta } = precession(T);
  const { dpsi, deps } = nutation(T);
  const eps0 = meanObliquity(T);

  // Equation of the equinoxes: the mean-equinox correction TEME omits.
  const eqeq = dpsi * Math.cos(eps0) + deps * Math.sin(eps0);

  // J2000 → TEME = Rz(eqeq inverted) · Rz(-z) · Rx(theta) · Rz(-zeta)
  // TEME → J2000 is the transpose product.
  const p = mul(mul(rotZ(-z * ARCSEC), rotX(theta * ARCSEC)), rotZ(-zeta * ARCSEC));
  const pTranspose: Mat3 = [p[0], p[3], p[6], p[1], p[4], p[7], p[2], p[5], p[8]];
  const rotation = mul(rotZ(eqeq), pTranspose);

  cached = { key, rotation };
  return rotation;
}

/**
 * Rotate a TEME state into EME2000.
 *
 * Velocity is rotated with the same matrix: over the seconds a TLE state covers,
 * the rotation rate contributes well under a metre per second, and including it
 * would imply a precision the TLE does not have.
 */
export function temeToEme2000(
  position: readonly [number, number, number],
  velocity: readonly [number, number, number],
  ms: number,
): { position: [number, number, number]; velocity: [number, number, number] } | null {
  if (!Number.isFinite(ms)) return null;
  const m = temeToEme2000Matrix(ms);
  const p = apply(m, position);
  const v = apply(m, velocity);
  if (![...p, ...v].every(Number.isFinite)) return null;
  return { position: p, velocity: v };
}

/** Angle between the TEME and J2000 equinoxes at `ms`, arcseconds. */
export function frameOffsetArcsec(ms: number): number {
  const T = centuriesSinceJ2000(julianDate(ms));
  const { dpsi, deps } = nutation(T);
  const eps0 = meanObliquity(T);
  // `nutation` already returns radians.
  const eqeq = dpsi * Math.cos(eps0) + deps * Math.sin(eps0);
  return Math.abs(eqeq) / ARCSEC;
}
