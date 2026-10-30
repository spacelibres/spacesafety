/**
 * What the objects without a hard-body radius actually are.
 *
 * ## Why the first audit was not enough
 *
 * `hbr-gap-audit.ts` showed 1,539 in-orbit objects with no hard-body radius and
 * only 2 that could be derived from a cross-section. That is a real gap, but "1,539
 * objects" says nothing about whether it can be closed: if they are debris from six
 * break-ups, the fix is six events; if they are analyst objects, no source will
 * ever have a radius for them.
 *
 * Run: npx tsx tools/hbr-gap-detail.ts
 */

import Database from "better-sqlite3";

const WIDE = process.env.SPACE_SAFETY_WIDE_DB ?? "data/catalogue-wide.sqlite";

function main(): void {
  const db = new Database(WIDE, { readonly: true });

  const decayed = `COALESCE(decay_date__spacetrack, decay_date__spacebook, decay_date__discos, decay_date__keeptrack, '') <> ''`;
  const gap = `hard_body_radius_m__chosen IS NULL AND NOT (${decayed})`;

  console.log("\n  在轨但缺硬体半径的对象，按分类\n");
  const byClass = db
    .prepare(
      `SELECT COALESCE(object_class__spacetrack, object_class__spacebook, object_class__discos, object_class__keeptrack, '(无分类)') AS cls,
              COUNT(*) AS n
         FROM catalogue_wide WHERE ${gap}
        GROUP BY 1 ORDER BY n DESC`,
    )
    .all() as Array<{ cls: string; n: number }>;
  for (const r of byClass) console.log(`  ${r.cls.padEnd(20)}${String(r.n).padStart(6)}`);

  console.log("\n  按来源：这批对象是谁收录的\n");
  const cols = (
    db.prepare("SELECT name FROM pragma_table_info('catalogue_wide')").all() as Array<{ name: string }>
  ).map((r) => r.name);
  const has = (s: string) => `(${cols.filter((n) => n.endsWith(`__${s}`)).map((n) => `${n} IS NOT NULL`).join(" OR ")})`;
  const combo = db
    .prepare(
      `SELECT
         CASE WHEN ${has("sbsup")} THEN '分析型目标'
              WHEN ${has("keeptrack")} AND NOT ${has("spacetrack")} THEN '仅 KeepTrack'
              WHEN ${has("spacetrack")} THEN '有 Space-Track 记录'
              ELSE '其他' END AS src, COUNT(*) AS n
         FROM catalogue_wide WHERE ${gap} GROUP BY 1 ORDER BY n DESC`,
    )
    .all() as Array<{ src: string; n: number }>;
  for (const r of combo) console.log(`  ${r.src.padEnd(20)}${String(r.n).padStart(6)}`);

  console.log("\n  样本\n");
  const rows = db
    .prepare(
      `SELECT norad_id,
              COALESCE(name__spacebook, name__keeptrack, name__spacetrack) AS name,
              COALESCE(object_class__spacebook, object_class__keeptrack, object_class__spacetrack) AS cls,
              COALESCE(cospar_id__spacebook, cospar_id__keeptrack, cospar_id__spacetrack) AS intl,
              COALESCE(manufacturer__spacebook, manufacturer__keeptrack) AS maker,
              diameter_m__chosen AS dia,
              cross_section_avg_m2__chosen AS xsec
         FROM catalogue_wide WHERE ${gap} ORDER BY norad_id LIMIT 20`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const r of rows) {
    console.log(`  ${String(r.norad_id).padStart(6)}  ${String(r.name ?? "—").slice(0, 26).padEnd(26)} ${String(r.cls ?? "—").padEnd(11)} ${String(r.intl ?? "—").padEnd(11)} maker=${r.maker ?? "—"}`);
  }

  // Is the gap concentrated in one manufacturer or bus? That would mean a single
  // model is missing rather than thousands of individual ones.
  console.log("\n  制造商分布（前 10）\n");
  const makers = db
    .prepare(
      `SELECT COALESCE(manufacturer__spacebook, manufacturer__keeptrack, '(未知)') AS maker, COUNT(*) AS n
         FROM catalogue_wide WHERE ${gap} GROUP BY 1 ORDER BY n DESC LIMIT 10`,
    )
    .all() as Array<{ maker: string; n: number }>;
  for (const r of makers) console.log(`  ${r.maker.padEnd(24)}${String(r.n).padStart(6)}`);

  db.close();
  console.log("");
}

main();
