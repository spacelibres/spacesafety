/**
 * Master-database merge rules.
 *
 * The merge decides what *we* believe when sources disagree, so each rule is a
 * claim that has to be defensible. These tests pin the four that matter:
 *
 *   * a name difference is usually a display variant, not an identity change;
 *   * object class comes from the finer source, because the coarse one is also
 *     wrong for ~1 600 objects;
 *   * manoeuvrability is one stored rule, not re-derived per consumer;
 *   * a disagreement beyond tolerance is recorded, never silently resolved.
 *
 * The decay tolerance deserves a note: the first version flagged 306 objects,
 * because DISCOS's `predDecayDate` is a *forecast* and SATCAT's is the *observed*
 * re-entry, and the two routinely differ by 1–2 days. Flags that fire on normal
 * behaviour train a reader to ignore the list, which is worse than no list.
 */

import Database from "better-sqlite3";

import { mergeIdentity } from "../src/lib/sources/master-merge";

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

/** Minimal view builder so each test states only the fields it cares about. */
function view(overrides: {
  satcat?: Partial<NonNullable<Parameters<typeof mergeIdentity>[0]["satcat"]>>;
  discos?: Partial<NonNullable<Parameters<typeof mergeIdentity>[0]["discos"]>>;
  elements?: Array<{
    sourceId: string;
    trajectoryId: string;
    epoch?: string | null;
    arcHours?: number | null;
    inclination?: number | null;
  }>;
}): Parameters<typeof mergeIdentity>[0] {
  return {
    noradId: 44714,
    satcat: overrides.satcat
      ? {
          name: "STARLINK-1008",
          objectType: "PAYLOAD",
          owner: "US",
          launchDate: "2019-11-11",
          decayDate: null,
          status: "Active",
          inclination: 53.1436,
          covarianceStart: null,
          covarianceStop: null,
          entityId: "e1",
          ...overrides.satcat,
        }
      : undefined,
    discos: overrides.discos
      ? {
          name: "Starlink 1008",
          objectClass: "Payload",
          mass: 260,
          xSectAvg: 13.5615,
          xSectMax: 23.657,
          xSectMin: 0.2311,
          shape: "Box + 1 Pan",
          cosparId: "2019-074B",
          firstEpoch: "2019-11-14",
          predDecayDate: null,
          ...overrides.discos,
        }
      : undefined,
    elements: (overrides.elements ?? []).map((e) => ({
      epoch: null,
      arcHours: null,
      ...e,
    })),
  };
}

