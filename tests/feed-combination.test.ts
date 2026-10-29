/**
 * Combining the OCM and ITC feeds.
 *
 * The property that matters: the states and the covariance may come from different
 * feeds, but a single arc never splices two feeds' states together. Splicing would
 * mean resampling one feed onto the other's cadence, which invents data and puts a
 * discontinuity wherever the seam falls.
 *
 * The borrowing path is also bounded: covariance is only taken from the donor
 * within a tolerance, because the two feeds are propagated independently.
 */

import {
  COVARIANCE_BORROW_TOLERANCE_MS,
  combineFeeds,
  type FeedSource,
} from "../src/lib/orbit/feed-combination";
import type { ItcState } from "../src/lib/orbit/itc";

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

const T0 = Date.UTC(2026, 9, 27);
const STEP = 60_000;

/** A synthetic track. `cov` toggles whether every state carries a matrix. */
function track(id: string, format: string, n: number, cov: boolean, offsetMs = 0): FeedSource {
  const states: ItcState[] = [];
  for (let i = 0; i < n; i += 1) {
    states.push({
      ms: T0 + offsetMs + i * STEP,
      position: [6800, 0, 0],
      velocity: [0, 7.6, 0],
      covariance: cov ? new Array(36).fill(0).map((_, k) => (k % 7 === 0 ? 1e-6 : 0)) : null,
    });
  }
  return { trajectoryId: id, format, states };
}

console.log("\nCombination — feed selection");

{
  // The real case: an OCM with a full covariance section is self-sufficient.
  const combined = combineFeeds([track("ocm", "ocm", 100, true), track("itc", "itc", 60, true)])!;
  check("a complete OCM wins over the ITC", combined.kind === "ocm-complete", combined.kind);
  check("states come from the OCM", combined.stateTrajectoryId === "ocm");
  check("no covariance was borrowed", combined.covarianceTrajectoryId === null);
  check("no warnings", combined.warnings.length === 0);
  check("all OCM states survive", combined.states.length === 100, String(combined.states.length));
}

{
  // The ITC alone: the pre-OCM behaviour, still supported.
  const combined = combineFeeds([track("itc", "itc", 60, true)])!;
  check("an ITC alone is used as-is", combined.kind === "single", combined.kind);
  check("states come from the ITC", combined.stateTrajectoryId === "itc");
}

{
  // Neither feed: nothing to screen.
  check("no feeds yields null", combineFeeds([]) === null);
}

console.log("\nCombination — borrowing covariance");

{
  // OCM without covariance, ITC with it, same epoch grid.
  const combined = combineFeeds([track("ocm", "ocm", 100, false), track("itc", "itc", 100, true)])!;
  check("kind records the borrow", combined.kind === "ocm-with-itc-covariance", combined.kind);
  check("states stay from the OCM", combined.stateTrajectoryId === "ocm");
  check("covariance is attributed to the ITC", combined.covarianceTrajectoryId === "itc");
  check(
    "every state now carries covariance",
    combined.states.every((s) => s.covariance !== null && s.covariance.length === 36),
  );
  check(
    "the OCM's longer arc is preserved",
    combined.states.length === 100,
    `${combined.states.length} states (OCM), not ${60} (ITC)`,
  );
  check(
    "the borrow is disclosed",
    combined.warnings.some((w) => /independently propagated/.test(w)),
    combined.warnings[0]?.slice(0, 60),
  );
}

{
  // Never splice: with the ITC covering a *different* time range, the OCM states
  // must not be extended or replaced by ITC samples.
  const ocm = track("ocm", "ocm", 100, false);
  const itc = track("itc", "itc", 100, true, 10 * STEP);
  const combined = combineFeeds([ocm, itc])!;

  const ocmTimes = ocm.states.map((s) => s.ms);
  const combinedTimes = combined.states.map((s) => s.ms);
  check(
    "the state timeline is exactly the OCM's",
    JSON.stringify(combinedTimes) === JSON.stringify(ocmTimes),
    `${combined.states.length} states`,
  );
  check(
    "no ITC state leaked in",
    combinedTimes.every((t) => ocmTimes.includes(t)),
  );
}

