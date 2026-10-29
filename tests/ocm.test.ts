/**
 * Frame-transform and OCM tests.
 *
 * The key insight these tests encode: `|h|` is NOT invariant between ITRF and
 * ECI, because an ITRF "velocity" is a derivative in the rotating frame. The
 * physically meaningful checks are therefore:
 *
 *   1. the rotation matrix is orthonormal (M M^T = I, det = 1),
 *   2. the resulting orbit is physically plausible (dynamically consistent),
 *   3. semi-major axis is stable across a whole real 7-day arc,
 *   4. covariance trace is preserved by the (orthonormal) rotation.
 */

import { readFileSync, existsSync } from "node:fs";

import { elementsFromState } from "../src/lib/core/kinematics";
import { det3, mul3, posCov6, transpose, type Mat3 } from "../src/lib/core/linalg";
import {
  gmst,
  itrfCovToJ2000,
  itrfStateToJ2000,
  itrfToJ2000Matrix,
  nutationMatrix,
  precessionMatrix,
  rtnCovToInertial,
  inertialToRtnMatrix,
} from "../src/lib/orbit/frames-rigorous";
import { mergeOcmCovariance, parseOcm, type Ocm } from "../src/lib/orbit/ocm";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
  }
}

const EPS = 1e-9;

function orthonormalityError(m: Mat3): number {
  const mmt = mul3(m, transpose(m));
  let worst = 0;
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const expected = i === j ? 1 : 0;
      worst = Math.max(worst, Math.abs(mmt[i * 3 + j] - expected));
    }
  }
  return worst;
}

console.log("\nFrames — rotation matrices are orthonormal");
{
  const ms = Date.parse("2026-10-26T08:45:42Z");
  check("precession matrix", orthonormalityError(precessionMatrix(ms)) < EPS);
  check("nutation matrix", orthonormalityError(nutationMatrix(ms)) < EPS);
  const a = itrfToJ2000Matrix(ms);
  check("ITRF->J2000 composite", orthonormalityError(a) < EPS);
  check("determinant is +1 (no reflection)", Math.abs(det3(a) - 1) < EPS);
}

console.log("\nFrames — Earth rotation rate");
{
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const g0 = gmst(t0);
  const g1 = gmst(t0 + 86_400_000);
  // One *solar* day of GMST advance is 2π + 2π/365.25 (the sidereal minus solar
  // discrepancy), i.e. ~0.0172 rad. A sidereal day would give exactly 2π.
  const expected = (2 * Math.PI) / 365.2422;
  const delta = g1 - g0;
  check(
    "GMST advances one sidereal turn plus the sidereal/solar offset per solar day",
    Math.abs(delta - expected) < 1e-4,
    `Δ=${delta.toFixed(6)} rad, expected≈${expected.toFixed(6)}`,
  );
  check("GMST in [0, 2π)", g0 >= 0 && g0 < 2 * Math.PI);
}

console.log("\nFrames — covariance handling");
{
  const pos = [7000, 0, 0] as [number, number, number];
  const vel = [0, 7.5, 0] as [number, number, number];
  const M = inertialToRtnMatrix(pos, vel);
  check("RTN basis is orthonormal", orthonormalityError(M) < EPS);
  check(
    "R axis points along position",
    Math.abs(M[0] - 1) < EPS && Math.abs(M[3]) < EPS,
  );

  // Trace is preserved by an orthonormal rotation.
  const cov = new Array<number>(36).fill(0);
  cov[0] = 1;
  cov[7] = 4;
  cov[14] = 9;
  const rotated = rtnCovToInertial(cov, pos, vel);
  const trace = posCov6(rotated).reduce((acc, v, i) => (i === 0 || i === 4 || i === 8 ? acc + v : acc), 0);
  check("RTN->inertial preserves covariance trace", Math.abs(trace - 14) < 1e-9, `tr=${trace.toFixed(9)}`);
}

console.log("\nOCM — real 7-day Starlink ephemeris");
const OCM_PATH = process.env.SPACE_EYES_OCM_SAMPLE ?? "/tmp/ocm.txt";
if (!existsSync(OCM_PATH)) {
  console.log(`  skip: no sample at ${OCM_PATH}`);
} else {
  const ocm: Ocm = parseOcm(readFileSync(OCM_PATH, "utf8"));

  check("object identified", ocm.objectName === "STARLINK-35000", ocm.objectName);
  check("operator is SPACEX", ocm.operator === "SPACEX");
  check("frame is ITRF2000", ocm.trajectoryFrame === "ITRF2000", ocm.trajectoryFrame);
  check("covariance frame is ITRF2000", ocm.covarianceFrame === "ITRF2000");
  check("cartesian PV trajectory", ocm.trajectoryType === "CARTPV");
  check("7-day horizon", ocm.trajectory.length > 10_000, `n=${ocm.trajectory.length}`);
  check("covariance for every epoch", ocm.covariance.length === ocm.trajectory.length);
  check("maneuver plan parsed", ocm.maneuvers.length === 2, `n=${ocm.maneuvers.length}`);

  const m0 = ocm.maneuvers[0];
  check(
    "maneuver basis and frame",
    m0.basis === "PLANNED" && m0.referenceFrame === "NTW_ROTATING",
    `${m0.basis}/${m0.referenceFrame}`,
  );
  check(
    "maneuver has duration and acceleration",
    m0.durationSec > 100 && m0.acceleration.some((a) => Math.abs(a) > 0),
    `${m0.durationSec.toFixed(1)}s`,
  );

  const merged = mergeOcmCovariance(ocm);
  check("all states paired with covariance", merged.every((s) => s.covariance !== null));

  // --- the substantive check: transform the whole arc and confirm the orbit
  // is dynamically consistent (stable SMA, sane inclination).
  let minA = Infinity;
  let maxA = -Infinity;
  let minI = Infinity;
  let maxI = -Infinity;
  let traceErr = 0;

  for (const s of merged) {
    const eci = itrfStateToJ2000(s.position, s.velocity, s.ms);
    const el = elementsFromState(eci.position, eci.velocity);
    minA = Math.min(minA, el.smaAltitudeKm);
    maxA = Math.max(maxA, el.smaAltitudeKm);
    minI = Math.min(minI, el.inclinationDeg);
    maxI = Math.max(maxI, el.inclinationDeg);

    if (s.covariance) {
      const before = s.covariance[0] + s.covariance[7] + s.covariance[14];
      const after = itrfCovToJ2000(s.covariance, s.ms);
      const afterTrace = after[0] + after[7] + after[14];
      traceErr = Math.max(traceErr, Math.abs(before - afterTrace) / Math.abs(before));
    }
  }

  check(
    "semi-major axis stable across 7 days",
    maxA - minA < 40,
    `${minA.toFixed(1)}..${maxA.toFixed(1)} km (spread ${(maxA - minA).toFixed(1)})`,
  );
  check(
    "inclination physically stable",
    maxI - minI < 1.0,
    `${minI.toFixed(2)}..${maxI.toFixed(2)}°`,
  );
  check(
    "altitude plausible for LEO",
    minA > 300 && maxA < 700,
    `${minA.toFixed(0)}..${maxA.toFixed(0)} km`,
  );
  check(
    "ITRF->J2000 preserves covariance trace",
    traceErr < 1e-9,
    `max rel err=${traceErr.toExponential(2)}`,
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