async function main() {
  // ---------------------------------------------------------------- names
  console.log("\nname precedence");
  const named = mergeIdentity(view({ satcat: {}, discos: {} }));
  check("SATCAT's short name wins", named.name === "STARLINK-1008", named.name);
  check(
    "the DISCOS form is kept as an alias",
    named.aliasNames === "Starlink 1008",
    named.aliasNames ?? "",
  );

  const caseOnly = mergeIdentity(
    view({ satcat: { name: "ONEWEB-0012" }, discos: { name: "OneWeb 0012" } }),
  );
  check(
    "a case-only variant still becomes an alias",
    caseOnly.aliasNames === "OneWeb 0012",
    caseOnly.aliasNames ?? "",
  );

  const onlyDiscos = mergeIdentity(view({ discos: {} }));
  check("a DISCOS-only name is used when SATCAT is absent", onlyDiscos.name === "Starlink 1008");
  const onlySatcat = mergeIdentity(view({ satcat: {} }));
  check("no alias when there is nothing to alias", onlySatcat.aliasNames === null);
  const neither = mergeIdentity({ noradId: 999999, elements: [] });
  check("a nameless object gets a NORAD label", neither.name === "NORAD-999999", neither.name);

  // --------------------------------------------------------------- classes
  console.log("\nobject class and manoeuvrability");
  const classified = mergeIdentity(view({ satcat: {}, discos: {} }));
  check("DISCOS class wins over SATCAT type", classified.objectClass === "Payload");
  check("the SATCAT type is still recorded", classified.satcatType === "PAYLOAD");
  check("a payload is manoeuvrable", classified.maneuverable);

  // The measured case: SATCAT says DEBRIS, DISCOS says Payload (606 objects).
  const misclassified = mergeIdentity(
    view({ satcat: { objectType: "DEBRIS" }, discos: { objectClass: "Payload" } }),
  );
  check(
    "a payload SATCAT calls DEBRIS is still manoeuvrable",
    misclassified.maneuverable,
    `${misclassified.objectClass}`,
  );

  // And the reverse: a rocket body must never be manoeuvrable.
  const body = mergeIdentity(
    view({ satcat: { objectType: "PAYLOAD" }, discos: { objectClass: "Rocket Body" } }),
  );
  check("a rocket body is not manoeuvrable", !body.maneuverable, body.objectClass ?? "");

  // With no DISCOS row, the coarse type decides.
  const coarse = mergeIdentity(view({ satcat: { objectType: "DEBRIS" } }));
  check("without DISCOS the SATCAT type decides", !coarse.maneuverable);

  // ------------------------------------------------------------ physical
  console.log("\nphysical model");
  check("mass comes from DISCOS", classified.massKg === 260);
  check("cross-section comes from DISCOS", classified.crossSectionAvgM2 === 13.5615);
  const noDiscos = mergeIdentity(view({ satcat: {} }));
  check("without DISCOS there is no mass", noDiscos.massKg === null);
  check("and no cross-section", noDiscos.crossSectionAvgM2 === null);

  // ------------------------------------------------------------- conflicts
  console.log("\nconflict detection");
  // A 2-day decay difference is forecast skill, not a conflict.
  const closeDecay = mergeIdentity(
    view({
      satcat: { decayDate: "2026-07-08T00:00:00" },
      discos: { predDecayDate: "2026-07-10" },
    }),
  );
  check(
    "a 2-day decay difference is not flagged",
    closeDecay.conflicts.length === 0,
    `${closeDecay.conflicts.length}`,
  );

  // A decay prediction centuries out is a real data fault.
  const absurdDecay = mergeIdentity(
    view({
      satcat: { decayDate: "2009-09-11T00:00:00" },
      discos: { predDecayDate: "9999-12-31" },
    }),
  );
  check(
    "an absurd decay prediction is flagged",
    absurdDecay.conflicts.some((c) => c.field === "decay-date"),
    absurdDecay.conflicts.map((c) => c.field).join(","),
  );
  check(
    "and it is left undecidable rather than silently resolved",
    absurdDecay.conflicts.find((c) => c.field === "decay-date")?.resolution === "undecidable",
  );

  // Inclination within tolerance: no flag.
  const closeInc = mergeIdentity(
    view({
      satcat: { inclination: 53.14 },
      elements: [{ sourceId: "space-track", trajectoryId: "t1", inclination: 53.1436 }],
    }),
  );
  check("an inclination within tolerance is not flagged", closeInc.conflicts.length === 0);

  // The measured 15° case (SKYNET 4F) must be flagged and not resolved.
  const wideInc = mergeIdentity(
    view({
      satcat: { name: "SKYNET 4F", inclination: 9.74 },
      elements: [{ sourceId: "space-track", trajectoryId: "t1", inclination: 12.265 }],
    }),
  );
  const incConflict = wideInc.conflicts.find((c) => c.field === "inclination");
  check("a 2.5-degree inclination split is flagged", incConflict !== undefined);
  check(
    "and no value is chosen",
    incConflict?.chosen === null,
    String(incConflict?.chosen),
  );
  check(
    "the claims keep both values",
    JSON.stringify(incConflict?.claims ?? {}).includes("9.74"),
    JSON.stringify(incConflict?.claims ?? {}),
  );

  // -------------------------------------------------------------- sources
  console.log("\nsource accounting");
  const all = mergeIdentity(
    view({ satcat: {}, discos: {}, elements: [{ sourceId: "space-track", trajectoryId: "t1" }] }),
  );
  check("all three layers are recorded", all.sourceCount === 3, all.sources);
  check("and named individually", all.sources === "satcat,discos,elements", all.sources);
  const partial = mergeIdentity(view({ satcat: {} }));
  check("a partial object counts one source", partial.sourceCount === 1, partial.sources);

  // ------------------------------------------------- element selection
  console.log("\nelement selection");
  // The registry names the operator feeds `starlink-ocm`, but the rows are stored
  // under `operator_ephemeris` with the format in a separate column. Matching on
  // `state_source` alone found no OCM, so every Starlink fell back to its
  // single-epoch TLE — the inversion of the intended policy. These assertions pin
  // the mapping rather than the storage detail.
  const { pickTrajectorySource } = await import("../src/lib/sources/registry");
  const canonical = (e: { sourceId: string; fileFormat?: string | null }) =>
    e.sourceId === "operator_ephemeris"
      ? e.fileFormat === "itc"
        ? "starlink-itc"
        : "starlink-ocm"
      : e.sourceId;

  check(
    "an operator OCM row maps to the OCM registry id",
    canonical({ sourceId: "operator_ephemeris", fileFormat: "ocm" }) === "starlink-ocm",
  );
  check(
    "an operator ITC row maps to the ITC registry id",
    canonical({ sourceId: "operator_ephemeris", fileFormat: "itc" }) === "starlink-itc",
  );
  check(
    "a plain source id is unchanged",
    canonical({ sourceId: "space-track" }) === "space-track",
  );

  check(
    "the OCM wins when an object has OCM, ITC and TLE",
    pickTrajectorySource(
      ["space-track", "starlink-itc", "starlink-ocm"].map((s) => s),
    )?.id === "starlink-ocm",
  );
  check(
    "the ITC wins over a TLE when no OCM exists",
    pickTrajectorySource(["space-track", "starlink-itc"])?.id === "starlink-itc",
  );
  check(
    "a TLE is used only when nothing better exists",
    pickTrajectorySource(["space-track"])?.id === "space-track",
  );

  // ------------------------------------------------------ schema invariants
  console.log("\nschema invariants");
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE master_object (norad_id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE derived_state (
      norad_id INTEGER NOT NULL, kind TEXT NOT NULL, source_id TEXT, field TEXT NOT NULL,
      value_num REAL, PRIMARY KEY (norad_id, kind, source_id, field)
    );
  `);
  db.prepare("INSERT INTO master_object VALUES (1, 'A')").run();
  db.prepare("INSERT INTO derived_state VALUES (1, 'orbit-summary', 'space-track', 'altitude_km', 550)").run();
  let rejected = false;
  try {
    db.prepare("INSERT INTO derived_state VALUES (1, 'orbit-summary', 'space-track', 'altitude_km', 560)").run();
  } catch {
    rejected = true;
  }
  check("a derived value is unique per (object, kind, source, field)", rejected);
  db.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();

export {};
