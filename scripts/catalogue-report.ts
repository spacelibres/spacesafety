/**
 * Catalogue quality report.
 *
 * ## What this answers
 *
 * "Is the catalogue complete enough to screen against?" — not "did the build
 * finish". Those are different questions, and a build can finish with a table
 * silently empty (that happened twice: `object_physics` and `space_track_satcat`
 * were downloaded for days without an importer).
 *
 * ## Why alive and decayed are counted separately
 *
 * The catalogue has 72 311 objects but only 36 570 are still in orbit. Every
 * completeness percentage measured over the whole catalogue is depressed by
 * 35 741 re-entered objects that legitimately have no physical model and no
 * current orbit. Reporting one number hides that; reporting both shows where the
 * real gaps are.
 *
 *   npm run catalogue:report
 *   npm run catalogue:report -- --db data/catalogue.sqlite
 */

import { existsSync } from "node:fs";

import Database from "better-sqlite3";

interface FieldSpec {
  /** Column in `master_object`, or a subquery when `expr` is set. */
  column: string;
  label: string;
  expr?: string;
}

/** Identity and physical fields, in the order they matter for screening. */
const FIELDS: FieldSpec[] = [
  { column: "name", label: "名称" },
  { column: "norad_id", label: "NORAD 编号" },
  { column: "cospar_id", label: "COSPAR 编号", expr: "cospar_id IS NOT NULL AND cospar_id <> ''" },
  { column: "object_class", label: "目标分类", expr: "object_class IS NOT NULL AND object_class <> '' AND object_class <> 'Unknown'" },
  { column: "country", label: "发射国", expr: "country IS NOT NULL AND country <> ''" },
  { column: "launch_date", label: "发射日期", expr: "launch_date IS NOT NULL AND launch_date <> ''" },
  { column: "launch_site", label: "发射场", expr: "launch_site IS NOT NULL AND launch_site <> ''" },
  { column: "decay_date", label: "再入日期", expr: "decay_date IS NOT NULL AND decay_date <> ''" },
  { column: "mass_kg", label: "质量", expr: "mass_kg IS NOT NULL" },
  { column: "hard_body_radius_m", label: "硬体半径", expr: "hard_body_radius_m IS NOT NULL" },
  { column: "cross_section_avg_m2", label: "横截面积", expr: "cross_section_avg_m2 IS NOT NULL" },
  { column: "span_m", label: "翼展", expr: "span_m IS NOT NULL" },
  { column: "ballistic_coefficient", label: "弹道系数", expr: "ballistic_coefficient IS NOT NULL" },
  { column: "rcs_size", label: "RCS 分级", expr: "rcs_size IS NOT NULL AND rcs_size <> ''" },
  { column: "manufacturer", label: "制造商", expr: "manufacturer IS NOT NULL" },
  { column: "bus", label: "平台型号", expr: "bus IS NOT NULL" },
  { column: "orbit_type", label: "轨道类型", expr: "orbit_type IS NOT NULL" },
];

/** A row's status is either in orbit or re-entered; nothing else is meaningful. */
const ALIVE = "(decay_date IS NULL OR decay_date = '')";

function pct(n: number, of: number): string {
  return of === 0 ? "—" : `${((n / of) * 100).toFixed(2)}%`;
}

