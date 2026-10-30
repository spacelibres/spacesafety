/**
 * Where the catalogue still has no hard-body radius, and whether any source could
 * supply it.
 *
 * ## Why hard-body radius matters most
 *
 * It is the single geometric quantity a collision probability is computed from: the
 * combined hard-body radius of two objects sets the area that, if the miss vector
 * ends inside it, counts as a collision. A catalogue missing it for a third of its
 * objects cannot compute Pc for a third of its possible pairs.
 *
 * ## What this measures
 *
 * Not just the total gap, but the shape of it — by object class and by whether the
 * object is still in orbit. A gap concentrated in debris already decayed matters
 * little; the same gap among live payloads matters a great deal.
 *
 * Run: npx tsx tools/hbr-gap-audit.ts
 */

import Database from "better-sqlite3";

const WIDE = process.env.SPACE_SAFETY_WIDE_DB ?? "data/catalogue-wide.sqlite";
const DB = process.env.SPACE_SAFETY_DB ?? "data/catalogue.sqlite";

function main(): void {
  const db = new Database(WIDE, { readonly: true });
  db.exec(`ATTACH DATABASE '${DB.replace(/'/g, "''")}' AS base`);

  const cols = (
    db.prepare("SELECT name FROM pragma_table_info('catalogue_wide')").all() as Array<{ name: string }>
  ).map((r) => r.name);

  const total = (db.prepare("SELECT COUNT(*) AS n FROM catalogue_wide").get() as { n: number }).n;
  const withHbr = (
    db.prepare("SELECT COUNT(*) AS n FROM catalogue_wide WHERE hard_body_radius_m__chosen IS NOT NULL").get() as {
      n: number;
    }
  ).n;

  console.log("\n  硬体半径覆盖\n");
  console.log(`  全部对象        ${total}`);
  console.log(`  有值            ${withHbr}  ${((withHbr / total) * 100).toFixed(1)}%`);
  console.log(`  缺失            ${total - withHbr}  ${(((total - withHbr) / total) * 100).toFixed(1)}%`);

  // Which source supplies it at all? If only one ever does, the gap is that
  // source's coverage and no amount of cross-checking will fill it.
  console.log("\n  各来源提供硬体半径的行数\n");
  for (const s of ["spacetrack", "spacebook", "discos", "keeptrack", "sbsup"]) {
    const c = `hard_body_radius_m__${s}`;
    if (!cols.includes(c)) continue;
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM catalogue_wide WHERE ${c} IS NOT NULL`).get() as { n: number })
      .n;
    console.log(`  ${s.padEnd(12)}${String(n).padStart(8)}`);
  }

  // The gap's shape: by object class, and split by whether the object is still up.
  const decayed = `COALESCE(decay_date__chosen, '') <> ''`;
  console.log("\n  缺失按目标分类\n");
  const byClass = db
    .prepare(
      `SELECT COALESCE(object_class__chosen, '(未知)') AS cls,
              COUNT(*) AS total,
              SUM(CASE WHEN hard_body_radius_m__chosen IS NULL THEN 1 ELSE 0 END) AS missing
         FROM catalogue_wide
        GROUP BY 1 ORDER BY missing DESC`,
    )
    .all() as Array<{ cls: string; total: number; missing: number }>;
  for (const r of byClass) {
    const pct = r.total ? ((r.missing / r.total) * 100).toFixed(1) : "0.0";
    console.log(`  ${r.cls.padEnd(16)}${String(r.missing).padStart(7)} / ${String(r.total).padStart(7)}  ${pct}%`);
  }

  console.log(`\n  缺失中已再入的（不影响在轨计算）\n`);
  const gapSplit = db
    .prepare(
      `SELECT SUM(CASE WHEN ${decayed} THEN 1 ELSE 0 END) AS decayedGap,
              SUM(CASE WHEN NOT (${decayed}) THEN 1 ELSE 0 END) AS liveGap
         FROM catalogue_wide WHERE hard_body_radius_m__chosen IS NULL`,
    )
    .get() as { decayedGap: number; liveGap: number };
  console.log(`  已再入   ${gapSplit.decayedGap}`);
  console.log(`  仍在轨   ${gapSplit.liveGap}   <- 这部分才影响 Pc 计算`);

  // Can the radius be derived? A sphere of the average cross-section gives an
  // equivalent radius, and DISCOS/Spacebook both carry cross-section for objects
  // whose radius is missing. Measuring how many gaps that would close is the only
  // way to know whether the derivation is worth having.
  console.log("\n  缺失的对象里，能否用横截面积推算\n");
  const derivable = db
    .prepare(
      `SELECT COUNT(*) AS n FROM catalogue_wide
        WHERE hard_body_radius_m__chosen IS NULL
          AND NOT (${decayed})
          AND (cross_section_avg_m2__chosen IS NOT NULL OR diameter_m__chosen IS NOT NULL)`,
    )
    .get() as { n: number };
  console.log(`  有横截面积或直径可推算  ${derivable.n}`);
  console.log(`  仍需外部数据           ${gapSplit.liveGap - derivable.n}`);

  db.close();
  console.log("");
}

main();
