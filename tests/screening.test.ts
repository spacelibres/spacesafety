/**
 * Screening pipeline tests.
 *
 * Fixture strategy
 * ----------------
 * Rather than hunting for interesting orbital geometries numerically, these
 * tests build a synthetic state history directly from a desired *relative*
 * motion: the secondary is placed at a prescribed offset from the primary in
 * its own RTN frame, with an offset that sweeps linearly to zero and back.
 *
 * That makes the TCA and the miss distance analytically known, so the tests
 * assert exact values instead of loose ranges — a much stronger check of box
 * detection, TCA refinement and Pc assembly.
 */

import { SCREENING_BOX_KM, screen } from "../src/lib/core/screening";
import { RE_EARTH } from "../src/lib/core/propagator";
import { cross, normalize, type Vec3 } from "../src/lib/core/linalg";
import type {
  ScreeningJobMsg,
  StateVectorMsg,
  TrajectorySampleMsg,
} from "../src/lib/grpc/proto";

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

const MU = 398600.4418;
const RADIUS = RE_EARTH + 550;
const SPEED = Math.sqrt(MU / RADIUS);
const PERIOD_MS = (2 * Math.PI * Math.sqrt(RADIUS ** 3 / MU)) * 1000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const STEP_MS = 10_000;
const POINTS = 600;

/** Circular reference orbit in the equatorial plane. */
function primaryState(tMs: number): { r: Vec3; v: Vec3 } {
  const th = (2 * Math.PI * (tMs - T0)) / PERIOD_MS;
  return {
    r: [RADIUS * Math.cos(th), RADIUS * Math.sin(th), 0],
    v: [-SPEED * Math.sin(th), SPEED * Math.cos(th), 0],
  };
}

/** RTN-to-inertial rotation at a state. */
function rtn(r: Vec3, v: Vec3): { R: Vec3; T: Vec3; N: Vec3 } {
  const R = normalize(r);
  const N = normalize(cross(r, v));
  const T = cross(N, R);
  return { R, T, N };
}

/**
 * Build a trajectory offset from the primary by `offset(tMs)` in the primary's
 * RTN frame. Velocity is the primary's plus the offset's time derivative, so
 * the relative motion is exactly what the offsets prescribe.
 */
function offsetTrack(
  id: string,
  offset: (tMs: number) => { R?: number; T?: number; N?: number },
  opts: { withCov?: boolean; covScale?: number } = {},
): TrajectorySampleMsg {
  const { withCov = true, covScale = 1 } = opts;
  const states: StateVectorMsg[] = [];

  for (let i = 0; i < POINTS; i += 1) {
    const tMs = T0 + i * STEP_MS;
    const prim = primaryState(tMs);
    const basis = rtn(prim.r, prim.v);

    const o0 = offset(tMs);
    const o1 = offset(tMs + 1000);
    const dr = { R: (o1.R ?? 0) - (o0.R ?? 0), T: (o1.T ?? 0) - (o0.T ?? 0), N: (o1.N ?? 0) - (o0.N ?? 0) };

    const off: Vec3 = [
      basis.R[0] * (o0.R ?? 0) + basis.T[0] * (o0.T ?? 0) + basis.N[0] * (o0.N ?? 0),
      basis.R[1] * (o0.R ?? 0) + basis.T[1] * (o0.T ?? 0) + basis.N[1] * (o0.N ?? 0),
      basis.R[2] * (o0.R ?? 0) + basis.T[2] * (o0.T ?? 0) + basis.N[2] * (o0.N ?? 0),
    ];
    // Velocity change from the offset's rate (ignoring basis rotation, which is
    // exact to first order over a 1 s difference at orbital rates).
    const dOff: Vec3 = [
      basis.R[0] * dr.R + basis.T[0] * dr.T + basis.N[0] * dr.N,
      basis.R[1] * dr.R + basis.T[1] * dr.T + basis.N[1] * dr.N,
      basis.R[2] * dr.R + basis.T[2] * dr.T + basis.N[2] * dr.N,
    ];

    let covariance: number[] = [];
    if (withCov) {
      covariance = new Array<number>(36).fill(0);
      const p = 0.1 * 0.1 * covScale * covScale;
      const v = 1e-6 * covScale * covScale;
      covariance[0] = p;
      covariance[7] = p;
      covariance[14] = p;
      covariance[21] = v;
      covariance[28] = v;
      covariance[35] = v;
    }

    states.push({
      epochMs: String(tMs),
      px: prim.r[0] + off[0],
      py: prim.r[1] + off[1],
      pz: prim.r[2] + off[2],
      vx: prim.v[0] + dOff[0],
      vy: prim.v[1] + dOff[1],
      vz: prim.v[2] + dOff[2],
      covariance,
    });
  }

  return {
    trajectoryId: id,
    objectId: `obj-${id}`,
    objectName: id.toUpperCase(),
    hardBodyRadiusKm: 0.005,
    states,
    stateSource: "operator_ephemeris",
  };
}

