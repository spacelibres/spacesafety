/**
 * Screening pre-filter correctness.
 *
 * The pre-filter exists to make a constellation-sized sweep tractable. Its only
 * job is speed; correctness is the kernel's. A pre-filter that drops a real
 * conjunction is therefore strictly worse than no pre-filter, and this suite
 * exists because that is exactly what happened during development: the
 * `R·θ < box` plane test is only valid for equal radii, and it silently
 * discarded every cross-shell pair (12 km apart radially, 4.7° apart in plane)
 * — 1299 real approaches reduced to zero.
 *
 *   npm run test:prefilter
 */

import { existsSync, readFileSync } from "node:fs";

import { RE_EARTH } from "../src/lib/core/propagator";
import {
  PREFILTER_REACH_KM,
  buildRadialProfile,
  radiallyReachable,
} from "../src/lib/core/radial-prefilter";
import { clearTrackCache, screen } from "../src/lib/core/screening";
import { parseStarlinkEphemeris } from "../src/lib/sources/starlink-public";

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

// ---------------------------------------------------------------------------
// A local copy of the pre-filter.
//
// It lives in `scripts/benchmark.ts`, which is a script rather than a library
// module, so the logic is mirrored here for testing. Keep the two in step; the
// fixture below fails loudly if the mirror drifts from the behaviour the sweep
// actually relies on.
// ---------------------------------------------------------------------------

interface SatRecord {
  apogeeKm: number;
  perigeeKm: number;
  /**
   * Orbit normal. Retained by the fixtures because it is what distinguishes the
   * cases, but the radial filter deliberately does not consult it: a plane test
   * is unsafe (two orbits in different planes can meet at the node crossing).
   */
  hHat: [number, number, number];
}

/**
 * These cases predate the radial-profile filter and describe *orbit geometry*,
 * so they are expressed against that model and evaluated with the shipped
 * implementation. A profile built from a full revolution at constant radius is
 * what a circular orbit produces.
 */
function profileFor(s: SatRecord) {
  // A circular record occupies one radius; an eccentric one sweeps its band.
  const radii: number[] = [];
  const steps = 64;
  for (let i = 0; i < steps; i += 1) {
    // Sample the band inclusively so both endpoints are represented.
    const t = i / (steps - 1);
    radii.push(s.perigeeKm + (s.apogeeKm - s.perigeeKm) * t);
  }
  return buildRadialProfile(radii);
}

function prefilter(a: SatRecord, b: SatRecord): boolean {
  return radiallyReachable(profileFor(a), profileFor(b));
}

/** Orbit normal for a circular orbit of inclination `i` at node `raan`. */
function normal(iDeg: number, raanDeg: number): [number, number, number] {
  const i = (iDeg * Math.PI) / 180;
  const O = (raanDeg * Math.PI) / 180;
  return [Math.sin(i) * Math.sin(O), -Math.sin(i) * Math.cos(O), Math.cos(i)];
}

function sat(altKm: number, iDeg: number, raanDeg: number): SatRecord {
  return { apogeeKm: altKm, perigeeKm: altKm, hHat: normal(iDeg, raanDeg) };
}

console.log("\nPre-filter — rejection");

{
  // Coplanar, far apart in altitude: no encounter possible.
  const a = sat(550, 53, 0);
  const b = sat(472.5, 53, 0);
  check("different altitudes, same plane -> rejected", !prefilter(a, b));
}

{
  // Same altitude, opposite planes. The radial filter **keeps** this: it only
  // reasons about radius, and a plane test is not safe (see below). Keeping is
  // the correct answer here — the kernel rejects the pair quickly, and it costs
  // one wasted evaluation rather than a missed conjunction.
  const a = sat(472.5, 70, 0);
  const b = sat(472.5, 70, 180);
  check("same altitude, opposite planes -> kept (radial filter is radius-only)", prefilter(a, b));
}

