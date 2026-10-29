/**
 * Scale benchmark for the screening kernel.
 *
 * The replica is meant to serve a constellation the size of Starlink, so the
 * question that matters is not "is the physics right" (the test suites answer
 * that) but "how many pairs can one core clear per second". This script answers
 * it with the real pipeline — real ephemeris parsing, real propagation, real
 * Alfano Pc — at three scales:
 *
 *   1. `pairs`  — every pair among the fetched real ephemerides, end to end.
 *   2. `wide`   — N synthetic satellites on the same shell, the worst case for
 *                 a screening box (everything is co-located in RTN).
 *   3. `filter` — the same N with an apogee/perigee + plane pre-filter, to
 *                 measure what the cheap rejection actually buys.
 *
 * Output is deliberately machine-readable (one JSON blob at the end) so results
 * can be pasted into `docs/ARCHITECTURE.md` without transcription errors.
 *
 *   npm run bench                 # 200 satellites
 *   npm run bench -- --count 800
 *   npm run bench -- --offline    # cache only, no network
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { screen } from "../src/lib/core/screening";
import { DEFAULT_WINDOW_MS } from "../src/lib/core/screening";
import { formatDoyTimestamp } from "../src/lib/orbit/itc";
import { createPool, type ScreeningPool } from "../src/worker/pool";
import {
  buildWindows,
  pairNeedsScreening,
  type WindowBox,
} from "../src/lib/core/time-windows";
import {
  SWEEP_EXIT_BINS,
  buildRadialProfile,
  profileFromStates,
  radiallyReachable,
  type RadialProfile,
} from "../src/lib/core/radial-prefilter";
import { cross, mat3Vec, mul3, normalize, rotateCov6, type Mat3, type Vec3 } from "../src/lib/core/linalg";
import { MU_EARTH, RE_EARTH, rad } from "../src/lib/core/propagator";
import type {
  CloseApproachMsg,
  StateVectorMsg,
  TrajectorySampleMsg,
} from "../src/lib/grpc/proto";
import { fetchEphemeris, fetchManifest, parseStarlinkEphemeris } from "../src/lib/sources/starlink-public";

const CACHE_DIR = process.env.SPACE_EYES_CACHE ?? "./data/ephemeris-cache";
/** Starlink hard-body radius: 17.66 m diameter. */
const HBR_KM = 0.00883;
/** Coarse sample budget per job, matching what the worker sends. */
const MAX_SAMPLE_POINTS = 2000;

interface SatRecord {
  id: string;
  name: string;
  traj: TrajectorySampleMsg;
  /** Radial occupancy over the sampled arc, for the pre-filter. */
  radial: RadialProfile;
  /** Spatial windows, built lazily for the window prune. */
  windows: WindowBox[] | null;
  /** Text form, so a threaded run can ship ids instead of states. */
  text: string | null;
  /** Unit angular-momentum vector, enough to compare orbit planes. */
  hHat: [number, number, number];
}

/**
 * Serialise states as the text form a worker actually holds.
 *
 * Threads take trajectory *ids*, not states: shipping states costs ~39 ms per
 * pair in structured cloning (two 3.3 MB objects) against ~2 ms of compute, so
 * the pool would be 20x slower than one core. The bench must therefore exercise
 * the production shape — text once, ids per job — or it measures the wrong thing.
 */
function toItcText(
  states: { ms: number; position: number[]; velocity: number[]; covariance: number[] | null }[],
): string {
  const fmt = (ms: number) =>
    new Date(ms).toISOString().replace("T", " ").replace("Z", "");
  const stepSec = states.length > 1 ? (states[1].ms - states[0].ms) / 1000 : 60;
  const header = [
    `created:${fmt(states[0].ms)}`,
    `ephemeris_start:${fmt(states[0].ms)} ephemeris_stop:${fmt(states[states.length - 1].ms)} step_size:${stepSec}`,
    "ephemeris_source:synthetic",
    "UVW",
  ];
  const rows = states.map((s) => {
    const p = s.position;
    const v = s.velocity;
    return `${formatDoyTimestamp(s.ms)} ${p[0]} ${p[1]} ${p[2]} ${v[0]} ${v[1]} ${v[2]}`;
  });
  return [...header, ...rows].join("\n");
}

function toMsg(id: string, name: string, states: { ms: number; position: number[]; velocity: number[]; covariance: number[] | null }[]): TrajectorySampleMsg {
  const sv: StateVectorMsg[] = states.map((s) => ({
    epochMs: String(s.ms),
    px: s.position[0],
    py: s.position[1],
    pz: s.position[2],
    vx: s.velocity[0],
    vy: s.velocity[1],
    vz: s.velocity[2],
    covariance: s.covariance ?? [],
  }));
  return { trajectoryId: `bench-${id}`, objectId: id, objectName: name, hardBodyRadiusKm: HBR_KM, states: sv, stateSource: "benchmark" };
}

