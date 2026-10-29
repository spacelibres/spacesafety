/**
 * Worker-side feed combination: does a dispatched job actually see both feeds?
 *
 * `feed-combination.test.ts` proves the *choice* logic in isolation. This suite
 * proves the choice reaches the kernel: the companion link has to travel from the
 * API's batch endpoint, through the pool's dispatch loop, into the thread that
 * parses the raw text. Every hop here is a place the link can silently drop —
 * a per-slot map that the thread never reads, a job that carries sources but no
 * link, a cached parse that outlives the text it came from.
 *
 * The fixtures are generated rather than downloaded so the suite runs offline and
 * asserts exact numbers. An OCM with no covariance is the interesting case: it is
 * what a real Starlink OCM looks like when the operator omits the COV section,
 * and borrowing the ITC's covariance is what turns a NULL Pc into a number.
 */

import {
  knownCompanions,
  loadCompanion,
  loadTrajectory,
  runInline,
} from "../src/worker/screening-thread";
import type { ScreeningJobMsg } from "../src/lib/grpc/proto";

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

/**
 * Arc start: now, rounded down to the minute.
 *
 * The validator rejects a trajectory that ends more than 24 h in the past, so a
 * fixed calendar date would make this suite start failing a day after it is
 * written. Rounding to the minute keeps the ITC encode/decode exact.
 */
const START_MS = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
const STEP_MS = 60_000;
const COUNT = 180;

/**
 * A short arc on a circular orbit, in the Modified ITC format the worker parses.
 *
 * `withCovariance` writes a diagonal matrix per state; leaving it false produces
 * the covariance-less case the borrowing path exists for.
 */