{
  // Epochs far apart: borrowing would be a guess, so it must decline.
  //
  // The offset has to clear the whole donor window, not just the tolerance: a
  // donor that merely *starts* later still overlaps most of the OCM's arc, and
  // borrowing from an overlapping epoch is correct. A donor this far away shares
  // no epoch with the target at all.
  const ocm = track("ocm", "ocm", 20, false);
  const gapMs = 20 * STEP + COVARIANCE_BORROW_TOLERANCE_MS;
  const farItc = track("itc", "itc", 20, true, gapMs);
  const combined = combineFeeds([ocm, farItc])!;
  check("a distant donor is not used", combined.kind === "ocm-without-covariance", combined.kind);
  check("states are still the OCM's", combined.stateTrajectoryId === "ocm");
  check(
    "and the NULL Pc is disclosed",
    combined.warnings.some((w) => /NULL Pc/.test(w)),
    combined.warnings[0]?.slice(0, 60),
  );
}

{
  // A sparse donor (one matrix every ten states) still fills every target state,
  // because nearest-epoch matching reuses the closest matrix within tolerance.
  // That is intentional: covariance varies slowly with time, and refusing to reuse
  // would leave most of a fine-cadence OCM arc uncovarianced.
  const sparse: FeedSource = {
    trajectoryId: "itc",
    format: "itc",
    states: track("itc", "itc", 10, true).states.map((s, i) => ({
      ...s,
      ms: T0 + i * 10 * STEP,
    })),
  };
  const combined = combineFeeds([track("ocm", "ocm", 100, false), sparse])!;
  const filled = combined.states.filter((s) => s.covariance !== null).length;
  check("a sparse donor still covers the arc", combined.kind === "ocm-with-itc-covariance");
  // A donor on a 10-minute cadence cannot reach the states that fall exactly
  // between its epochs and the 5-minute tolerance — those stay NULL, which is the
  // honest answer rather than an extrapolated matrix.
  check(
    "coverage is high but bounded by the tolerance",
    filled >= 90 && filled < 100,
    `${filled}/100`,
  );
}

console.log("\nCombination — never overwrites an existing matrix");

{
  // OCM states that half carry covariance: the existing ones must survive untouched.
  const halfCov: FeedSource = {
    trajectoryId: "ocm",
    format: "ocm",
    states: track("ocm", "ocm", 100, false).states.map((s, i) =>
      i % 2 === 0 ? { ...s, covariance: new Array(36).fill(9e-9) } : s,
    ),
  };
  const donor = track("itc", "itc", 100, true);
  const combined = combineFeeds([halfCov, donor])!;
  const kept = combined.states.filter((s) => s.covariance && s.covariance[0] === 9e-9).length;
  check("the OCM's own matrices are preserved", kept === 50, `${kept} kept`);
  check("the gap is filled from the ITC", combined.kind === "ocm-with-itc-covariance");
}

console.log("\nCombination — picking the longest arc");

{
  // Several ITCs (an object accumulates one per ingest); the longest is used.
  const short = track("itc-short", "itc", 20, true);
  const long = track("itc-long", "itc", 80, true);
  const combined = combineFeeds([short, long])!;
  check("the longest ITC is chosen", combined.stateTrajectoryId === "itc-long", combined.stateTrajectoryId);
  check("with its full length", combined.states.length === 80, String(combined.states.length));

  const ocmShort = track("ocm-short", "ocm", 30, true);
  const ocmLong = track("ocm-long", "ocm", 90, true);
  const withTwoOcm = combineFeeds([ocmShort, ocmLong])!;
  check("the longest OCM is chosen", withTwoOcm.stateTrajectoryId === "ocm-long");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