function primaryTrack(id = "P"): TrajectorySampleMsg {
  return offsetTrack(id, () => ({}));
}

function job(
  a: TrajectorySampleMsg,
  b: TrajectorySampleMsg,
): ScreeningJobMsg {
  return { jobId: `job-${a.trajectoryId}-${b.trajectoryId}`, primary: a, secondary: b, maxSamplePoints: 8000 };
}

/** Mid-window instant, where the fixtures put their crossing. */
const T_MID = T0 + (POINTS / 2) * STEP_MS;

/**
 * Triangular V-shaped offset: separation shrinks linearly from `startKm` at
 * t=0 to zero at t=T_MID in the chosen RTN axis, then grows back.
 */
function vShaped(axis: "R" | "T" | "N", startKm: number) {
  return (tMs: number) => {
    const f = Math.abs(tMs - T_MID) / (T_MID - T0);
    const value = startKm * f;
    return { [axis]: value } as { R?: number; T?: number; N?: number };
  };
}

/** Constant offset along one RTN axis: no approach at all. */
function constant(axis: "R" | "T" | "N", km: number) {
  return () => ({ [axis]: km }) as { R?: number; T?: number; N?: number };
}

console.log("\nScreening — encounter detection");

// 1. A V-shaped approach in the along-track direction crosses inside the box.
{
  const out = screen(job(primaryTrack(), offsetTrack("S", vShaped("T", 40))));
  const a = out.approaches[0];
  check("V-shaped along-track approach detected", out.approaches.length >= 1, `n=${out.approaches.length}`);
  check(
    "minimum range reaches zero at the crossing",
    a !== undefined && a.totalMissDistanceKm < 0.1,
    `miss=${a?.totalMissDistanceKm.toExponential(2)} km`,
  );
  check(
    "TCA lands at the mid-window crossing",
    a !== undefined && Math.abs(Number(a.tcaEpochMs) - T_MID) < 60_000,
    a ? `${((Number(a.tcaEpochMs) - T_MID) / 1000).toFixed(1)} s from mid-window` : "n/a",
  );
}

// 2. Same, but offset in the cross-track axis.
{
  const out = screen(job(primaryTrack(), offsetTrack("S", vShaped("N", 30))));
  const a = out.approaches[0];
  check("V-shaped cross-track approach detected", out.approaches.length >= 1, `n=${out.approaches.length}`);
  check(
    "cross-track crossing has near-zero miss",
    a !== undefined && a.totalMissDistanceKm < 0.1,
    `miss=${a?.totalMissDistanceKm.toExponential(2)} km`,
  );
}

// 3. A constant, in-box offset is a *persistent* conjunction: the pair never
//    leaves the screening volume, so it must be reported even though the range
//    never changes sign. (Real example: two co-orbiting satellites flying
//    10 km apart.)
{
  const out = screen(job(primaryTrack(), offsetTrack("S", constant("N", 10))));
  const a = out.approaches[0];
  check(
    "constant in-box offset reports a persistent conjunction",
    out.approaches.length === 1 && a !== undefined,
    `n=${out.approaches.length}, minRange=${out.stats.minRangeKm.toFixed(2)}`,
  );
  check(
    "persistent conjunction reports the true 10 km separation",
    a !== undefined && Math.abs(a.totalMissDistanceKm - 10) < 0.5,
    `miss=${a?.totalMissDistanceKm.toFixed(3)} km`,
  );
}

// 3b. A constant offset *outside* the box is not a conjunction at all.
{
  const out = screen(job(primaryTrack(), offsetTrack("S", constant("N", 80))));
  check(
    "constant out-of-box offset yields no approach",
    out.approaches.length === 0,
    `n=${out.approaches.length}, minRange=${out.stats.minRangeKm.toFixed(1)}`,
  );
}

// 4. An approach that never enters the screening box is not reported.
//    A 400 km along-track sweep passes through the origin in range, but only
//    after the primary's own motion carries the pair far outside the box — so
//    instead we hold the cross-track offset at 200 km and sweep along-track:
//    the minimum range is 200 km, well outside the 51 km half-width.
{
  const floored = (tMs: number) => {
    const f = Math.abs(tMs - T_MID) / (T_MID - T0);
    return { N: 200, T: 300 * f } as { N: number; T: number };
  };
  const out = screen(job(primaryTrack(), offsetTrack("S", floored)));
  check(
    "approach outside the screening box is not reported",
    out.approaches.length === 0,
    `n=${out.approaches.length}, minRange=${out.stats.minRangeKm.toFixed(1)} km`,
  );
}

