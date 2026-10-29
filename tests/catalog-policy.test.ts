/**
 * Which trajectory screening actually uses.
 *
 * This suite exists because of a real failure: after a bulk import the database
 * held 400 trajectories (100 OCM, 100 ITC, 100 TLE, 100 OMM) and screening found
 * nothing, because `catalog` was never written. `enqueueScreening` picks partners
 * by reading `catalog`, so an empty catalog means zero pairs — the data was there
 * and nothing was ever compared.
 *
 * The second trap is subtler: `catalog` is keyed `(object_id, state_source)`, so
 * four sources for one object look legitimate. Screening reads *every* row, which
 * would screen the same satellite pair four times with different inputs and let
 * whichever finished first decide the CDM. So exactly one row per object must be
 * kept, chosen by `selectReference`.
 */

import {
  selectReference,
  sourceRank,
  type CatalogCandidate,
} from "../src/lib/orbit/catalog-policy";

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

const DAY = 86_400_000;

/** The four feeds one Starlink object really has, with their measured shapes. */
function starlinkFeeds(): CatalogCandidate[] {
  return [
    {
      trajectoryId: "ocm",
      stateSource: "operator_ephemeris",
      uploadedAt: "2026-10-27T01:00:00.000Z",
      pointCount: 10_081,
      spanMs: 7 * DAY,
    },
    {
      // Same source rank as the OCM, shorter arc: 3 days.
      trajectoryId: "itc",
      stateSource: "operator_ephemeris",
      uploadedAt: "2026-10-27T01:00:00.000Z",
      pointCount: 4_321,
      spanMs: 3 * DAY,
    },
    {
      trajectoryId: "tle",
      stateSource: "tle",
      uploadedAt: "2026-10-27T02:00:00.000Z",
      pointCount: 1,
    },
    {
      trajectoryId: "omm",
      stateSource: "omm",
      uploadedAt: "2026-10-27T02:00:00.000Z",
      pointCount: 1,
    },
  ];
}

async function main() {
  console.log("\nCatalog — source ranking");

  {
    check(
      "operator ephemeris outranks catalogue elements",
      sourceRank("operator_ephemeris") < sourceRank("tle") &&
        sourceRank("operator_ephemeris") < sourceRank("omm"),
      `${sourceRank("operator_ephemeris")} < ${sourceRank("tle")}`,
    );
    check(
      "TLE and OMM are ranked equally",
      sourceRank("tle") === sourceRank("omm"),
    );
    check(
      "an unknown source sinks to the bottom",
      sourceRank("something-else") > sourceRank("tle"),
    );
  }

  console.log("\nCatalog — the reference actually used for screening");

  {
    const pick = selectReference(starlinkFeeds());
    check("a reference is chosen", pick !== null);
    check(
      "it is the OCM, not the ITC",
      pick?.trajectoryId === "ocm",
      pick?.trajectoryId ?? "none",
    );
    check(
      "the OCM is picked for its 7-day arc, not merely its source",
      pick?.spanMs === 7 * DAY,
      `${(pick?.spanMs ?? 0) / DAY} d`,
    );
  }

  {
    // TLE and OMM are ranked equally and neither has a span, so recency decides.
    const tleFirst = selectReference([
      { trajectoryId: "tle-old", stateSource: "tle", uploadedAt: "2026-10-25T00:00:00.000Z" },
      { trajectoryId: "tle-new", stateSource: "tle", uploadedAt: "2026-10-27T00:00:00.000Z" },
    ]);
    check(
      "equal-rank sources are broken by recency",
      tleFirst?.trajectoryId === "tle-new",
      tleFirst?.trajectoryId ?? "none",
    );
  }

  {
    // An object with no operator ephemeris falls back to what exists.
    const noOperator = starlinkFeeds().filter((c) => c.stateSource !== "operator_ephemeris");
    const pick = selectReference(noOperator);
    check(
      "an object without an operator ephemeris still gets a reference",
      pick !== null,
      pick?.stateSource ?? "none",
    );
    check("and that reference is TLE or OMM", pick?.trajectoryId === "omm" || pick?.trajectoryId === "tle");
  }

  {
    check("an object with no trajectories yields no reference", selectReference([]) === null);
  }

  console.log("\nCatalog — one row per object");

  {
    // The invariant that prevents four screenings per pair: whatever the feeds,
    // the selection is a single candidate.
    const pick = selectReference(starlinkFeeds());
    const matches = starlinkFeeds().filter((c) => c.trajectoryId === pick?.trajectoryId);
    check(
      "selection is unique even when four feeds exist",
      matches.length === 1,
      `${matches.length} match(es)`,
    );
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Keep this file a module.
export {};
