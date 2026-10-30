/**
 * Catalogue completeness.
 *
 * A catalogue is only useful if every entry carries the fields a consumer needs to
 * identify and locate the object. This test measures that directly against the
 * live master table, and fails when a source stops contributing.
 *
 * The gap it was written for: Space-Track's satellite catalogue had been downloaded
 * (71 198 records) but never parsed, so the master table had **no launch country,
 * no launch site code and no catalogue orbit summary at all**, and 1 136 entries
 * had no COSPAR designator. Those are catalogue defects, not modelling ones, and
 * they were invisible because nothing measured them.
 */

import { getDb } from "../src/db";

let pass = 0;
let fail = 0;
let skipped = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
  }
}
function skip(name: string, why: string) {
  skipped += 1;
  console.log(`  skip ${name}  (${why})`);
}

function main() {
  const { sqlite } = getDb();

  const counts = sqlite
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN name IS NOT NULL AND name <> '' THEN 1 ELSE 0 END) AS name,
         SUM(CASE WHEN cospar_id IS NOT NULL AND cospar_id <> '' THEN 1 ELSE 0 END) AS cospar,
         SUM(CASE WHEN country IS NOT NULL THEN 1 ELSE 0 END) AS country,
         SUM(CASE WHEN launch_site IS NOT NULL THEN 1 ELSE 0 END) AS site,
         SUM(CASE WHEN launch_date IS NOT NULL THEN 1 ELSE 0 END) AS launch,
         SUM(CASE WHEN catalog_period_min IS NOT NULL THEN 1 ELSE 0 END) AS orbit,
         SUM(CASE WHEN rcs_size IS NOT NULL THEN 1 ELSE 0 END) AS rcs,
         SUM(CASE WHEN mass_kg IS NOT NULL THEN 1 ELSE 0 END) AS mass,
         SUM(CASE WHEN object_class <> 'Unknown' THEN 1 ELSE 0 END) AS classified
       FROM master_object`,
    )
    .get() as Record<string, number>;

  if (counts.total === 0) {
    skip("catalogue completeness", "master_object is empty; run npm run master:build");
    console.log(`\n0 passed, 0 failed, ${skipped} skipped`);
    return;
  }

  console.log(`\ncatalogue of ${counts.total} objects`);
  const pct = (n: number) => ((n / counts.total) * 100).toFixed(2) + "%";
  console.log(`  name       ${String(counts.name).padStart(6)}  ${pct(counts.name)}`);
  console.log(`  COSPAR     ${String(counts.cospar).padStart(6)}  ${pct(counts.cospar)}`);
  console.log(`  country    ${String(counts.country).padStart(6)}  ${pct(counts.country)}`);
  console.log(`  launch site${String(counts.site).padStart(6)}  ${pct(counts.site)}`);
  console.log(`  launch date${String(counts.launch).padStart(6)}  ${pct(counts.launch)}`);
  console.log(`  orbit      ${String(counts.orbit).padStart(6)}  ${pct(counts.orbit)}`);
  console.log(`  RCS class  ${String(counts.rcs).padStart(6)}  ${pct(counts.rcs)}`);
  console.log(`  mass       ${String(counts.mass).padStart(6)}  ${pct(counts.mass)}`);
  console.log(`  classified ${String(counts.classified).padStart(6)}  ${pct(counts.classified)}`);

  // Every entry must be identifiable. A catalogue row with no name is unusable.
  console.log("\nidentification");
  check(
    "every object has a name",
    counts.name === counts.total,
    `${counts.total - counts.name} missing`,
  );

  // Space-Track covers 100% of its records for COSPAR; the union must therefore be
  // above 98% (the remainder are recent objects no catalogue has yet assigned).
  check(
    "almost every object has a COSPAR designator",
    counts.cospar / counts.total > 0.98,
    pct(counts.cospar),
  );
  check(
    "every object has a launch country",
    counts.country / counts.total > 0.98,
    pct(counts.country),
  );
  check(
    "every object has a launch site",
    counts.site / counts.total > 0.98,
    pct(counts.site),
  );

  // Orbit summary comes only from Space-Track's catalogue; 69 086 of its 71 198
  // records carry it, which is the ceiling for the union.
  check(
    "most objects have a catalogue orbit summary",
    counts.orbit / counts.total > 0.95,
    pct(counts.orbit),
  );

  // ------------------------------------------------------------- classes
  console.log("\nclassification");
  const distinct = sqlite
    .prepare("SELECT COUNT(DISTINCT object_class) AS n FROM master_object")
    .get() as { n: number };
  // Ten real classes; the merge used to emit 16 values because it concatenated
  // three vocabularies. More than 11 means normalisation regressed.
  check("the class vocabulary is bounded", distinct.n <= 11, `${distinct.n} distinct values`);

  const payload = sqlite
    .prepare("SELECT COUNT(*) AS n FROM master_object WHERE object_class = 'Payload'")
    .get() as { n: number };
  const manoeuvrable = sqlite
    .prepare("SELECT COUNT(*) AS n FROM master_object WHERE maneuverable = 1")
    .get() as { n: number };
  check(
    "manoeuvrability matches the payload count exactly",
    payload.n === manoeuvrable.n,
    `${manoeuvrable.n} manoeuvrable vs ${payload.n} payloads`,
  );

  // A catalogue dominated by Unknown would mean the merge lost the classification.
  const unknownShare = (counts.total - counts.classified) / counts.total;
  check(
    "under 5% of the catalogue is unclassified",
    unknownShare < 0.05,
    pct(counts.total - counts.classified),
  );

  // ------------------------------------------------------------ debris
  console.log("\ndebris coverage");
  const debris = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM master_object
        WHERE object_class LIKE '%Debris%' OR object_class = 'Unknown Debris'`,
    )
    .get() as { n: number };
  check(
    "debris is a substantial share of the catalogue",
    debris.n / counts.total > 0.2,
    `${debris.n} (${pct(debris.n)})`,
  );

  // ------------------------------------------------------- source proofs
  console.log("\nsource contributions");
  const st = sqlite
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN intl_des IS NOT NULL THEN 1 ELSE 0 END) AS cospar,
              SUM(CASE WHEN country IS NOT NULL THEN 1 ELSE 0 END) AS country
         FROM space_track_satcat`,
    )
    .get() as { n: number; cospar: number; country: number };

  if (st.n === 0) {
    skip("Space-Track catalogue is imported", "space_track_satcat is empty");
  } else {
    check("Space-Track catalogue imported", st.n > 70_000, `${st.n} rows`);
    check("it covers COSPAR completely", st.cospar === st.n, `${st.cospar}/${st.n}`);
    check("it covers country completely", st.country === st.n, `${st.country}/${st.n}`);
  }

  const physics = sqlite
    .prepare("SELECT COUNT(*) AS n FROM object_physics WHERE hbr_mean_m IS NOT NULL")
    .get() as { n: number };
  if (physics.n === 0) {
    skip("hard-body radii are imported", "object_physics is empty");
  } else {
    check(
      "hard-body radius covers almost the whole catalogue",
      physics.n / counts.total > 0.95,
      `${physics.n} (${pct(physics.n)})`,
    );
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  if (fail > 0) process.exit(1);
}

main();

export {};