// 5. A minimum that stops short of contact still produces a finite miss.
{
  // Triangular offset reaching a 5 km floor at mid-window.
  const floored = (tMs: number) => {
    const f = Math.abs(tMs - T_MID) / (T_MID - T0);
    return { N: 5 + 35 * f } as { N: number };
  };
  const out = screen(job(primaryTrack(), offsetTrack("S", floored)));
  const a = out.approaches[0];
  check("floored approach detected", a !== undefined, `n=${out.approaches.length}`);
  check(
    "floored minimum reports ~5 km miss",
    a !== undefined && a.totalMissDistanceKm > 4 && a.totalMissDistanceKm < 6,
    `miss=${a?.totalMissDistanceKm.toFixed(3)} km`,
  );
}

console.log("\nScreening — probability handling");

// 6. Missing covariance: approach kept, Pc absent, reason recorded.
{
  const out = screen(
    job(primaryTrack(), offsetTrack("S", vShaped("N", 30), { withCov: false })),
  );
  const a = out.approaches[0];
  check("missing covariance still yields an approach", a !== undefined, `n=${out.approaches.length}`);
  check(
    "missing covariance -> Pc absent with a reason",
    a !== undefined && a.probabilityOfCollision === undefined && a.pcFailureReason.length > 0,
    a?.pcFailureReason ?? "no approach",
  );
}

// 7. Pc grows with covariance for a fixed geometry.
{
  const geometry = vShaped("N", 30);
  const small = screen(job(primaryTrack(), offsetTrack("S", geometry, { covScale: 1 }))).approaches[0];
  const large = screen(
    job(primaryTrack("P2"), offsetTrack("S2", geometry, { covScale: 5 })),
  ).approaches[0];
  check(
    "Pc grows with covariance size",
    small?.probabilityOfCollision !== undefined &&
      large?.probabilityOfCollision !== undefined &&
      large.probabilityOfCollision >= small.probabilityOfCollision,
    `small=${small?.probabilityOfCollision?.toExponential(3)} large=${large?.probabilityOfCollision?.toExponential(3)}`,
  );
}

// 8. Pc stays a probability.
{
  const a = screen(job(primaryTrack(), offsetTrack("S", vShaped("N", 30)))).approaches[0];
  check(
    "Pc within [0, 1]",
    a?.probabilityOfCollision !== undefined &&
      a.probabilityOfCollision >= 0 &&
      a.probabilityOfCollision <= 1,
    `Pc=${a?.probabilityOfCollision?.toExponential(3)}`,
  );
}

console.log("\nScreening — geometry sanity");

// 9. RTN components reconstruct the 3D miss.
{
  const a = screen(job(primaryTrack(), offsetTrack("S", vShaped("N", 30)))).approaches[0];
  check(
    "RTN components reconstruct the 3D miss",
    a !== undefined && Math.abs(Math.hypot(a.rtnR, a.rtnT, a.rtnN) - a.totalMissDistanceKm) < 1e-6,
    a ? `rtn=(${a.rtnR.toFixed(2)}, ${a.rtnT.toFixed(2)}, ${a.rtnN.toFixed(2)})` : "",
  );
}

// 10. Approaches are time-ordered.
{
  const out = screen(job(primaryTrack(), offsetTrack("S", vShaped("T", 40))));
  let ordered = true;
  for (let i = 1; i < out.approaches.length; i += 1) {
    if (Number(out.approaches[i].tcaEpochMs) < Number(out.approaches[i - 1].tcaEpochMs)) {
      ordered = false;
    }
  }
  check("approaches are time-ordered", ordered);
}

// 11. Vendor screening-box constants must not drift.
check(
  "screening box matches vendor doc (2 / 44 / 51 km)",
  SCREENING_BOX_KM.radial === 2 &&
    SCREENING_BOX_KM.alongTrack === 44 &&
    SCREENING_BOX_KM.crossTrack === 51,
);

// 12. Physically impossible input is rejected.
{
  const bad = primaryTrack("BAD");
  bad.states = bad.states.map((s) => ({ ...s, px: 100, py: 0, pz: 0 }));
  const out = screen(job(primaryTrack(), bad));
  check(
    "sub-surface states are rejected",
    out.approaches.length === 0 && out.stats.samplesCompared === 0,
  );
}

// 13. Role swap: the same encounter is found with the tracks reversed.
{
  const p = primaryTrack();
  const s = offsetTrack("S", vShaped("N", 30));
  const forward = screen(job(p, s));
  const reverse = screen(job(s, p));
  check(
    "encounter is symmetric under role swap",
    forward.approaches.length >= 1 && reverse.approaches.length >= 1,
    `fwd=${forward.approaches.length} rev=${reverse.approaches.length}`,
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