/** Flatten a wire trajectory into the kernel's `[t, r, v]` stride-7 layout. */
function trajData(t: TrajectorySampleMsg): Float64Array {
  const n = t.states.length;
  const out = new Float64Array(n * 7);
  for (let i = 0; i < n; i += 1) {
    const s = t.states[i];
    const o = i * 7;
    out[o] = Number(s.epochMs);
    out[o + 1] = s.px;
    out[o + 2] = s.py;
    out[o + 3] = s.pz;
    out[o + 4] = s.vx;
    out[o + 5] = s.vy;
    out[o + 6] = s.vz;
  }
  return out;
}

function classify(id: string, name: string, traj: TrajectorySampleMsg): SatRecord {
  const first = traj.states[0];
  const pos: [number, number, number] = [first.px, first.py, first.pz];
  const vel: [number, number, number] = [first.vx, first.vy, first.vz];
  // h = r x v, normalised: the orbit-plane normal.
  const [rx, ry, rz] = pos;
  const [vx, vy, vz] = vel;
  const h: [number, number, number] = [ry * vz - rz * vy, rz * vx - rx * vz, rx * vy - ry * vx];
  const hn = Math.hypot(h[0], h[1], h[2]);
  return {
    id,
    name,
    traj,
    // Radial occupancy from *all* sampled states, not one instant's elements.
    radial: profileFromStates(
      traj.states.map((s) => ({ position: [s.px, s.py, s.pz] })),
    ),
    windows: null,
    text: null,
    hHat: [h[0] / hn, h[1] / hn, h[2] / hn],
  };
}

/**
 * The pre-filter predicate: may this pair produce a close approach?
 *
 * Delegates to the shared radial-profile test so the bench and the kernel use one
 * implementation. See `src/lib/core/radial-prefilter.ts` for why the earlier
 * plane-angle and single-point-apogee versions were unsafe.
 */
export function prefilter(a: SatRecord, b: SatRecord): boolean {
  return radiallyReachable(a.radial, b.radial);
}

function fmt(n: number) {
  return n.toLocaleString("en-US");
}

function ms(n: number) {
  return n < 1000 ? `${n.toFixed(0)} ms` : `${(n / 1000).toFixed(2)} s`;
}

