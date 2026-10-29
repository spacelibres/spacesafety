/**
 * Companion links crossing the worker thread boundary.
 *
 * Separate from `worker-companion.test.ts` because these cases spawn real
 * `worker_threads`, and a thread-transport failure there would hang the suite and
 * hide the pure-compute results. Inline combination is asserted in the other file;
 * this one only asks whether the *link* survives the hop from the pool to a thread.
 *
 * The hop is where a link is easiest to lose: `sources` (text) and `companions`
 * (links) are separate arguments to `pool.run`, and a dispatch that forwards one
 * but not the other looks correct until the covariance is missing.
 */

import { createPool } from "../src/worker/pool";
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

/** Arc start: now, minus a minute. The validator rejects wholly-past arcs. */
const START_MS = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
const STEP_MS = 60_000;
const COUNT = 180;

/** Circular-orbit arc in the Modified ITC format, optional covariance. */
function itcText(name: string, withCovariance: boolean, inclinationDeg = 53): string {
  const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  const lines = [
    `created:${iso(START_MS)} UTC`,
    `ephemeris_start:${iso(START_MS)} UTC ephemeris_stop:${iso(
      START_MS + (COUNT - 1) * STEP_MS,
    )} UTC step_size:60`,
    `ephemeris_source:${name}`,
    "UVW",
  ];

  const radiusKm = 6928;
  const omega = Math.sqrt(398600.4418 / radiusKm ** 3);
  // Inclined, so the relative-motion plane is three-dimensional and the
  // probability integral stays well defined.
  const inc = (inclinationDeg * Math.PI) / 180;
  for (let i = 0; i < COUNT; i += 1) {
    const theta = omega * i * 60;
    lines.push(
      `${doyStamp(START_MS + i * STEP_MS)} ` +
        `${(radiusKm * Math.cos(theta)).toFixed(6)} ` +
        `${(radiusKm * Math.sin(theta) * Math.cos(inc)).toFixed(6)} ` +
        `${(radiusKm * Math.sin(theta) * Math.sin(inc)).toFixed(6)} ` +
        `${(-radiusKm * omega * Math.sin(theta)).toFixed(8)} ` +
        `${(radiusKm * omega * Math.cos(theta) * Math.cos(inc)).toFixed(8)} ` +
        `${(radiusKm * omega * Math.cos(theta) * Math.sin(inc)).toFixed(8)}`,
    );
    if (withCovariance) {
      // 21 lower-triangular values, seven per line, 4 km sigma: a typical freshly
      // fitted Starlink arc, and small enough that the Pc integral stays meaningful.
      const diag = [16, 16, 16, 1.6e-5, 1.6e-5, 1.6e-5];
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
function doyStamp(ms: number): string {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const doy = Math.floor((ms - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${year}${pad(doy, 3)}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.0000`;
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
  // Hard stop. A worker thread that never starts would otherwise hang the suite
  // until the runner's own timeout, and print nothing about why.
  const watchdog = setTimeout(() => {
    console.log("  FAIL pool dispatch timed out — worker threads did not start");
    process.exit(1);
  }, 60_000);
  watchdog.unref();

  const sources: Record<string, string> = {
    "p-ocm": itcText("p-ocm", false),
    "p-itc": itcText("p-itc", true),
    "q-ocm": itcText("q-ocm", false, 55),
    "q-itc": itcText("q-itc", true, 55),
  };
  const links = { "p-ocm": "p-itc", "q-ocm": "q-itc" };

  console.log("\nPool — companion links reach the threads");

  {
    const pool = createPool({ threads: 2, onLog: (m) => console.log("  " + m) });
    const linked = await pool.run(job("p1", "p-ocm", "q-ocm"), sources, links);
    check("pooled linked run completes", linked.status === "JOB_STATUS_COMPLETED", linked.error);
    check(
      "linked run yields a probability",
      linked.approaches[0]?.probabilityOfCollision != null,
      String(linked.approaches[0]?.probabilityOfCollision),
    );

    const unlinked = await pool.run(job("p2", "p-ocm", "q-ocm"), sources);
    check("pooled unlinked run completes", unlinked.status === "JOB_STATUS_COMPLETED", unlinked.error);
    check(
      "unlinked run leaves Pc undefined",
      unlinked.approaches[0]?.probabilityOfCollision == null,
      String(unlinked.approaches[0]?.probabilityOfCollision),
    );

    // Every slot must receive the link, not just the first. A shared map would
    // let slot 2 dispatch without it and silently report a NULL Pc.
    const again = await pool.run(job("p3", "p-ocm", "q-ocm"), sources, links);
    check(
      "a later dispatch on another slot also sees the link",
      again.approaches[0]?.probabilityOfCollision != null,
      String(again.approaches[0]?.probabilityOfCollision),
    );

    await pool.shutdown();
  }

  console.log("\nPool — inline path");

  {
    // `threads === 0` takes a different branch inside the pool and previously
    // forwarded no companions at all.
    const inlineSources: Record<string, string> = {
      "i-ocm": itcText("i-ocm", false),
      "j-ocm": itcText("j-ocm", false, 55),
      "i-itc": itcText("i-itc", true),
      "j-itc": itcText("j-itc", true, 55),
    };
    const pool = createPool({ threads: 0 });
    // Both sides need covariance before the Pc becomes definable: the integral is
    // over the *combined* uncertainty, so one bare trajectory leaves it NULL.
    const result = await pool.run(job("i1", "i-ocm", "j-ocm"), inlineSources, {
      "i-ocm": "i-itc",
      "j-ocm": "j-itc",
    });
    check("inline pool accepts a companion map", result.status === "JOB_STATUS_COMPLETED", result.error);
    check(
      "inline pool applies the borrowed covariance",
      result.approaches[0]?.probabilityOfCollision != null,
      String(result.approaches[0]?.probabilityOfCollision),
    );
    await pool.shutdown();
  }

  clearTimeout(watchdog);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
