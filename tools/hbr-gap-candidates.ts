/**
 * The 337 catalogue objects that are in Space-Track, still in orbit, and have no
 * hard-body radius anywhere — and what the other sources do hold for them.
 *
 * ## Why this is the only part of the gap worth working on
 *
 * Of the 1,539 in-orbit objects without a radius:
 *
 *   1,111  analyst objects. Their identity is unknown to everyone; no source will
 *          ever publish a physical model for a provisional number.
 *     337  in Space-Track with a real identity.
 *      91  known only to KeepTrack or DISCOS.
 *
 * Only the 337 have a name and a launch, so only they are candidates for a radius
 * from a model or a measurement.
 *
 * Run: npx tsx tools/hbr-gap-candidates.ts
 */

import Database from "better-sqlite3";
import { resolve } from "node:path";

const WIDE = process.env.SPACE_SAFETY_WIDE_DB ?? "data/catalogue-wide.sqlite";
const BASE = process.env.SPACE_SAFETY_DB ?? "data/catalogue.sqlite";

function main(): void {
  const db = new Database(WIDE, { readonly: true });
  // ATTACH resolves a relative path against the main database's directory, so the
  // base catalogue must be given as an absolute path here.
  db.exec(`ATTACH DATABASE '${resolve(BASE).replace(/'/g, "''")}' AS base`);

  const decayed = `COALESCE(decay_date__spacetrack, decay_date__spacebook, decay_date__discos, decay_date__keeptrack, '') <> ''`;
  const gap = `hard_body_radius_m__chosen IS NULL AND NOT (${decayed})`;
  const inSt = `(name__spacetrack IS NOT NULL OR cospar_id__spacetrack IS NOT NULL)`;

  console.log("\n  Space-Track 有记录、在轨、缺硬体半径\n");

  // What do they look like?
  const byClass = db
    .prepare(
      `SELECT COALESCE(object_class__spacetrack, '(无分类)') AS cls, COUNT(*) AS n
         FROM catalogue_wide WHERE ${gap} AND ${inSt} GROUP BY 1 ORDER BY n DESC`,
    )
    .all() as Array<{ cls: string; n: number }>;
  for (const r of byClass) console.log(`  ${r.cls.padEnd(16)}${String(r.n).padStart(5)}`);

  // Which of them do the other sources even know? A row that DISCOS has but with no
  // radius is a different problem from a row only Space-Track has.
  console.log("\n  其他来源是否收录\n");
  const known = db
    .prepare(
      `SELECT
         SUM(CASE WHEN name__spacebook IS NOT NULL THEN 1 ELSE 0 END) AS sb,
         SUM(CASE WHEN name__discos IS NOT NULL THEN 1 ELSE 0 END) AS ds,
         SUM(CASE WHEN name__keeptrack IS NOT NULL THEN 1 ELSE 0 END) AS kt,
         COUNT(*) AS total
       FROM catalogue_wide WHERE ${gap} AND ${inSt}`,
    )
    .get() as { sb: number; ds: number; kt: number; total: number };
  console.log(`  合计 ${known.total}`);
  console.log(`  Spacebook 有  ${known.sb}`);
  console.log(`  DISCOS 有     ${known.ds}`);
  console.log(`  KeepTrack 有  ${known.kt}`);

  // Do any of them have a shape or diameter from another source that a radius could
  // be derived from? A sphere of equal projected area is the standard derivation.
  console.log("\n  可用其他字段推算的\n");
  const derivable = db
    .prepare(
      `SELECT
         SUM(CASE WHEN cross_section_avg_m2__discos IS NOT NULL THEN 1 ELSE 0 END) AS dsXsec,
         SUM(CASE WHEN cross_section_avg_m2__spacebook IS NOT NULL THEN 1 ELSE 0 END) AS sbXsec,
         SUM(CASE WHEN diameter_m__discos IS NOT NULL THEN 1 ELSE 0 END) AS dsDia,
         SUM(CASE WHEN diameter_m__keeptrack IS NOT NULL THEN 1 ELSE 0 END) AS ktDia,
         SUM(CASE WHEN diameter_m__spacebook IS NOT NULL THEN 1 ELSE 0 END) AS sbDia
       FROM catalogue_wide WHERE ${gap} AND ${inSt}`,
    )
    .get() as Record<string, number>;
  for (const [k, v] of Object.entries(derivable)) console.log(`  ${k.padEnd(10)}${v}`);

  console.log("\n  这 337 个按星座\n");
  const constells = db
    .prepare(
      `SELECT cls.constellation, COUNT(*) AS n
         FROM catalogue_wide w
         LEFT JOIN base.object_classification cls ON cls.norad_id = w.norad_id
        WHERE ${gap} AND ${inSt}
        GROUP BY 1 ORDER BY n DESC LIMIT 10`,
    )
    .all() as Array<{ constellation: string | null; n: number }>;
  for (const r of constells) console.log(`  ${(r.constellation ?? "(无星座)").padEnd(18)}${String(r.n).padStart(5)}`);

  db.close();
  console.log("");
}

main();