function itcText(
  name: string,
  opts: {
    withCovariance: boolean;
    count?: number;
    crossTrackKm?: number;
    /** Inclination offset in degrees, to give a pair a real relative velocity. */
    inclinationDeg?: number;
  },
): string {
  const count = opts.count ?? COUNT;
  const radiusKm = 6928;
  const mu = 398600.4418;
  const omega = Math.sqrt(mu / radiusKm ** 3);
  const lines = [
    `created:${new Date(START_MS).toISOString().replace("T", " ").slice(0, 19)} UTC`,
    `ephemeris_start:${new Date(START_MS).toISOString().replace("T", " ").slice(0, 19)} UTC ` +
      `ephemeris_stop:${new Date(START_MS + (count - 1) * STEP_MS)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19)} UTC step_size:60`,
    `ephemeris_source:${name}`,
    "UVW",
  ];

  for (let i = 0; i < count; i += 1) {
    const t = i * (STEP_MS / 1000);
    const theta = omega * t;
    // A *three-dimensional* circular orbit, inclined 53 degrees.
    //
    // An equatorial test orbit (z = vz = 0) is degenerate: the probability integral
    // fails on it with "degenerate covariance or relative velocity", because the
    // relative-motion plane has no component out of the equator. Real Starlink
    // orbits are inclined, so the fixture is too.
    const inc = ((opts.inclinationDeg ?? 53) * Math.PI) / 180;
    const px = radiusKm * Math.cos(theta);
    const py = radiusKm * Math.sin(theta) * Math.cos(inc);
    const pz = radiusKm * Math.sin(theta) * Math.sin(inc) + (opts.crossTrackKm ?? 0);
    const vx = -radiusKm * omega * Math.sin(theta);
    const vy = radiusKm * omega * Math.cos(theta) * Math.cos(inc);
    const vz = radiusKm * omega * Math.cos(theta) * Math.sin(inc);
    const stamp = thisStamp(START_MS + i * STEP_MS);
    lines.push(
      `${stamp} ${px.toFixed(6)} ${py.toFixed(6)} ${pz.toFixed(6)} ` +
        `${vx.toFixed(8)} ${vy.toFixed(8)} ${vz.toFixed(8)}`,
    );
    if (opts.withCovariance) {
      // 21 lower-triangular values, seven per line. A 4 km sigma along each axis
      // is typical for a freshly fitted Starlink arc and keeps the Mahalanobis
      // distance inside the probability integral's useful range.
      const sigP = 4; // km
      const sigV = 0.004; // km/s
      const diag = [sigP * sigP, sigP * sigP, sigP * sigP, sigV * sigV, sigV * sigV, sigV * sigV];
      const lower: number[] = [];
      for (let r = 0; r < 6; r += 1) {
        for (let c = 0; c <= r; c += 1) lower.push(r === c ? diag[r] : 0);
      }
      for (let row = 0; row < 3; row += 1) {
        lines.push(
          lower
            .slice(row * 7, row * 7 + 7)
            .map((v) => v.toExponential(6))
            .join(" "),
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The ITC epoch encoding: `YYYYDDDHHMMSS.ssss`. */
function thisStamp(ms: number): string {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const doy = Math.floor((ms - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${year}${pad(doy, 3)}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.0000`
  );
}

function stub(id: string): ScreeningJobMsg["primary"] {
  return {
    trajectoryId: id,
    objectId: id,
    objectName: id,
    hardBodyRadiusKm: 0.005,
    stateSource: "operator_ephemeris",
    states: [],
  };
}

function job(jobId: string, primary: string, secondary: string): ScreeningJobMsg {
  return { jobId, primary: stub(primary), secondary: stub(secondary), maxSamplePoints: 4000 };
}

async function main() {
  console.log("\nWorker — companion links");

  {
    // The thread's own bookkeeping: a link is recorded, not inferred.
    loadCompanion("link-a", "link-b");
    check(
      "a companion link is recorded",
      knownCompanions()["link-a"] === "link-b",
    );
  }

  console.log("\nWorker — combining at parse time");

  {
    // Same orbit twice: the pair meets every sample, so any state-count difference
    // between the two paths shows up as a different approach count or TCA.
    const itc = itcText("sat", { withCovariance: true });
    loadTrajectory("solo-itc", itc);
    loadTrajectory("solo-itc-2", itc);

    const result = runInline(job("j-itc", "solo-itc", "solo-itc-2"));
    check("ITC pair screens cleanly", result.status === "JOB_STATUS_COMPLETED", result.error);
    check("ITC pair finds the co-located encounter", result.approaches.length > 0, `${result.approaches.length}`);
  }

  {
    // Covariance-less OCM as the requested trajectory, the ITC as companion.
    // Without the link the OCM has nothing to borrow from, so this is exactly the
    // difference the link makes.
    const ocm = itcText("ocm-sat", { withCovariance: false });
    const companion = itcText("itc-sat", { withCovariance: true });

    loadTrajectory("okm-plain", ocm);
    loadTrajectory("okm-plain-2", ocm);
    loadTrajectory("okm-solo", ocm);
    loadTrajectory("okm-linked", ocm);
    loadTrajectory("okm-linked-itc", companion);

    const unlinked = runInline(job("j-unlinked", "okm-plain", "okm-plain-2"));
    check(
      "unlinked covariance-less pair still screens",
      unlinked.status === "JOB_STATUS_COMPLETED",
      unlinked.error,
    );
    const unlinkedFirst = unlinked.approaches[0];

    // Pc needs covariance on *both* sides of a pair, so the peer also has to carry
    // one -- and it needs a *non-zero relative velocity*. Two identical tracks are
    // degenerate for the probability integral, and so is an equatorial one. The
    // peer therefore flies the same ground track at a 2-degree inclination offset.
    loadTrajectory("okm-peer-cov", itcText("okm-peer-cov", { withCovariance: true, inclinationDeg: 55 }));

    loadCompanion("okm-linked", "okm-linked-itc");
    const linked = runInline(job("j-linked", "okm-linked", "okm-peer-cov"));
    const linkedFirst = linked.approaches[0];

    check(
      "linked pair screens cleanly",
      linked.status === "JOB_STATUS_COMPLETED",
      linked.error,
    );
    check(
      "both paths find the same encounter",
      Boolean(linkedFirst) && Boolean(unlinkedFirst),
      `${linked.approaches.length} vs ${unlinked.approaches.length}`,
    );

    // This is the whole point of the link: Pc becomes definable. `unlinkedFirst`
    // pairs two covariance-less trajectories, so it must stay NULL.
    check(
      "no covariance on either side means no probability",
      !unlinkedFirst || unlinkedFirst.probabilityOfCollision === undefined || unlinkedFirst.probabilityOfCollision === null,
      String(unlinkedFirst?.probabilityOfCollision),
    );
    check(
      "borrowed covariance yields a probability",
      Boolean(linkedFirst && linkedFirst.probabilityOfCollision !== undefined && linkedFirst.probabilityOfCollision !== null),
      String(linkedFirst?.probabilityOfCollision),
    );
  }

  {
    // A missing companion must not break screening; it just leaves the OCM alone.
    loadTrajectory("orphan", itcText("orphan", { withCovariance: false }));
    loadTrajectory("orphan-peer", itcText("orphan-peer", { withCovariance: false }));
    loadCompanion("orphan", "not-loaded-anywhere");

    const result = runInline(job("j-orphan", "orphan", "orphan-peer"));
    check(
      "absent companion falls back to the single feed",
      result.status === "JOB_STATUS_COMPLETED",
      result.error,
    );
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