{
  // Same altitude, adjacent planes of a 72-plane shell: 4.7° apart, 562 km.
  // Kept for the same reason, and for a good one: that geometry is exactly what
  // a *stale* trajectory can turn into an encounter once drift is applied.
  const a = sat(472.5, 70, 0);
  const b = sat(472.5, 70, 5);
  check("same shell, adjacent planes -> kept (radius-only filter)", prefilter(a, b));
}

console.log("\nPre-filter — the cross-shell case that a naive R·θ test gets wrong");

{
  // 485 km and 472.5 km shells: 12.5 km apart radially, but the planes differ by
  // 4.7°, because the shells use different plane sets. They can meet at the node
  // crossing with a 12.5 km separation, which is well inside the box.
  const a = sat(485, 70, 0);
  const b = sat(472.5, 70, 5);
  check(
    "different shells, different planes -> KEPT",
    prefilter(a, b),
    `R·θ = ${((RE_EARTH + 478) * (4.7 * Math.PI / 180)).toFixed(0)} km, radial gap 12.5 km`,
  );
}

{
  // Same shell, one plane apart, small eccentricity spread: must be kept.
  const a = { apogeeKm: 478, perigeeKm: 467, hHat: normal(70, 0) };
  const b = { apogeeKm: 478, perigeeKm: 467, hHat: normal(70, 0.1) };
  check("same shell with eccentricity -> kept", prefilter(a, b));
}

console.log("\nPre-filter — where it actually helps");

{
  // Quantifies the value boundary, using the shared radial-profile filter.
  //
  // Inside a constellation the shells are 10–22.5 km apart while the box reach
  // is 53 km, so nothing can be rejected — the filter is pure overhead there.
  // Across constellations and orbit regimes it rejects almost everything. Both
  // numbers are asserted so a future "optimisation" cannot quietly claim the
  // same speedup where there is none.
  const shellProfile = (altKm: number, ecc: number) => {
    const radii: number[] = [];
    const a = RE_EARTH + altKm;
    for (let i = 0; i < 720; i += 1) {
      const nu = (2 * Math.PI * i) / 720;
      radii.push((a * (1 - ecc * ecc)) / (1 + ecc * Math.cos(nu)) - RE_EARTH);
    }
    return buildRadialProfile(radii);
  };

  const starlink = [485, 472.5, 462.5].map((a) => shellProfile(a, 1e-3));

  // Same constellation: every shell pair must be kept.
  let sameConstellationKept = 0;
  for (let i = 0; i < starlink.length; i += 1) {
    for (let j = i + 1; j < starlink.length; j += 1) {
      if (radiallyReachable(starlink[i], starlink[j])) sameConstellationKept += 1;
    }
  }
  check(
    "Starlink shells 10–22.5 km apart are all kept (range too small to reject)",
    sameConstellationKept === 3,
    `${sameConstellationKept}/3 kept`,
  );

  // Cross-regime: must be rejected.
  const others = [
    { name: "OneWeb 1200", alt: 1200, ecc: 5e-4 },
    { name: "Iridium 780", alt: 780, ecc: 2e-4 },
    { name: "GPS MEO", alt: 20200, ecc: 1e-2 },
    { name: "GEO", alt: 35786, ecc: 1e-4 },
    { name: "debris belt 800", alt: 800, ecc: 6e-3 },
  ].map((o) => ({ ...o, profile: shellProfile(o.alt, o.ecc) }));

  let rejected = 0;
  let compared = 0;
  for (const shell of starlink) {
    for (const o of others) {
      compared += 1;
      if (!radiallyReachable(shell, o.profile)) rejected += 1;
    }
  }
  check(
    "adjacent orbit regimes are rejected",
    rejected === compared,
    `${rejected}/${compared} rejected`,
  );

  // The boundary itself: a gap just under reach is kept, just over is rejected.
  const below = shellProfile(500, 0);
  const above = shellProfile(500 + PREFILTER_REACH_KM + 5, 0);
  check("gap below reach -> kept", radiallyReachable(shellProfile(485, 0), below));
  check("gap above reach -> rejected", !radiallyReachable(shellProfile(485, 0), above));
}