async function loadRealRecords(limit: number, offline: boolean): Promise<SatRecord[]> {
  const files: string[] = existsSync(CACHE_DIR)
    ? readdirSync(CACHE_DIR).filter((f) => f.endsWith(".txt"))
    : [];

  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  // Top up the cache from the public manifest when we are short.
  if (files.length < limit && !offline) {
    console.log(`  cache has ${files.length}, fetching up to ${limit}…`);
    const manifest = await fetchManifest();
    for (const entry of manifest) {
      if (files.length >= limit) break;
      const fileName = `${entry.objectName.replace(/\.txt$/, "")}.txt`;
      if (files.includes(fileName)) continue;
      process.stdout.write(`  ${fileName}: downloading…`);
      try {
        const eph = await fetchEphemeris(entry, { timeoutMs: 180_000, retries: 2 });
        writeFileSync(join(CACHE_DIR, fileName), eph.raw);
        files.push(fileName);
        process.stdout.write(` ${(eph.raw.length / 1e6).toFixed(1)} MB\n`);
      } catch (err) {
        process.stdout.write(` failed (${(err as Error).message.slice(0, 40)})\n`);
      }
    }
  }

  const records: SatRecord[] = [];
  for (const file of files.slice(0, limit)) {
    const path = join(CACHE_DIR, file);
    if (!existsSync(path)) continue;
    let parsed;
    try {
      // Public Starlink files are Modified-ITC with a proprietary header block;
      // `parseStarlinkEphemeris` strips that and hands the body to the ITC
      // parser, so go through it rather than calling the ITC parser directly.
      parsed = parseStarlinkEphemeris(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (parsed.states.length < 2) continue;
    const name = file.replace(/\.txt$/, "");
    records.push(classify(name, name, toMsg(name, name, parsed.states)));
  }
  return records;
}

/**
 * Synthesise a multi-shell constellation.
 *
 * A single shell is a misleading benchmark. Two satellites on different planes
 * of the same 70° shell are at least ~560 km apart (72 planes, 4.7° minimum
 * inter-plane angle at 6851 km radius), so a same-shell sweep produces almost no
 * candidates beyond along-track neighbours. Real conjunctions come from adjacent
 * *shells* — 485 / 472.5 / 462.5 / 463 / 360 / 358.5 km are only 10–120 km
 * apart radially, comfortably inside the 2 km radial box once eccentricity and
 * drift are included.
 *
 * So: distribute satellites over the documented shells, phase in-plane by a
 * golden-ratio walk, and give each shell its own small plane offset. That is
 * what a screening service actually faces.
 */
function synthesiseConstellation(n: number, seedRecords: SatRecord[]): SatRecord[] {
  const base = seedRecords[0];
  if (!base) throw new Error("need at least one real ephemeris to synthesise from");
  const seed = base.traj.states;

  // Shell definitions from
  // docs/starlink-space-safety/space-safety-articles__constellation_altitudes.md
  //
  //     V1 + V2 Broadband   485 km / 43°
  //                         472.5 km / 70°
  //                         462.5 km / 97.3°
  //
  // Use the real altitudes. An earlier version packed three shells into ±6 km of
  // the 472.5 km shell, which meant every radial band overlapped and the
  // pre-filter had nothing to reject — a benchmark that flattered the filter by
  // giving it nothing to do.
  const SHELLS = [
    { altitudeKm: 485, inclinationDeg: 43 },
    { altitudeKm: 472.5, inclinationDeg: 70 },
    { altitudeKm: 462.5, inclinationDeg: 97.3 },
  ] as const;

  const t0Ms = Number(seed[0].epochMs);
  const dtSec = (Number(seed[1].epochMs) - t0Ms) / 1000;

  const records: SatRecord[] = [];
  for (let i = 0; i < n; i += 1) {
    const shell = SHELLS[i % SHELLS.length];
    const inShell = Math.floor(i / SHELLS.length);

    // Even plane spread within the shell, offset per shell so the three shells
    // do not share node lines.
    const PLANES = 24;
    const planeIndex = inShell % PLANES;
    const raan = (2 * Math.PI * planeIndex) / PLANES + (i % SHELLS.length) * 0.031;
    // In-plane phasing: golden-ratio walk gives an even spread without sorting.
    const phase = 2 * Math.PI * ((inShell * 0.618033988749895) % 1);

    // A few km of eccentricity, as real Starlink arcs show (e ≈ 1e-3).
    const ecc = 8e-4 + ((inShell * 0.2360679775) % 1) * 4e-4;
    const a = RE_EARTH + shell.altitudeKm;
    const inc = rad(shell.inclinationDeg);

    // Circular velocity per unit radius, for the state at each sample.
    const periodSec = 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH);

    const states = seed.map((s, k) => {
      const elapsed = k * dtSec;
      // True anomaly advances roughly uniformly; eccentricity is tiny, so the
      // difference between true and mean anomaly is below the 5 km bin width.
      const nu = phase + (2 * Math.PI * elapsed) / periodSec;
      const r = (a * (1 - ecc * ecc)) / (1 + ecc * Math.cos(nu));

      // Position in the orbital plane, with the argument of perigee at zero.
      const xp = r * Math.cos(nu);
      const yp = r * Math.sin(nu);
      // Perifocal velocity: v_r = (mu/h) e sin(nu), v_t = (mu/h)(1 + e cos nu).
      const hAng = Math.sqrt(MU_EARTH * a * (1 - ecc * ecc));
      const vxp = -(MU_EARTH / hAng) * Math.sin(nu);
      const vyp = (MU_EARTH / hAng) * (ecc + Math.cos(nu));

      // Rotate into inertial: Rz(raan) · Rx(inc)
      const ci = Math.cos(inc);
      const si = Math.sin(inc);
      const cO = Math.cos(raan);
      const sO = Math.sin(raan);

      const toInertial = (x: number, y: number): [number, number, number] => [
        cO * x - sO * ci * y,
        sO * x + cO * ci * y,
        si * y,
      ];

      const pos = toInertial(xp, yp);
      const vel = toInertial(vxp, vyp);

      return {
        ms: t0Ms + elapsed * 1000,
        position: pos,
        velocity: vel,
        covariance: s.covariance ?? null,
      };
    });

    const id = `SYN-${String(i).padStart(5, "0")}`;
    records.push(classify(id, id, toMsg(id, id, states)));
  }
  return records;
}

/**
 * Synthesise a realistic Starlink shell.
 *
 * Geometry matters for the pre-filter benchmark, so this mirrors how the real
 * constellation is built rather than cloning one orbit:
 *
 *   - **In-plane phasing.** Each satellite is rotated about the seed's own orbit
 *     normal by a quasi-random mean anomaly (golden-ratio walk). Co-planar
 *     phasing never changes radii or planes, so no pair is spuriously close.
 *   - **Plane separation.** Satellites are distributed over `planes` orbit
 *     planes, each rotated about the node axis by an evenly spaced offset. This
 *     is what gives the plane pre-filter something real to reject.
 *
 * State *and* covariance are rotated together, so the synthetic records are
 * physically consistent and exercise the same code path as real ephemerides.
 */
function synthesiseShell(n: number, seedRecords: SatRecord[], planes = 72): SatRecord[] {
  const base = seedRecords[0];
  if (!base) throw new Error("need at least one real ephemeris to synthesise from");
  const seed = base.traj.states;

  // Seed's orbit normal and node: the two axes the two rotations act about.
  const p0 = seed[0];
  const r0: Vec3 = [p0.px, p0.py, p0.pz];
  const v0: Vec3 = [p0.vx, p0.vy, p0.vz];
  const hHat = normalize(cross(r0, v0));
  const nodeHat = normalize(cross([0, 0, 1], hHat));

  const records: SatRecord[] = [];
  for (let i = 0; i < n; i += 1) {
    // Plane offset: evenly spread over a full 360° of relative node.
    const planeAngle = (2 * Math.PI * (Math.floor(i / Math.ceil(n / planes)) % planes)) / planes;
    // In-plane phasing via a golden-ratio walk (even spread, no sorting needed).
    const phaseAngle = 2 * Math.PI * ((i * 0.618033988749895) % 1);

    const inPlane = rotationAbout(hHat, phaseAngle);
    const acrossPlanes = rotationAbout(nodeHat, planeAngle);
    const rot = mul3(acrossPlanes, inPlane);

    const states = seed.map((s) => {
      const rp = mat3Vec(rot, [s.px, s.py, s.pz]);
      const vp = mat3Vec(rot, [s.vx, s.vy, s.vz]);
      return {
        ms: Number(s.epochMs),
        position: rp as number[],
        velocity: vp as number[],
        // Keep the covariance consistent with the rotated state.
        covariance: s.covariance ? rotateCov6(s.covariance, rot) : null,
      };
    });

    const id = `SYN-${String(i).padStart(5, "0")}`;
    records.push(classify(id, id, toMsg(id, id, states)));
  }
  return records;
}

/** Rodrigues rotation matrix about a unit axis. */
function rotationAbout(axis: Vec3, angle: number): Mat3 {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

/**
 * Bucketed pair generation.
 *
 * Even a cheap pre-filter is O(n²) if you run it on every pair, so sort by
 * perigee and slide a window: once `b`'s perigee is more than a box-reach above
 * `a`'s apogee, no later `b` can be radially reachable either.
 *
 * The early-exit threshold **must match** `prefilter`'s acceptance rule exactly.
 * An earlier version broke at `a.apogee + 2` while `prefilter` accepted bands up
 * to a box-reach apart, so pairs in the 2–54 km gap were silently skipped — the
 * sweep found 577 fewer conjunctions than the unfiltered run. Keeping the bound
 * in one place is what prevents that class of bug.
 */
function bucketCandidates(records: SatRecord[]): Array<[SatRecord, SatRecord]> {
  const out: Array<[SatRecord, SatRecord]> = [];

  const sorted = [...records].sort((a, b) => a.radial.minBin - b.radial.minBin);
  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j];
      // Sorted by lowest occupied bin, so once b starts beyond reach of a's
      // highest, every remaining b is out of reach too.
      if (b.radial.minBin - a.radial.maxBin > SWEEP_EXIT_BINS) break;
      if (!prefilter(a, b)) continue;
      out.push([a, b]);
    }
  }
  return out;
}

