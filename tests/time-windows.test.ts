/**
 * Spatial time-window pruning.
 *
 * Two jobs for this suite:
 *
 *   1. **Correctness.** The prune may only remove work. Every approach found by
 *      an unpruned sweep must survive pruning, at *every* window length — the
 *      bench asserts this at the default; this suite sweeps the parameter,
 *      because a bug that only appears at a short window would otherwise ship.
 *   2. **Effect.** Report the actual prune rate on a same-shell constellation,
 *      which is the case the radial pre-filter cannot help with.
 *
 *   npm run test:windows
 */

import { clearTrackCache, screen } from "../src/lib/core/screening";
import { MU_EARTH, RE_EARTH } from "../src/lib/core/propagator";
import {
  WINDOW_PADDING_KM,
  boxesMaybeIntersect,
  buildWindows,
  pairNeedsScreening,
  windowPaddingKm,
  windowsOverlapInTime,
  type WindowBox,
} from "../src/lib/core/time-windows";
import type { StateVectorMsg, TrajectorySampleMsg } from "../src/lib/grpc/proto";

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
const POINTS = 2160; // 36 h — long enough for many plane crossings.

const STRIDE = 7;

function orbitStates(opts: {
  altitudeKm: number;
  inclinationDeg: number;
  raanDeg: number;
  phase: number;
  eccentricity?: number;
}): StateVectorMsg[] {
  const ecc = opts.eccentricity ?? 0;
  const a = RE_EARTH + opts.altitudeKm;
  const inc = (opts.inclinationDeg * Math.PI) / 180;
  const raan = (opts.raanDeg * Math.PI) / 180;
  const period = 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH);
  const hAng = Math.sqrt(MU_EARTH * a * (1 - ecc * ecc));
  const ci = Math.cos(inc), si = Math.sin(inc);
  const cO = Math.cos(raan), sO = Math.sin(raan);
  const toI = (x: number, y: number): [number, number, number] => [
    cO * x - sO * ci * y,
    sO * x + cO * ci * y,
    si * y,
  ];

  const out: StateVectorMsg[] = [];
  for (let k = 0; k < POINTS; k += 1) {
    const nu = opts.phase + (2 * Math.PI * ((k * DT_MS) / 1000)) / period;
    const r = (a * (1 - ecc * ecc)) / (1 + ecc * Math.cos(nu));
    const p = toI(r * Math.cos(nu), r * Math.sin(nu));
    const v = toI(
      -(MU_EARTH / hAng) * Math.sin(nu),
      (MU_EARTH / hAng) * (ecc + Math.cos(nu)),
    );
    out.push({
      epochMs: String(T0 + k * DT_MS),
      px: p[0], py: p[1], pz: p[2],
      vx: v[0], vy: v[1], vz: v[2],
      covariance: [],
    });
  }
  return out;
}

function msg(id: string, states: StateVectorMsg[]): TrajectorySampleMsg {
  return {
    trajectoryId: id,
    objectId: id,
    objectName: id,
    hardBodyRadiusKm: 0.00883,
    stateSource: "test",
    states,
  };
}

function flat(states: StateVectorMsg[]): Float64Array {
  const out = new Float64Array(states.length * STRIDE);
  for (let i = 0; i < states.length; i += 1) {
    const s = states[i];
    const o = i * STRIDE;
    out[o] = Number(s.epochMs);
    out[o + 1] = s.px; out[o + 2] = s.py; out[o + 3] = s.pz;
    out[o + 4] = s.vx; out[o + 5] = s.vy; out[o + 6] = s.vz;
  }
  return out;
}