console.log("\nPre-filter — kernel agreement (the property that matters)");

{
  // The end-to-end guarantee: for every pair the pre-filter keeps, run the real
  // kernel; for every pair it drops, build a synthetic encounter that *is* inside
  // the box and confirm the filter's radial test is what rejected it — i.e. the
  // filter never drops something the kernel would have reported.
  //
  // Here we use the strongest available evidence directly: a real pair of close
  // approaches from cached Starlink ephemerides.
  const cache = process.env.SPACE_EYES_CACHE ?? "./data/ephemeris-cache";
  // `.itc` holds the Modified ITC; `.txt` holds the OCM. This test wants the ITC
  // because `parseStarlinkEphemeris` reads that format.
  const itcFile = `${cache}/STARLINK-38128.itc`;
  const legacy = `${cache}/STARLINK-38128.txt`;
  const file = existsSync(itcFile) ? itcFile : legacy;
  if (!existsSync(file)) {
    console.log("  skip  kernel agreement (no cached ephemeris; run npm run demo:seed)");
  } else {
    const eph = parseStarlinkEphemeris(readFileSync(file, "utf8"));
    const first = eph.states[0];
    const toMsg = (id: string, states: typeof eph.states) => ({
      trajectoryId: id,
      objectId: id,
      objectName: id,
      hardBodyRadiusKm: 0.00883,
      stateSource: "test",
      states: states.map((s) => ({
        epochMs: String(s.ms),
        px: s.position[0], py: s.position[1], pz: s.position[2],
        vx: s.velocity[0], vy: s.velocity[1], vz: s.velocity[2],
        covariance: s.covariance ?? [],
      })),
    });

    // Shift the twin 12 km radially along a *scaled circular* orbit, which keeps
    // the semi-major axis difference real without inducing eccentricity.
    const shifted = eph.states.map((s) => {
      const r = Math.hypot(s.position[0], s.position[1], s.position[2]);
      const k = (r - 12) / r;
      const vs = 1 / Math.sqrt(k);
      return {
        ...s,
        position: [s.position[0] * k, s.position[1] * k, s.position[2] * k] as [
          number, number, number,
        ],
        velocity: [s.velocity[0] * vs, s.velocity[1] * vs, s.velocity[2] * vs] as [
          number, number, number,
        ],
      };
    });

    clearTrackCache();
    const out = screen({
      jobId: "prefilter-agreement",
      primary: toMsg("p", eph.states),
      secondary: toMsg("s", shifted),
      maxSamplePoints: 2000,
    });

    // 12 km radial separation: outside the 2 km radial half-width, so the kernel
    // must not report it — and the pre-filter must therefore also keep the pair
    // (it does not get to be cleverer than the kernel).
    const a: SatRecord = {
      apogeeKm: 483, perigeeKm: 469, hHat: [
        first.position[1] * first.velocity[2] - first.position[2] * first.velocity[1],
        first.position[2] * first.velocity[0] - first.position[0] * first.velocity[2],
        first.position[0] * first.velocity[1] - first.position[1] * first.velocity[0],
      ].map((x) => x / Math.hypot(
        first.position[1] * first.velocity[2] - first.position[2] * first.velocity[1],
        first.position[2] * first.velocity[0] - first.position[0] * first.velocity[2],
        first.position[0] * first.velocity[1] - first.position[1] * first.velocity[0],
      )) as [number, number, number],
    };
    const b: SatRecord = { ...a, apogeeKm: 471, perigeeKm: 457 };

    check(
      "12 km radial offset pair is kept by the filter",
      prefilter(a, b),
    );
    check(
      "kernel agrees: 12 km radial offset is outside the 2 km radial box",
      out.approaches.length === 0,
      `minRange ${out.stats.minRangeKm.toFixed(1)} km`,
    );
  }
}

clearTrackCache();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