async function runPairs(
  records: SatRecord[],
  useFilter: boolean,
  useWindows = false,
  pool: ScreeningPool | null = null,
) {
  const candidateStart = performance.now();
  const pairs = useFilter
    ? bucketCandidates(records)
    : (() => {
        const all: Array<[SatRecord, SatRecord]> = [];
        for (let i = 0; i < records.length; i += 1)
          for (let j = i + 1; j < records.length; j += 1) all.push([records[i], records[j]]);
        return all;
      })();
  const candidateMs = performance.now() - candidateStart;

  // Window pruning at the *pair* level, so a pruned pair costs no kernel call at
  // all. The kernel also prunes internally (which is what makes the call cheap),
  // but skipping the call entirely is strictly better: no track compilation, no
  // cache pressure, no allocation.
  // Build the window index once per satellite, outside the timing loop order
  // that would otherwise rebuild it per pair. In production the worker builds
  // this once when a trajectory is loaded, so amortising it here matches.
  const windowsOf = (r: SatRecord) => {
    if (r.windows === null) {
      r.windows = buildWindows(trajData(r.traj), r.traj.states.length, 7, DEFAULT_WINDOW_MS);
    }
    return r.windows;
  };
  if (useWindows) {
    for (const r of records) windowsOf(r);
  }

  // Streaming dispatch: a pool of N threads must always have work queued, so
  // submit the whole candidate list and await it in order. Buffering everything
  // in flight is also what lets a short final tail not serialise the sweep.
  type Outcome = {
    approaches: CloseApproachMsg[];
    stats: { minRangeKm: number };
  };

  const sources: Record<string, string> = {};
  const textOf = (r: SatRecord) => {
    if (r.text === null) {
      r.text = toItcText(
        r.traj.states.map((st) => ({
          ms: Number(st.epochMs),
          position: [st.px, st.py, st.pz],
          velocity: [st.vx, st.vy, st.vz],
          covariance: null,
        })),
      );
      sources[r.traj.trajectoryId] = r.text;
    }
    return r.text;
  };

  const submit = (a: SatRecord, b: SatRecord): Promise<Outcome> => {
    if (pool) {
      // Production shape: ids in the job, text sent once via `sources`.
      textOf(a);
      textOf(b);
      const job = {
        jobId: `${a.id}~${b.id}`,
        primary: { ...a.traj, states: [] },
        secondary: { ...b.traj, states: [] },
        maxSamplePoints: MAX_SAMPLE_POINTS,
      };
      return pool.run(job, sources).then((r) => ({
        approaches: r.approaches,
        stats: { minRangeKm: Infinity },
      }));
    }
    return Promise.resolve(
      screen({
        jobId: `${a.id}~${b.id}`,
        primary: a.traj,
        secondary: b.traj,
        maxSamplePoints: MAX_SAMPLE_POINTS,
      }),
    );
  };

  const started = performance.now();
  const events: string[] = [];
  let minRange = Infinity;
  let pruned = 0;

  // Build the work list first so the pool sees every candidate up front.
  const work: Array<[SatRecord, SatRecord]> = [];
  for (const [a, b] of pairs) {
    if (useWindows && !pairNeedsScreening(windowsOf(a), windowsOf(b))) {
      pruned += 1;
      continue;
    }
    work.push([a, b]);
  }

  const results = await Promise.all(work.map(([a, b]) => submit(a, b)));
  for (let i = 0; i < results.length; i += 1) {
    const a = work[i][0];
    const b = work[i][1];
    const out = results[i];
    if (out.stats.minRangeKm < minRange) minRange = out.stats.minRangeKm;
    for (const ap of out.approaches) {
      // Identity is the unordered pair plus the TCA in seconds: the same
      // encounter reached with the roles swapped must compare equal, because the
      // candidate list and the full sweep sort pairs differently.
      //
      // Roles do matter to the kernel (RTN is the primary's frame), so a
      // swapped pair is not guaranteed to report the same approach — but when it
      // does, it is the same encounter and must not show up as a discrepancy.
      const [x, y] = [a.id, b.id].sort();
      events.push(`${x}~${y}@${Math.round(Number(ap.tcaEpochMs) / 1000)}`);
    }
  }
  const elapsed = performance.now() - started;
  const screened = pairs.length - pruned;
  return {
    pairsEvaluated: pairs.length,
    pairsPruned: pruned,
    pairsScreened: screened,
    approaches: events.length,
    events,
    minRangeKm: Number.isFinite(minRange) ? Number(minRange.toFixed(4)) : null,
    candidateMs: Math.round(candidateMs),
    elapsedMs: Math.round(elapsed),
    // Throughput is reported over *candidates*, not over kernel calls: the whole
    // point of pruning is that it removes work, and a per-kernel-call figure
    // would hide that by dividing a smaller numerator by a smaller denominator.
    pairsPerSecond: elapsed > 0 ? Math.round((pairs.length / elapsed) * 1000) : null,
    microsecondsPerPair: pairs.length ? Number(((elapsed / pairs.length) * 1000).toFixed(1)) : null,
    /** Cost of the pairs that did reach the kernel, for comparison. */
    microsecondsPerScreened: screened ? Number(((elapsed / screened) * 1000).toFixed(1)) : null,
  };
}

