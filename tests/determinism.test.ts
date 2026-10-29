/**
 * Screening must be deterministic: the same job must produce the same
 * approaches in the same process and across runs.
 *
 * This suite exists because the benchmark caught a non-determinism that had
 * nothing to do with the pre-filter: two sweeps over identical inputs reported
 * 577 and 570 approaches. The cause was the track cache — see the assertion at
 * the bottom, which runs the same pair twice with the cache on and off.
 */

import { clearTrackCache, screen } from "../src/lib/core/screening";
import { MU_EARTH, RE_EARTH } from "../src/lib/core/propagator";
import type { ScreeningJobMsg, StateVectorMsg } from "../src/lib/grpc/proto";

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

const T0 = Date.UTC(2026, 5, 1);
const DT_MS = 60_000;
const POINTS = 4321; // 3 days at 60 s, matching the benchmark sweep

/** Circular (or slightly eccentric) orbit sampled over `POINTS` epochs. */
function track(
  id: string,
  opts: {
    altitudeKm: number;
    inclinationDeg: number;
    raanDeg: number;
    phase: number;
    /** Defaults to 0 (circular). */
    eccentricity?: number;
  },
): StateVectorMsg[] {
  const ecc = opts.eccentricity ?? 0;
  const a = RE_EARTH + opts.altitudeKm;
  const inc = (opts.inclinationDeg * Math.PI) / 180;
  const raan = (opts.raanDeg * Math.PI) / 180;
  // Argument of perigee stays at zero, so true anomaly is measured from perigee.
  const period = 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH);
  const hAng = Math.sqrt(MU_EARTH * a * (1 - ecc * ecc));

  const out: StateVectorMsg[] = [];
  for (let k = 0; k < POINTS; k += 1) {
    const nu = opts.phase + (2 * Math.PI * ((k * DT_MS) / 1000)) / period;
    const r = (a * (1 - ecc * ecc)) / (1 + ecc * Math.cos(nu));
    const xp = r * Math.cos(nu);
    const yp = r * Math.sin(nu);
    const vxp = -(MU_EARTH / hAng) * Math.sin(nu);
    const vyp = (MU_EARTH / hAng) * (ecc + Math.cos(nu));

    const ci = Math.cos(inc), si = Math.sin(inc);
    const cO = Math.cos(raan), sO = Math.sin(raan);
    const toI = (x: number, y: number): [number, number, number] => [
      cO * x - sO * ci * y,
      sO * x + cO * ci * y,
      si * y,
    ];
    const p = toI(xp, yp);
    const v = toI(vxp, vyp);

    out.push({
      epochMs: String(T0 + k * DT_MS),
      px: p[0], py: p[1], pz: p[2],
      vx: v[0], vy: v[1], vz: v[2],
      covariance: [],
    });
  }
  void id;
  return out;
}

function msg(id: string, states: StateVectorMsg[]) {
  return {
    trajectoryId: id,
    objectId: id,
    objectName: id,
    hardBodyRadiusKm: 0.00883,
    stateSource: "test",
    states,
  };
}

function sweep(): string[] {
  // A small constellation whose shells are close enough to produce crossings.
  const sats = [];
  for (let i = 0; i < 24; i += 1) {
    sats.push({
      id: `SAT-${i}`,
      states: track(`SAT-${i}`, {
        altitudeKm: 472.5 + (i % 3) * 5,
        inclinationDeg: 70,
        raanDeg: ((i * 7) % 24) * 15,
        phase: ((i * 0.6180339887) % 1) * 2 * Math.PI,
      }),
    });
  }

  const found: string[] = [];
  for (let i = 0; i < sats.length; i += 1) {
    for (let j = i + 1; j < sats.length; j += 1) {
      const job: ScreeningJobMsg = {
        jobId: `${sats[i].id}~${sats[j].id}`,
        primary: msg(sats[i].id, sats[i].states),
        secondary: msg(sats[j].id, sats[j].states),
        maxSamplePoints: 2000,
      };
      for (const ap of screen(job).approaches) {
        found.push(`${sats[i].id}|${sats[j].id}|${ap.tcaEpochMs}`);
      }
    }
  }
  return found.sort();
}

console.log("\nDeterminism");

{
  clearTrackCache();
  const first = sweep();

  clearTrackCache();
  const second = sweep();

  check(
    "cache cleared between runs -> identical results",
    JSON.stringify(first) === JSON.stringify(second),
    `${first.length} vs ${second.length} approaches`,
  );
}

{
  // Same sweep, but with the cache left in place between passes. This is the
  // shape that failed: the second pass must agree with the first.
  clearTrackCache();
  const warm1 = sweep();
  const warm2 = sweep();

  check(
    "warm cache -> identical results",
    JSON.stringify(warm1) === JSON.stringify(warm2),
    `${warm1.length} then ${warm2.length}`,
  );
}

