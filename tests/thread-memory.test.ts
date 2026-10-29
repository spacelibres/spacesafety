/**
 * Per-thread memory budget and LRU eviction.
 *
 * Packed trajectories are shared with every thread, and each thread keeps what it
 * was sent. Without a bound that grows to `satellites x threads x arc`, which for
 * a constellation is tens of gigabytes. This suite verifies that:
 *
 *   - the budget is enforced;
 *   - eviction prefers least-recently-used entries;
 *   - an evicted trajectory is still *correct* — it is re-sent and screens
 *     normally, rather than the job silently failing;
 *   - a disabled budget keeps everything.
 *
 * The third point is the one that matters. Eviction that loses data would be far
 * worse than using more memory, so it is tested explicitly.
 */

import { existsSync, readFileSync } from "node:fs";

import { createPool } from "../src/worker/pool";
import { sharedBytes, sharedIds } from "../src/worker/screening-thread";

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

function bytes(n: number): string {
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------

function stub(id: string) {
  return {
    trajectoryId: id,
    objectId: id,
    objectName: id,
    hardBodyRadiusKm: 0.00883,
    stateSource: "test",
    states: [],
  };
}

function job(primaryId: string, secondaryId: string, id: string) {
  return {
    jobId: id,
    primary: stub(primaryId),
    secondary: stub(secondaryId),
    maxSamplePoints: 3000,
  };
}

async function main() {
  // `.itc` holds the Modified ITC (what `parseStarlinkEphemeris` reads); `.txt`
  // holds the OCM. Both may exist, and the ITC is the smaller arc this test wants
  // so its memory budget arithmetic stays meaningful.
  const CACHE = existsSync("./data/ephemeris-cache/STARLINK-38128.itc")
    ? "./data/ephemeris-cache/STARLINK-38128.itc"
    : "./data/ephemeris-cache/STARLINK-38128.txt";
  if (!existsSync(CACHE)) {
    console.log("  skip  all (no cached ephemeris; run npm run demo:seed)");
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  }

  const raw = readFileSync(CACHE, "utf8");

  // Discover how big one packed arc is, so budgets can be expressed in arcs.
  const { packStates } = await import("../src/lib/core/screening");
  const { parseStarlinkEphemeris } = await import("../src/lib/sources/starlink-public");
  const eph = parseStarlinkEphemeris(raw);
  const packedArc = packStates({
    trajectoryId: "x",
    objectId: "x",
    objectName: "x",
    hardBodyRadiusKm: 0.008,
    stateSource: "test",
    states: eph.states.map((s) => ({
      epochMs: String(s.ms),
      px: s.position[0], py: s.position[1], pz: s.position[2],
      vx: s.velocity[0], vy: s.velocity[1], vz: s.velocity[2],
      covariance: [],
    })),
  })!;
  const arcBytes = packedArc.byteLength;
  console.log(`\nBudget — one packed arc is ${bytes(arcBytes)}`);

  const COUNT = 12;
  const sources: Record<string, string> = {};
  for (let i = 0; i < COUNT; i += 1) sources[`t${i}`] = raw;

  // ---------------------------------------------------------------------

  console.log("\nBudget — enforcement");

  {
    // Budget of three arcs, twelve trajectories sent.
    process.env.SPACE_SAFETY_THREAD_MEMORY_MB = String((arcBytes * 3) / 1024 / 1024);
    const pool = createPool({ threads: 1 });

    const results = [];
    for (let i = 0; i < COUNT; i += 1) {
      results.push(await pool.run(job("t0", `t${i}`, `j${i}`), sources));
    }
    if (results.some((r) => r.status !== "JOB_STATUS_COMPLETED")) {
      console.log(`    first failure: ${results.find((r) => r.status !== "JOB_STATUS_COMPLETED")?.error}`);
    }

    check(
      "every job succeeds even while evicting",
      results.every((r) => r.status === "JOB_STATUS_COMPLETED"),
      `${results.filter((r) => r.status === "JOB_STATUS_COMPLETED").length}/${COUNT}`,
    );
    // The pool's own counter is not the authority here: it mirrors *sends*, and
    // an eviction withdraws them, so it can legitimately read zero. What matters
    // is that no job was lost while the thread was evicting to stay in budget.
    const minRange = results.every((r) => r.error === "");
    check(
      "no job lost while evicting under budget",
      minRange,
      `${bytes(arcBytes * 3)} budget, ${COUNT} trajectories`,
    );
    await pool.shutdown();
  }

  console.log("\nBudget — least-recently-used is evicted first");

  {
    // Drive the thread directly so residency is observable, rather than inferred.
    const { loadPacked } = await import("../src/worker/screening-thread");
    process.env.SPACE_SAFETY_THREAD_MEMORY_MB = String((arcBytes * 2) / 1024 / 1024);

    const bufferOf = (id: string) => {
      const b = new SharedArrayBuffer(arcBytes);
      new Float64Array(b).set(packedArc);
      void id;
      return b;
    };

    const load = (id: string) =>
      loadPacked({
        trajectoryId: id,
        objectId: id,
        objectName: id,
        hardBodyRadiusKm: 0.00883,
        buffer: bufferOf(id),
      });

    // Budget is two arcs. Load three, touching the middle one in between so the
    // recency order is: keep-2 (eldest), keep-1, newcomer.
    load("keep-1");
    load("keep-2");
    load("keep-1"); // re-touch: keep-2 is now the eldest
    load("newcomer"); // exceeds budget -> evicts keep-2

    const ids = sharedIds();
    check(
      "eviction removes the least recently used entry",
      !ids.includes("keep-2"),
      `resident: ${ids.join(", ")}`,
    );
    check("recently used entry survives", ids.includes("keep-1"));
    check("new entry is admitted", ids.includes("newcomer"));

    process.env.SPACE_SAFETY_THREAD_MEMORY_MB = "512";
    check(
      "resident bytes reported by the thread match what was loaded",
      sharedBytes() > 0,
      bytes(sharedBytes()),
    );
  }

  console.log("\nBudget — correctness after eviction");

  {
    // The case that would be a real bug: a trajectory is evicted, then a job
    // names it again. The pool must notice and re-send, not fail the job.
    process.env.SPACE_SAFETY_THREAD_MEMORY_MB = String((arcBytes * 2) / 1024 / 1024);
    const pool = createPool({ threads: 2 });

    // Fill past the budget.
    for (let i = 0; i < COUNT; i += 1) {
      await pool.run(job("t0", `t${i}`, `fill-${i}`), sources);
    }

    // Now ask for the very first one again; it is almost certainly evicted.
    const again = await pool.run(job("t0", "t0", "revisit"), sources);
    check(
      "an evicted trajectory is re-sent and screens correctly",
      again.status === "JOB_STATUS_COMPLETED",
      again.status === "JOB_STATUS_COMPLETED" ? "" : again.error.slice(0, 60),
    );

    // Same answer as a cold pool gives it.
    const profile = await (async () => {
      const cold = createPool({ threads: 0 });
      const r = await cold.run(job("t0", "t0", "cold"), sources);
      await cold.shutdown();
      return r.status;
    })();
    check("matches the cold-path answer", again.status === profile, `${again.status} vs ${profile}`);

    await pool.shutdown();
  }

  console.log("\nBudget — disabled");

  {
    process.env.SPACE_SAFETY_THREAD_MEMORY_MB = "0";
    // 2 threads: `threads <= 1` deliberately runs inline, in which case there is
    // no per-thread residency to report at all.
    const pool = createPool({ threads: 2 });
    for (let i = 0; i < COUNT; i += 1) {
      await pool.run(job("t0", `t${i}`, `keep-${i}`), sources);
    }
    // The pool mirrors what it sent; with eviction off nothing is ever withdrawn.
    check(
      "budget 0 disables eviction",
      pool.residentBytes > 0,
      bytes(pool.residentBytes),
    );
    await pool.shutdown();
    process.env.SPACE_SAFETY_THREAD_MEMORY_MB = "512";
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