function bar(n: number, of: number, width = 28): string {
  if (of === 0) return "";
  const filled = Math.round((n / of) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function main(): void {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--db");
  const path = i === -1 ? "data/catalogue.sqlite" : argv[i + 1];

  if (!existsSync(path)) {
    console.error(`\n  编目库不存在：${path}\n  先运行 npm run catalogue:build\n`);
    process.exit(1);
  }

  const db = new Database(path, { readonly: true });

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN ${ALIVE} THEN 1 ELSE 0 END) AS alive,
              SUM(CASE WHEN NOT ${ALIVE} THEN 1 ELSE 0 END) AS decayed
         FROM master_object`,
    )
    .get() as { total: number; alive: number; decayed: number };

  console.log(`\n  编目库 ${path}\n`);
  console.log(`  对象总数   ${String(totals.total).padStart(7)}`);
  console.log(`    在轨     ${String(totals.alive).padStart(7)}   ${pct(totals.alive, totals.total)}`);
  console.log(`    已再入   ${String(totals.decayed).padStart(7)}   ${pct(totals.decayed, totals.total)}`);
  console.log(`\n  字段覆盖率（在轨对象 / 全库）\n`);
  console.log(`  ${"字段".padEnd(12)} ${"在轨".padStart(8)} ${"在轨占比".padStart(9)}   ${"全库".padStart(8)} ${"全库占比".padStart(9)}`);
  console.log(`  ${"─".repeat(62)}`);

  for (const f of FIELDS) {
    const cond = f.expr ?? `${f.column} IS NOT NULL`;
    const r = db
      .prepare(
        `SELECT SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END) AS all_,
                SUM(CASE WHEN ${cond} AND ${ALIVE} THEN 1 ELSE 0 END) AS alive_
           FROM master_object`,
      )
      .get() as { all_: number; alive_: number };
    const aliveN = r.alive_ ?? 0;
    const allN = r.all_ ?? 0;
    console.log(
      `  ${f.label.padEnd(12)} ${String(aliveN).padStart(8)} ${pct(aliveN, totals.alive).padStart(9)}   ${String(allN).padStart(8)} ${pct(allN, totals.total).padStart(9)}`,
    );
  }

  // ------------------------------------------------------------- breakdown
  console.log(`\n  分类构成（在轨）\n`);
  const classes = db
    .prepare(
      `SELECT COALESCE(NULLIF(object_class, ''), '未分类') AS cls, COUNT(*) AS n
         FROM master_object WHERE ${ALIVE}
        GROUP BY cls ORDER BY n DESC`,
    )
    .all() as Array<{ cls: string; n: number }>;
  for (const c of classes) {
    console.log(`  ${c.cls.padEnd(30)} ${String(c.n).padStart(6)}  ${bar(c.n, totals.alive)}`);
  }

  // ------------------------------------------------------------ source rows
  console.log(`\n  分源原始记录\n`);
  for (const table of [
    "satcat",
    "space_track_satcat",
    "discos_objects",
    "object_physics",
    "object_launch_info",
  ]) {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
    console.log(`  ${table.padEnd(22)} ${String(r.n).padStart(7)}   ${pct(r.n, totals.total)}`);
  }

  // ---------------------------------------------------------------- pruning
  // The gap that matters: objects still in orbit with no physical model. A
  // re-entered object without one is expected; an orbiting one is a real hole.
  const holes = db
    .prepare(
      `SELECT object_class AS cls, COUNT(*) AS n
         FROM master_object
        WHERE ${ALIVE} AND (mass_kg IS NULL OR hard_body_radius_m IS NULL)
        GROUP BY cls ORDER BY n DESC`,
    )
    .all() as Array<{ cls: string | null; n: number }>;
  const holeTotal = holes.reduce((a, h) => a + h.n, 0);

  console.log(`\n  在轨但缺物理模型：${holeTotal}\n`);
  for (const h of holes) {
    console.log(`  ${(h.cls ?? "未分类").padEnd(30)} ${String(h.n).padStart(6)}`);
  }

  const conflicts = db
    .prepare("SELECT field, COUNT(*) AS n FROM master_conflict GROUP BY field ORDER BY n DESC")
    .all() as Array<{ field: string; n: number }>;
  console.log(`\n  未决冲突\n`);
  if (conflicts.length === 0) console.log("  （无）");
  for (const c of conflicts) console.log(`  ${c.field.padEnd(22)} ${String(c.n).padStart(5)}`);

  const check = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  console.log(`\n  integrity_check ${check.integrity_check}\n`);

  db.close();
}

main();

export {};