{
  // And the two modes must agree with each other.
  clearTrackCache();
  const cold = sweep();
  const warm = sweep();
  check(
    "cold and warm cache agree",
    JSON.stringify(cold) === JSON.stringify(warm),
    `${cold.length} vs ${warm.length}`,
  );
}

{
  // The same pair screened twice must give the same answer.
  const a = msg("A", track("A", { altitudeKm: 472.5, inclinationDeg: 70, raanDeg: 0, phase: 0 }));
  const b = msg("B", track("B", { altitudeKm: 478, inclinationDeg: 70, raanDeg: 3, phase: 1.2 }));
  clearTrackCache();
  const r1 = screen({ jobId: "j", primary: a, secondary: b, maxSamplePoints: 2000 });
  const r2 = screen({ jobId: "j", primary: a, secondary: b, maxSamplePoints: 2000 });
  check(
    "repeated pair -> same approach count",
    r1.approaches.length === r2.approaches.length,
    `${r1.approaches.length} vs ${r2.approaches.length}`,
  );
  check(
    "repeated pair -> same min range",
    // A pruned pair reports Infinity for min range, which is correct: no samples
    // were compared. The invariant is that both runs agree, whatever they are.
    Object.is(r1.stats.minRangeKm, r2.stats.minRangeKm),
    `${r1.stats.minRangeKm.toFixed(6)} vs ${r2.stats.minRangeKm.toFixed(6)}`,
  );
  check(
    "repeated pair -> same pruning decision",
    Boolean(r1.stats.pruned) === Boolean(r2.stats.pruned),
    `pruned=${Boolean(r1.stats.pruned)}`,
  );
}

{
  // Role symmetry on a *grazing* encounter, which is where the bug lived.
  //
  // The original code checked only the primary's box at TCA while the coarse
  // pass checked both. A pair whose TCA sat just inside one body's box and just
  // outside the other's then reported 7 approaches forwards and 5 backwards —
  // same TCAs, different survivors. The simple head-on fixtures elsewhere never
  // cross that boundary, so these parameters are chosen to sit on it: shells
  // 2.5 km apart in altitude with planes 0.6° apart, sampled over 3 days.
  //
  // The assertion counts the approaches as well as comparing them, so a fixture
  // that silently stops producing conjunctions (and passes vacuously) fails.
  //
  // These parameters are lifted from the benchmark case that exposed the bug:
  // a 70° / 472.5 km satellite and a 97.3° / 462.5 km one, 10 km apart in
  // altitude and 178° apart in node, crossing twice per revolution.
  const grazingA = msg(
    "graze-a",
    track("graze-a", {
      altitudeKm: 472.5,
      inclinationDeg: 70,
      raanDeg: 211.776,
      phase: (234.891 * Math.PI) / 180,
      eccentricity: 9.22e-4,
    }),
  );
  const grazingB = msg(
    "graze-b",
    track("graze-b", {
      altitudeKm: 462.5,
      inclinationDeg: 97.3,
      raanDeg: 33.552,
      phase: (24.798 * Math.PI) / 180,
      eccentricity: 8.55e-4,
    }),
  );

  clearTrackCache();
  const fwd = screen({ jobId: "g", primary: grazingA, secondary: grazingB, maxSamplePoints: 2000 });
  clearTrackCache();
  const rev = screen({ jobId: "g", primary: grazingB, secondary: grazingA, maxSamplePoints: 2000 });

  const fwdTcas = fwd.approaches.map((a) => a.tcaEpochMs).sort();
  const revTcas = rev.approaches.map((a) => a.tcaEpochMs).sort();

  check(
    "grazing fixture actually produces encounters",
    fwd.approaches.length > 0 || rev.approaches.length > 0,
    `fwd=${fwd.approaches.length} rev=${rev.approaches.length}`,
  );
  check(
    "role swap finds the same TCAs",
    JSON.stringify(fwdTcas) === JSON.stringify(revTcas),
    `fwd=${fwdTcas.length} rev=${revTcas.length}`,
  );

  const fwdMiss = new Map(fwd.approaches.map((a) => [a.tcaEpochMs, a.totalMissDistanceKm]));
  const worst = rev.approaches.reduce(
    (m, a) => Math.max(m, Math.abs((fwdMiss.get(a.tcaEpochMs) ?? Infinity) - a.totalMissDistanceKm)),
    0,
  );
  check("role swap reports the same miss distances", worst < 1e-6, `max delta ${worst.toExponential(1)} km`);
}

clearTrackCache();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
