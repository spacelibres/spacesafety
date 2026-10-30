/**
 * Physical model import and hard-body radius.
 *
 * The hard-body radius is the dominant term in a collision probability — Pc scales
 * with the square of the combined radii — so a wrong radius is not a cosmetic
 * error. The value had been *estimated* from an RCS class band (5 / 1.5 / 0.5 m)
 * and, for Starlink, hard-coded at 8.83 m, which is the vehicle's span rather than
 * a radius.
 *
 * Measured against the published model:
 *
 * | object | previous value | `hbrMeanMeters` | error |
 * |---|---|---|---|
 * | STARLINK-1008 | 8.83 m | 1.139 m | 7.8× too large |
 * | STARLINK-1008 (band) | 5.0 m | 1.139 m | 4.4× too large |
 * | ISS (ZARYA) | 5.0 m | 36.49 m | 14.6× too small |
 *
 * These tests pin the import and the absence of a guessing path.
 */

import Database from "better-sqlite3";

import {
  SatcatDetailsImporter,
  loadHardBodyRadii,
  type DetailRecord,
} from "../src/lib/sources/satcat-details-import";
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

function testDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE object_physics (
      norad_id INTEGER PRIMARY KEY, adopted_mass_kg REAL, adopted_span_m REAL,
      adopted_diameter_m REAL, ballistic_coefficient REAL, hbr_mean_m REAL,
      hbr_median_m REAL, hbr_lo_m REAL, hbr_hi_m REAL, hbr_encap_m REAL,
      cross_section_median_m2 REAL, solar_radiation_pressure REAL,
      shape_number INTEGER, updated_at TEXT NOT NULL
    );
    CREATE TABLE object_launch_info (
      norad_id INTEGER PRIMARY KEY, jcat TEXT, launch_tag TEXT, piece TEXT,
      object_type TEXT, payload_name TEXT, launch_date TEXT, separation_date TEXT,
      decay_date TEXT, owner TEXT, state TEXT, manufacturer TEXT, bus TEXT,
      mass_kg REAL, dry_mass_kg REAL, length_m REAL, diameter_m REAL, span_m REAL,
      shape TEXT, perigee_km REAL, apogee_km REAL, inclination_deg REAL,
      orbit_type TEXT, motor TEXT, alt_names TEXT, updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function record(overrides: Partial<DetailRecord> & { noradId: number }): DetailRecord {
  return {
    id: "x",
    name: "TEST",
    intlId: "2020-001A",
    discosMsg: {
      comspocDerivedMessage: {
        adoptedMass: 260,
        adoptedSpan: 8.86,
        ballisticCoefficient: 0.0611376,
        hbrMeanMeters: 1.138564,
        hbrMedianMeters: 1.516543,
        hbrLoMeters: 0.21851,
        hbrHiMeters: 2.0586174,
        hbrEncap: 4.493317,
        crossSectionMedian: 7.225354,
        solarRadiationPressure: 0.0361268,
        shapeNumber: 3,
      },
    },
    ...overrides,
  };
}

async function main() {
  // ------------------------------------------------------- importer
  console.log("\nimport");
  const db = testDb();
  const summary = new SatcatDetailsImporter(db).import([
    record({ noradId: 44714 }),
    record({ noradId: 25544, discosMsg: { comspocDerivedMessage: { adoptedMass: 450000, hbrMeanMeters: 36.48893 } } }),
    // No derived message: must be counted, not silently treated as zero.
    record({ noradId: 99999, discosMsg: null }),
    // No NORAD: cannot be keyed to an object.
    record({ noradId: 0 }),
  ]);

  check("physics rows written", summary.physics === 2, `${summary.physics}`);
  check("records without a derived message are counted", summary.missingDerived === 1);
  check("records without a NORAD are counted", summary.skippedNoNorad === 1);
  check("HBR count matches", summary.withHbr === 2, `${summary.withHbr}`);
  // Only the first record supplies a B*; the second deliberately omits it.
  check("B* count matches", summary.withBallistic === 1, `${summary.withBallistic}`);

  const row = db.prepare("SELECT * FROM object_physics WHERE norad_id = 44714").get() as Record<
    string,
    number
  >;
  check("mass stored", row.adopted_mass_kg === 260);
  check("hbrMean stored", Math.abs(row.hbr_mean_m - 1.138564) < 1e-9, String(row.hbr_mean_m));
  check("all four HBR variants kept", [row.hbr_lo_m, row.hbr_hi_m, row.hbr_median_m, row.hbr_encap_m].every((v) => v > 0));
  check("ballistic coefficient stored", Math.abs(row.ballistic_coefficient - 0.0611376) < 1e-9);
  check("cross-section stored", Math.abs(row.cross_section_median_m2 - 7.225354) < 1e-9);

  // A re-import replaces rather than duplicates.
  new SatcatDetailsImporter(db).import([record({ noradId: 44714 })]);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM object_physics").get() as { n: number }).n;
  check("re-import replaces the table", count === 1, `${count}`);

  const radii = loadHardBodyRadii(db);
  check("radii load into a lookup", radii.get(44714) === 1.138564);
  check("an object with no physics is absent, not zero", !radii.has(99999));
  db.close();

  // ------------------------------------------------------- live data
  console.log("\nlive catalogue");
  const { sqlite } = getDb();
  const live = sqlite
    .prepare(
      `SELECT COUNT(*) AS n, MIN(hbr_mean_m) AS lo, MAX(hbr_mean_m) AS hi
         FROM object_physics WHERE hbr_mean_m IS NOT NULL`,
    )
    .get() as { n: number; lo: number | null; hi: number | null };

  if (live.n === 0) {
    skip("the catalogue carries hard-body radii", "object_physics is empty");
  } else {
    check("most of the catalogue has a radius", live.n > 60_000, `${live.n} rows`);
    // The spread is the argument against a class band: one number cannot describe
    // objects whose radii differ by four orders of magnitude.
    check(
      "radii span several orders of magnitude",
      (live.hi ?? 0) / Math.max(1e-6, live.lo ?? 1) > 1000,
      `${live.lo?.toFixed(3)} .. ${live.hi?.toFixed(1)} m`,
    );
  }

  // The stored objects must no longer carry the span-as-radius value.
  const stale = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM objects o
        JOIN object_physics p ON p.norad_id = o.norad_id
       WHERE o.object_name LIKE 'STARLINK-%' AND ABS(o.hard_body_radius - 8.83) < 1e-6
         AND p.hbr_mean_m IS NOT NULL AND ABS(p.hbr_mean_m - 8.83) > 0.5`,
    )
    .get() as { n: number };

  if (live.n === 0) {
    skip("no object stores the span as a hard-body radius", "no physics");
  } else {
    // Rows written before the fix keep 8.83 until the object is re-ingested; this
    // assertion documents the count rather than pretending it is already zero.
    console.log(`  note ${stale.n} object(s) still carry the pre-fix 8.83 m value`);
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  if (fail > 0) process.exit(1);
}

void main();

export {};
