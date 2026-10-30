/**
 * Break down the objects only KeepTrack lists, by what data it actually has.
 *
 * ## Why the counts disagreed
 *
 * `catalogue-source-overlap.ts` reported 682 KeepTrack-only objects while a query
 * on the source tables found 90. The difference is the definition: the wide table
 * counts a source as present when *any* of its 26 columns is non-null, and
 * KeepTrack writes a value into `name` for objects it cannot identify — the
 * strings `UNKNOWN` and `TBA - TO BE ASSIGNED`. So those objects are "present" in
 * the wide table and absent from the other three sources' tables at the same time.
 *
 * This prints the actual breakdown instead of leaving the discrepancy as a
 * footnote.
 *
 * Run: npx tsx tools/keeptrack-only-audit.ts
 */

import Database from "better-sqlite3";

const DB = process.env.SPACE_SAFETY_DB ?? "data/catalogue.sqlite";

const PLACEHOLDER_NAMES = `('UNKNOWN', 'TBA - TO BE ASSIGNED', 'UNKNOWN OBJECT')`;

function main(): void {
  const db = new Database(DB, { readonly: true });

  const onlyKeepTrack = `
    norad_id > 0
    AND norad_id NOT IN (SELECT norad_id FROM space_track_satcat)
    AND norad_id NOT IN (SELECT norad_id FROM satcat)
    AND norad_id NOT IN (SELECT norad_id FROM discos_objects)`;

  console.log("\n  KeepTrack 独有对象明细\n");

  const rows = db
    .prepare(
      `SELECT
         CASE
           WHEN name IS NULL AND launch_date IS NULL AND owner IS NULL THEN '全空（仅编号）'
           WHEN name IN ${PLACEHOLDER_NAMES} AND launch_date IS NULL AND owner IS NULL THEN '占位名 UNKNOWN/TBA'
           WHEN launch_date IS NULL AND owner IS NULL THEN '仅有名称'
           ELSE '有名称且有发射记录'
         END AS category,
         COUNT(*) AS n
       FROM keeptrack_object
       WHERE ${onlyKeepTrack}
       GROUP BY 1 ORDER BY n DESC`,
    )
    .all() as Array<{ category: string; n: number }>;

  let total = 0;
  for (const r of rows) {
    console.log(`  ${r.category.padEnd(24)}${String(r.n).padStart(6)}`);
    total += r.n;
  }
  console.log(`  ${"合计".padEnd(24)}${String(total).padStart(6)}`);

  console.log("\n  占位名的具体取值\n");
  const names = db
    .prepare(
      `SELECT COALESCE(name, '(NULL)') AS name, COUNT(*) AS n
         FROM keeptrack_object WHERE ${onlyKeepTrack}
        GROUP BY 1 ORDER BY n DESC LIMIT 8`,
    )
    .all() as Array<{ name: string; n: number }>;
  for (const r of names) console.log(`  ${r.name.padEnd(28)}${String(r.n).padStart(6)}`);

  // The numbered range says where these come from: a contiguous block is a
  // provisional-number assignment, scattered numbers are ordinary catalogue entries
  // that never got a name.
  console.log("\n  编号分布\n");
  const ranges = db
    .prepare(
      `SELECT (norad_id / 10000) * 10000 AS lo, COUNT(*) AS n
         FROM keeptrack_object WHERE ${onlyKeepTrack}
        GROUP BY 1 ORDER BY lo`,
    )
    .all() as Array<{ lo: number; n: number }>;
  for (const r of ranges) console.log(`  ${String(r.lo).padStart(6)}–${String(r.lo + 9999).padStart(6)}  ${String(r.n).padStart(6)}`);

  // Do any of them have an element set? Without one they cannot be propagated and
  // are catalogue rows with nothing to compute from.
  console.log("\n  是否有轨道根数\n");
  const withTle = db
    .prepare(
      `SELECT SUM(CASE WHEN tle_epoch IS NOT NULL THEN 1 ELSE 0 END) AS hasTle,
              COUNT(*) AS total
         FROM keeptrack_object WHERE ${onlyKeepTrack}`,
    )
    .get() as { hasTle: number; total: number };
  console.log(`  有 TLE  ${withTle.hasTle} / ${withTle.total}`);

  db.close();
  console.log("");
}

main();
