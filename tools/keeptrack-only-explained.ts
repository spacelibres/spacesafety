/**
 * Is every KeepTrack-only object one of Spacebook's analyst objects?
 *
 * ## The question this answers
 *
 * `catalogue-source-overlap.ts` reports 682 objects that only KeepTrack has among
 * the four numbered catalogues. Those objects are named `UNKNOWN` or
 * `TBA - TO BE ASSIGNED` by KeepTrack — it holds them without an identity. The
 * 1,112 analyst objects from Spacebook sit in provisional number blocks, and
 * KeepTrack lists many of the same numbers.
 *
 * If every one of the 682 is also an analyst object, then "KeepTrack-only" is not a
 * coverage gap: it is the same objects seen twice, once with an identity and once
 * without. If any are not, those are genuinely objects only KeepTrack tracks.
 *
 * Run: npx tsx tools/keeptrack-only-explained.ts
 */

import Database from "better-sqlite3";

const WIDE = process.env.SPACE_SAFETY_WIDE_DB ?? "data/catalogue-wide.sqlite";

function main(): void {
  const db = new Database(WIDE, { readonly: true });
  const cols = (db.prepare("SELECT name FROM pragma_table_info('catalogue_wide')").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
  const has = (s: string) => `(${cols.filter((n) => n.endsWith(`__${s}`)).map((n) => `${n} IS NOT NULL`).join(" OR ")})`;

  const ktOnly = `${has("keeptrack")} AND NOT ${has("spacetrack")} AND NOT ${has("spacebook")} AND NOT ${has("discos")}`;

  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM catalogue_wide WHERE ${ktOnly}`).get() as {
    total: number;
  };
  const { explained } = db
    .prepare(`SELECT COUNT(*) AS explained FROM catalogue_wide WHERE ${ktOnly} AND name__sbsup IS NOT NULL`)
    .get() as { explained: number };

  console.log(`\n  仅 KeepTrack 有数据          ${total}`);
  console.log(`  其中同时是分析型目标        ${explained}`);
  console.log(`  真正只有 KeepTrack 知道的    ${total - explained}`);

  if (total - explained > 0) {
    console.log("\n  真正独有的对象：\n");
    const rows = db
      .prepare(
        `SELECT norad_id, name__keeptrack, manufacturer__keeptrack, mass_kg__keeptrack, diameter_m__keeptrack
           FROM catalogue_wide WHERE ${ktOnly} AND name__sbsup IS NULL LIMIT 20`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const r of rows) console.log(`  ${JSON.stringify(r)}`);
  }

  // And the reverse: analyst objects that another catalogue also lists. Those are
  // the ones where Spacebook has an identity and someone else has an entry too.
  const { multiSource } = db
    .prepare(
      `SELECT COUNT(*) AS multiSource FROM catalogue_wide
        WHERE name__sbsup IS NOT NULL
          AND (${has("spacetrack")} OR ${has("spacebook")} OR ${has("discos")} OR ${has("keeptrack")})`,
    )
    .get() as { multiSource: number };
  console.log(`\n  分析型目标中另有其他来源也收录的  ${multiSource}`);

  db.close();
  console.log("");
}

main();