async function main() {
  const countArg = process.argv.indexOf("--count");
  const count = countArg !== -1 ? Number(process.argv[countArg + 1]) || 200 : 200;
  const offline = process.argv.includes("--offline");
  const realLimit = Number(process.env.SPACE_EYES_BENCH_REAL ?? 20);

  console.log(`\nSpace Eyes — screening benchmark`);
  console.log(`  satellites per sweep : ${fmt(count)}`);
  console.log(`  coarse sample budget : ${fmt(MAX_SAMPLE_POINTS)} per pair\n`);

  console.log("Loading real ephemerides…");
  const real = await loadRealRecords(realLimit, offline);
  if (real.length < 2) {
    console.error(
      "Need at least 2 cached ephemerides. Run `npm run demo:seed -- --count 6` first.",
    );
    process.exit(1);
  }
  console.log(`  ${real.length} ephemerides loaded (${fmt(real.length * (real.length - 1) / 2)} pairs)\n`);

  const results: globalThis.Record<string, unknown> = {};

  console.log("Real-pair sweep (end-to-end, unfiltered)");
  const realResult = await runPairs(real, false);
  console.log(
    `  ${fmt(realResult.pairsEvaluated)} pairs in ${ms(realResult.elapsedMs)} ` +
      `→ ${realResult.microsecondsPerPair} µs/pair, ${fmt(realResult.pairsPerSecond ?? 0)} pairs/s`,
  );
  console.log(`  ${realResult.approaches} close approaches, min range ${realResult.minRangeKm} km\n`);
  results.real = realResult;

  const memBefore = process.memoryUsage().rss;
  const shell = synthesiseConstellation(count, real);
  const memAfter = process.memoryUsage().rss;
  const footprintMb = Number(((memAfter - memBefore) / 1024 / 1024).toFixed(1));
  console.log(`Synthetic ${fmt(count)}-satellite 3-shell constellation`);
  console.log(`  24 h track each, ${footprintMb} MB resident\n`);
  results.memoryPerSatelliteMb = Number((footprintMb / count).toFixed(3));

  console.log("Sweep A — no pre-filter (everything through the kernel)");
  const unfiltered = await runPairs(shell, false);
  console.log(
    `  ${fmt(unfiltered.pairsEvaluated)} pairs in ${ms(unfiltered.elapsedMs)} ` +
      `→ ${unfiltered.microsecondsPerPair} µs/pair`,
  );
  console.log(`  ${unfiltered.approaches} close approaches\n`);
  results.unfiltered = unfiltered;

  console.log("Sweep B — sampled-radius profile pre-filter");
  const filtered = await runPairs(shell, true);
  console.log(
    `  ${fmt(filtered.pairsEvaluated)} pairs survive in ${ms(filtered.elapsedMs)} ` +
      `→ ${filtered.microsecondsPerPair} µs/pair`,
  );
  console.log(`  rejection rate ${(100 * (1 - filtered.pairsEvaluated / unfiltered.pairsEvaluated)).toFixed(1)}%`);
  console.log(`  ${filtered.approaches} close approaches\n`);
  results.filtered = filtered;

  // The pre-filter is only allowed to save time. If it drops a conjunction the
  // sweep is wrong, and a silently-lower approach count is exactly how that went
  // unnoticed during development. Compare the *set* of events, not just the
  // count — two different findings can still add up to the same total.
  const missing = unfiltered.events.filter((e) => !filtered.events.includes(e));
  if (missing.length !== 0) {
    console.error(
      `\nASSERTION FAILED: pre-filter dropped ${fmt(missing.length)} of ` +
        `${fmt(unfiltered.events.length)} approaches (e.g. ${missing.slice(0, 3).join(", ")}). ` +
        `A pre-filter may only remove work, never findings.\n`,
    );
    process.exit(1);
  }
  console.log(
    `  pre-filter agreement: all ${fmt(unfiltered.events.length)} approaches found\n`,
  );

  // --- Where the pre-filter actually pays off.
  //
  // Inside one constellation the shells are 10–22.5 km apart while the box reach
  // is 53 km, so nothing is rejected. The filter earns its keep against *other*
  // populations. Report both, so nobody reads the 0% above as a bug and nobody
  // assumes the filter is free money.
  {
    const shell = (altKm: number, ecc: number) => {
      const radii: number[] = [];
      const a = RE_EARTH + altKm;
      for (let i = 0; i < 720; i += 1) {
        const nu = (2 * Math.PI * i) / 720;
        radii.push((a * (1 - ecc * ecc)) / (1 + ecc * Math.cos(nu)) - RE_EARTH);
      }
      return buildRadialProfile(radii);
    };
    const starlink = [485, 472.5, 462.5].map((a) => shell(a, 1e-3));
    const others = [
      ["OneWeb 1200", 1200, 5e-4],
      ["Iridium 780", 780, 2e-4],
      ["debris belt 800", 800, 6e-3],
      ["GPS MEO", 20200, 1e-2],
      ["GEO", 35786, 1e-4],
    ] as const;

    let rejected = 0;
    for (const s of starlink) {
      for (const [, alt, ecc] of others) {
        if (!radiallyReachable(s, shell(alt, ecc))) rejected += 1;
      }
    }
    const total = starlink.length * others.length;
    console.log("Cross-population pre-filter");
    console.log(
      `  Starlink vs ${others.map((o) => o[0]).join(", ")}`,
    );
    console.log(
      `  ${rejected}/${total} rejected (${((100 * rejected) / total).toFixed(0)}%) ` +
        `— this is where the filter pays for itself\n`,
    );
    results.crossPopulation = { rejected, total, rejectionRate: rejected / total };
  }

  console.log("Sweep C — Sweep B + spatial time-window prune");
  const windowed = await runPairs(shell, true, true);
  console.log(
    `  ${fmt(windowed.pairsScreened)} of ${fmt(windowed.pairsEvaluated)} pairs reach the kernel ` +
      `(${((100 * windowed.pairsPruned) / windowed.pairsEvaluated).toFixed(1)}% pruned by windows)`,
  );
  console.log(
    `  ${ms(windowed.elapsedMs)} total → ${windowed.microsecondsPerPair} µs/pair over all candidates, ` +
      `${windowed.microsecondsPerScreened} µs per screened pair`,
  );
  // What Sweep B would have cost had every candidate reached the kernel at the
  // *windowed* per-pair cost. This is the fair comparison: the per-pair cost fell
  // as well, because the kernel prunes internally with the same windows.
  // microsecondsPerPair is µs, so convert back to ms before multiplying.
  const hypothetical = ((filtered.microsecondsPerPair ?? 0) * filtered.pairsEvaluated) / 1000;
  if (hypothetical > 0) {
    const saved = 1 - windowed.elapsedMs / hypothetical;
    console.log(
      `  vs ${ms(hypothetical)} if every candidate were screened: ${(100 * saved).toFixed(0)}% saved`,
    );
  }
  console.log(`  ${windowed.approaches} close approaches\n`);
  results.windowed = windowed;

  // Same agreement assertion as Sweep B: windows may only remove work.
  const windowMissing = unfiltered.events.filter((e) => !windowed.events.includes(e));
  if (windowMissing.length !== 0) {
    console.error(
      `\nASSERTION FAILED: window prune dropped ${fmt(windowMissing.length)} of ` +
        `${fmt(unfiltered.events.length)} approaches (e.g. ${windowMissing.slice(0, 3).join(", ")}).\n`,
    );
    process.exit(1);
  }
  console.log(`  window agreement: all ${fmt(unfiltered.events.length)} approaches found\n`);

  // Sweep D — the same work spread across worker threads.
  //
  // This is the configuration a deployed compute node actually runs. The other
  // sweeps are single-core, so their numbers are a per-core floor.
  const threadsArg = process.argv.indexOf("--threads");
  const threads =
    threadsArg !== -1 ? Number(process.argv[threadsArg + 1]) || 0 : 0;
  if (threads > 1) {
    console.log(`Sweep D — Sweep C across ${threads} worker threads`);
    console.log(
      "  (cold working set: every pair is distinct, so threads pay first-touch",
    );
    console.log(
      "   packing per trajectory — this measures startup, not steady state)",
    );
    const pool = createPool({ threads });
    const parallel = await runPairs(shell, true, true, pool);
    console.log(
      `  ${ms(parallel.elapsedMs)} total → ${parallel.microsecondsPerPair} µs/pair`,
    );
    console.log(
      `  speedup vs single core: ${(windowed.elapsedMs / parallel.elapsedMs).toFixed(2)}×`,
    );
    console.log(`  ${parallel.approaches} close approaches\n`);
    results.parallel = { ...parallel, events: undefined, threads };

    const missingParallel = unfiltered.events.filter((e) => !parallel.events.includes(e));
    if (missingParallel.length !== 0) {
      console.error(
        `\nASSERTION FAILED: threaded sweep dropped ${fmt(missingParallel.length)} approaches.\n`,
      );
      process.exit(1);
    }
    console.log(`  thread agreement: all ${fmt(unfiltered.events.length)} approaches found\n`);

    // Sweep D is pessimistic: one job per pair means every thread parses every
    // trajectory on first sight. A real sweep walks one satellite against many
    // others, so the same trajectories repeat and per-thread parse caches hit.
    //
    // This models that with a *small* working set — 4 primaries against 16
    // others — because a 3-day ephemeris packs to ~20 MB once shared. Scale that
    // up and the sweep measures memory bandwidth, not compute: 32 trajectories x
    // 16 threads is 1 GB of live buffers, and a real worker never holds that many
    // full arcs at once, because a dispatch carries only the pair it screens.
    // Repeat the pattern so the timed region is long enough to measure: below a
    // few hundred jobs per thread, dispatch cost dominates and the comparison
    // says nothing about throughput.
    const heads = shell.slice(0, Math.min(8, shell.length));
    const pool32 = shell.slice(0, Math.min(64, shell.length));
    const fanoutPairs: Array<[SatRecord, SatRecord]> = [];
    for (const head of heads) {
      for (const other of pool32) {
        if (head.id === other.id) continue;
        // No window pre-test here: this sweep measures thread scaling, and
        // pruning would only shrink both sides of the comparison.
        fanoutPairs.push([head, other]);
      }
    }

    if (fanoutPairs.length > 0) {
      // Build every job's text *before* timing, so the measurement covers
      // dispatch and compute, not serialisation.
      const src: Record<string, string> = {};
      const jobsByPair = fanoutPairs.map(([a, b]) => {
          for (const r of [a, b]) {
            // Always register the id -> text mapping. Gating on `text === null`
            // means a satellite already serialised by an earlier sweep never
            // reaches `src`, and every job naming it fails as "not available".
            if (r.text === null) {
              r.text = toItcText(
                r.traj.states.map((st) => ({
                  ms: Number(st.epochMs),
                  position: [st.px, st.py, st.pz],
                  velocity: [st.vx, st.vy, st.vz],
                  covariance: null,
                })),
              );
            }
            src[r.traj.trajectoryId] = r.text;
          }
        return {
          jobId: `${a.id}~${b.id}`,
          primary: { ...a.traj, states: [] },
          secondary: { ...b.traj, states: [] },
          maxSamplePoints: MAX_SAMPLE_POINTS,
        };
      });

      // The inline path keeps its own references, outside the job object. Nested
      // inside the job they would be structured-cloned to the threads on every
      // dispatch — 4 321 states x 2 — which alone made the threaded run 10x
      // slower than one core.
      const inlinePairs = fanoutPairs.map(([a, b]) => ({ primary: a.traj, secondary: b.traj }));

      // Pre-warm the pack cache outside the timed region: the first time a
      // trajectory is seen costs ~90 ms to parse and pack. In production that
      // happens once when the worker loads it, not once per sweep.
      // Cover every distinct trajectory, not the first N jobs: with 32 ids and
      // 16 threads, a partial warm-up leaves most threads packing on first touch.
      if (pool) {
        await Promise.all(jobsByPair.map((j) => pool.run(j, src)));
      }

      const runFanout = async (usePool: boolean) => {
        const startedAt = performance.now();
        let found = 0;
        if (usePool) {
          // Bounded in-flight, mirroring the server: it dispatches at most
          // `concurrency` jobs per worker. Firing 6 000 at once floods the event
          // loop with pending promises and starves the posts to the threads.
          const BATCH = 256;
          let tRun = 0;
          for (let i = 0; i < jobsByPair.length; i += BATCH) {
            const chunk = jobsByPair.slice(i, i + BATCH);
            const t0 = performance.now();
            const rs = await Promise.all(chunk.map((j) => pool.run(j, src)));
            tRun += performance.now() - t0;
            const failed = rs.find((r) => r.status !== "JOB_STATUS_COMPLETED");
            if (failed) console.log(`    thread failure: ${failed.error.slice(0, 110)}`);
            for (const r of rs) found += r.approaches.length;
          }
          console.log(`    dispatch+compute: ${tRun.toFixed(0)} ms`);
        } else {
          for (let i = 0; i < jobsByPair.length; i += 1) {
            found += screen({
              jobId: jobsByPair[i].jobId,
              primary: inlinePairs[i].primary,
              secondary: inlinePairs[i].secondary,
              maxSamplePoints: MAX_SAMPLE_POINTS,
            }).approaches.length;
          }
        }
        return { ms: performance.now() - startedAt, found };
      };

      // Warm both paths so the comparison is steady-state.
      await runFanout(true);
      const serial = await runFanout(false);
      const parallelFan = await runFanout(true);
      console.log(`  Sweep D2 — fan-out workload (${fmt(fanoutPairs.length)} pairs, repeated trajectories)`);
      console.log(
        `    single core ${ms(serial.ms)} → ${threads} threads ${ms(parallelFan.ms)} ` +
          `(${(serial.ms / parallelFan.ms).toFixed(2)}×)`,
      );
      console.log(`    ${serial.found} vs ${parallelFan.found} approaches\n`);
      results.fanout = {
        pairs: fanoutPairs.length,
        serialMs: Math.round(serial.ms),
        parallelMs: Math.round(parallelFan.ms),
        speedup: Number((serial.ms / parallelFan.ms).toFixed(2)),
        serialApproaches: serial.found,
        parallelApproaches: parallelFan.found,
      };
      if (serial.found !== parallelFan.found) {
        console.error("\nASSERTION FAILED: fan-out sweep lost approaches\n");
        process.exit(1);
      }
    }

    await pool.shutdown();
  }

  // Extrapolate to the full constellation.
  const n = 11163;
  const fullPairs = (n * (n - 1)) / 2;
  const parallelResult = results.parallel as { pairsPerSecond: number | null } | undefined;
  const throughput =
    parallelResult?.pairsPerSecond ??
    windowed.pairsPerSecond ??
    filtered.pairsPerSecond ??
    unfiltered.pairsPerSecond ??
    1;
  results.constellation = {
    satellites: n,
    pairs: fullPairs,
    projectedHoursSingleCore: Number((fullPairs / throughput / 3600).toFixed(2)),
  };
  const projection = results.constellation as { projectedHoursSingleCore: number };
  console.log("Full constellation extrapolation");
  console.log(`  ${fmt(n)} satellites → ${fmt(fullPairs)} pairs`);
  console.log(
    `  at ${fmt(throughput)} pairs/s → ${projection.projectedHoursSingleCore} h on one core\n`,
  );

  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