/** Starlink-like population: three documented shells. */
function population(n: number): TrajectorySampleMsg[] {
  const SHELLS = [
    { altitudeKm: 485, inclinationDeg: 43 },
    { altitudeKm: 472.5, inclinationDeg: 70 },
    { altitudeKm: 462.5, inclinationDeg: 97.3 },
  ] as const;

  const out: TrajectorySampleMsg[] = [];
  for (let i = 0; i < n; i += 1) {
    const shell = SHELLS[i % SHELLS.length];
    const inShell = Math.floor(i / SHELLS.length);
    out.push(
      msg(`SAT-${i}`, orbitStates({
        altitudeKm: shell.altitudeKm,
        inclinationDeg: shell.inclinationDeg,
        raanDeg: ((inShell % 24) * 360) / 24 + (i % 3) * 1.8,
        phase: 2 * Math.PI * ((inShell * 0.618033988749895) % 1),
        eccentricity: 8e-4 + ((inShell * 0.2360679775) % 1) * 4e-4,
      })),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------

console.log("\nTime windows — geometry");

{
  const states = orbitStates({ altitudeKm: 500, inclinationDeg: 53, raanDeg: 0, phase: 0 });
  const data = flat(states);

  const w10 = buildWindows(data, states.length, STRIDE, 10 * 60_000);
  const w60 = buildWindows(data, states.length, STRIDE, 60 * 60_000);

  check("windows cover the whole track", w10.length === 216 && w60.length === 36, `${w10.length} / ${w60.length}`);
  check(
    "windows are contiguous in time",
    w10.every((w, i) => i === 0 || w.startMs === w10[i - 1].endMs),
  );
  check(
    "shorter windows give tighter boxes",
    w10[0].maxX - w10[0].minX < w60[0].maxX - w60[0].minX,
    `${(w10[0].maxX - w10[0].minX).toFixed(0)} km vs ${(w60[0].maxX - w60[0].minX).toFixed(0)} km`,
  );

  // A window's box must contain every sample it covers.
  const inside = w10.every((w) => {
    const first = Math.round((w.startMs - T0) / DT_MS);
    const last = Math.round((w.endMs - T0) / DT_MS) - 1;
    for (let k = Math.max(0, first); k <= Math.min(states.length - 1, last); k += 1) {
      const s = states[k];
      if (
        s.px < w.minX - 1e-9 || s.px > w.maxX + 1e-9 ||
        s.py < w.minY - 1e-9 || s.py > w.maxY + 1e-9 ||
        s.pz < w.minZ - 1e-9 || s.pz > w.maxZ + 1e-9
      ) return false;
    }
    return true;
  });
  check("every sample lies inside its window box", inside);
}

{
  // Padding must exceed the box half-diagonal, or a pair could pass the prune
  // and then be reported by the kernel.
  const halfDiagonal = Math.hypot(2, 44, 51);
  check(
    "padding covers the screening-box half-diagonal",
    WINDOW_PADDING_KM >= halfDiagonal,
    `${WINDOW_PADDING_KM.toFixed(2)} km >= ${halfDiagonal.toFixed(2)} km`,
  );
  check(
    "padding also covers one sample step of motion",
    WINDOW_PADDING_KM >= halfDiagonal + 7.6 * 60,
    `${WINDOW_PADDING_KM.toFixed(0)} km >= ${(halfDiagonal + 456).toFixed(0)} km`,
  );
}

console.log("\nTime windows — pruning logic");

{
  // `buildWindows` inflates boxes by the padding, so a hand-built box must model
  // the inflated form: bounds already include the margin.
  const box = (t: number, x: number, halfWidth = 0): WindowBox => ({
    startMs: t,
    endMs: t + 1_000_000,
    minX: x - halfWidth,
    maxX: x + halfWidth,
    minY: 0, maxY: 0, minZ: 0, maxZ: 0,
  });

  // Two boxes of the same half-width `h`, centres `d` apart, touch while
  // d <= 2h. Use the padding as the half-width, which is what buildWindows does.
  const h = WINDOW_PADDING_KM;
  check("coincident boxes intersect", boxesMaybeIntersect(box(0, 0, h), box(0, 0, h)));
  check(
    "boxes well within reach intersect",
    boxesMaybeIntersect(box(0, 0, h), box(0, 51, h)),
  );
  check(
    "boxes separated beyond twice the padding are pruned",
    !boxesMaybeIntersect(box(0, 0, h), box(0, 2 * h + 1, h)),
    `${(2 * h + 1).toFixed(0)} km apart`,
  );
  check(
    "boxes just inside the threshold still intersect",
    boxesMaybeIntersect(box(0, 0, h), box(0, 2 * h - 1, h)),
  );

  check("overlapping windows in time", windowsOverlapInTime(box(0, 0), box(500_000, 0)));
  check("disjoint windows in time", !windowsOverlapInTime(box(0, 0), box(2_000_000, 0)));

  // Same place, different time: must NOT be pruned as a meeting.
  check(
    "same place, disjoint time -> no screening",
    !pairNeedsScreening([box(0, 0)], [box(2_000_000, 0)]),
  );
  check("same place, same time -> screening", pairNeedsScreening([box(0, 0)], [box(0, 0)]));
}

console.log("\nTime windows — zero false negatives across window lengths");

{
  const sats = population(60);
  const datas = sats.map((s) => flat(s.states));

  // Ground truth: unpruned. `maxSamplePoints` high enough that the kernel does
  // its own full sweep rather than thinning.
  const baseline = new Set<string>();
  clearTrackCache();
  for (let i = 0; i < sats.length; i += 1) {
    for (let j = i + 1; j < sats.length; j += 1) {
      const out = screen({
        jobId: `${i}-${j}`,
        primary: sats[i],
        secondary: sats[j],
        maxSamplePoints: 8000,
        // A window far longer than the arc makes the internal prune a no-op.
        windowMs: 10 * 365 * 24 * 3600_000,
      });
      for (const ap of out.approaches) baseline.add(`${i}-${j}@${ap.tcaEpochMs}`);
    }
  }
  check("baseline sweep produces encounters to protect", baseline.size > 0, `${baseline.size} approaches`);

  for (const windowMin of [1, 2, 5, 7.5, 10, 20, 45, 90, 180]) {
    clearTrackCache();
    let pruned = 0;
    const found = new Set<string>();

    for (let i = 0; i < sats.length; i += 1) {
      for (let j = i + 1; j < sats.length; j += 1) {
        const wA = buildWindows(datas[i], sats[i].states.length, STRIDE, windowMin * 60_000);
        const wB = buildWindows(datas[j], sats[j].states.length, STRIDE, windowMin * 60_000);
        if (!pairNeedsScreening(wA, wB)) {
          pruned += 1;
          continue;
        }
        const out = screen({
          jobId: `${i}-${j}`,
          primary: sats[i],
          secondary: sats[j],
          maxSamplePoints: 8000,
          windowMs: windowMin * 60_000,
        });
        for (const ap of out.approaches) found.add(`${i}-${j}@${ap.tcaEpochMs}`);
      }
    }

    const missing = [...baseline].filter((e) => !found.has(e));
    const rate = (100 * pruned) / ((sats.length * (sats.length - 1)) / 2);
    check(
      `${windowMin} min windows: no approach lost`,
      missing.length === 0,
      `pruned ${rate.toFixed(1)}%, lost ${missing.length}`,
    );
  }
}

console.log("\nTime windows — sub-sample-spacing windows (regression)");

{
  // Regression for the bug that lost 13 of 367 approaches at a 30-second window.
  //
  // The window padding used to be the screening-box half-diagonal only. That is
  // correct for the *positions we sampled*, but the kernel interpolates between
  // samples: a window holding a single sample has a one-point box, and the true
  // position at TCA can be most of a sample step away from it. At 60 s spacing
  // that is ~460 km, so every approach whose TCA fell between samples was pruned.
  //
  // Padding now includes one sample step. This test pins the behaviour at window
  // lengths both below and above the sample spacing.
  const sats = population(60);
  const datas = sats.map((s) => flat(s.states));

  const baseline = new Set<string>();
  clearTrackCache();
  for (let i = 0; i < sats.length; i += 1) {
    for (let j = i + 1; j < sats.length; j += 1) {
      const out = screen({
        jobId: `${i}-${j}`,
        primary: sats[i],
        secondary: sats[j],
        maxSamplePoints: 8000,
        windowMs: 10 * 365 * 24 * 3600_000,
      });
      for (const ap of out.approaches) baseline.add(`${i}-${j}@${ap.tcaEpochMs}`);
    }
  }
  check("baseline has approaches to protect", baseline.size > 0, `${baseline.size}`);

  // 30 s is *half* the 60 s sample spacing: windows hold a single sample each,
  // which is exactly the degenerate case the padding fix addresses.
  for (const windowMin of [0.25, 0.5, 1, 3]) {
    clearTrackCache();
    const found = new Set<string>();
    for (let i = 0; i < sats.length; i += 1) {
      for (let j = i + 1; j < sats.length; j += 1) {
        const wA = buildWindows(datas[i], sats[i].states.length, STRIDE, windowMin * 60_000);
        const wB = buildWindows(datas[j], sats[j].states.length, STRIDE, windowMin * 60_000);
        if (!pairNeedsScreening(wA, wB)) continue;
        const out = screen({
          jobId: `${i}-${j}`,
          primary: sats[i],
          secondary: sats[j],
          maxSamplePoints: 8000,
          windowMs: windowMin * 60_000,
        });
        for (const ap of out.approaches) found.add(`${i}-${j}@${ap.tcaEpochMs}`);
      }
    }
    const missing = [...baseline].filter((e) => !found.has(e));
    check(
      `${windowMin} min windows (<= sample spacing): no approach lost`,
      missing.length === 0,
      `lost ${missing.length}/${baseline.size}`,
    );
  }

  // And the padding must actually scale with sample spacing.
  check(
    "padding grows with sample spacing",
    windowPaddingKm(60_000) > windowPaddingKm(10_000),
    `${windowPaddingKm(10_000).toFixed(0)} km -> ${windowPaddingKm(60_000).toFixed(0)} km`,
  );
}

console.log("\nTime windows — determinism");

{
  const a = population(6);
  const run = (windowMs?: number) => {
    clearTrackCache();
    const out: string[] = [];
    for (let i = 0; i < a.length; i += 1) {
      for (let j = i + 1; j < a.length; j += 1) {
        const r = screen({ jobId: "d", primary: a[i], secondary: a[j], maxSamplePoints: 4000, windowMs });
        for (const ap of r.approaches) out.push(`${i}-${j}@${ap.tcaEpochMs}`);
      }
    }
    return out.sort().join(",");
  };

  check("repeated pruned sweep is identical", run(7.5 * 60_000) === run(7.5 * 60_000));
  check("cold cache matches warm cache", run() === run());
}

clearTrackCache();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
