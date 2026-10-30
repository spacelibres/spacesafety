/**
 * The wide-catalogue query must run against the real schema.
 *
 * ## Why this test exists
 *
 * The `/catalogue` page returned 500 twice from the same cause: the query named
 * `cls.object_classification` after the `cls` alias had been removed, and selected
 * an unqualified `norad_id` from two joined tables. Both are textbook SQL errors —
 * and both survived because nothing ever executed the query outside a browser
 * request. A build passes, `tsc` passes, the page only breaks when opened.
 *
 * This runs the exact statements against the built wide catalogue and the base
 * catalogue, so schema drift fails here instead of in the UI.
 *
 * It skips cleanly when the data files are absent: a checkout without them cannot
 * test a query that needs them, and failing would only train people to ignore it.
 *
 * Run: npm run test:wide
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import Database from "better-sqlite3";

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${(err as Error).message}`);
    failed += 1;
  }
}

const WIDE = "data/catalogue-wide.sqlite";
const BASE = process.env.SPACE_SAFETY_DB ?? "data/catalogue.sqlite";

console.log("\n宽表查询与库结构一致性\n");

if (!existsSync(WIDE) || !existsSync(BASE)) {
  console.log(`  skip  缺少 ${WIDE} 或 ${BASE}，先运行宽表构建\n`);
  process.exit(0);
}

const sqlite = new Database(BASE);
sqlite.exec(`ATTACH DATABASE '${WIDE.replace(/'/g, "''")}' AS wide`);

const tables = (schema: string): Set<string> => {
  const rows = sqlite.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table'`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
};

const wideTables = tables("wide");
const baseTables = tables("main");

check("宽表文件中有 catalogue_wide", () => {
  assert.ok(wideTables.has("catalogue_wide"), "catalogue_wide 不存在");
});

check("主库中有 object_classification", () => {
  assert.ok(baseTables.has("object_classification"), "object_classification 不存在，先运行 catalogue:classify");
});

check("keeptrack_object 存在（第四数据源）", () => {
  assert.ok(baseTables.has("keeptrack_object"), "keeptrack_object 缺失");
});

check("宽表含五个来源的列", () => {
  const cols = (sqlite.prepare("PRAGMA wide.table_info(catalogue_wide)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  for (const src of ["spacetrack", "spacebook", "discos", "keeptrack", "sbsup"]) {
    assert.ok(
      cols.some((c) => c.endsWith(`__${src}`)),
      `缺少 __${src} 列——该来源在页面会整列消失`,
    );
  }
});

/**
 * Coverage must be counted as an OR over all five sources.
 *
 * The catalogue page used to print `Math.max()` of three sources as the
 * "combined" figure. The sources hold *different objects*, so that is not a union
 * at all: it reported 17.5% for diameter where 41.5% of objects have one, and
 * 50.4% for decay dates where 97.3% do — understating the catalogue while looking
 * perfectly reasonable. These assertions fail if the union is ever taken from the
 * widest single column instead of from the data.
 */
check("覆盖率的并集按 OR 计算，不等于单源最大值", () => {
  const sources = ["spacetrack", "spacebook", "discos", "keeptrack", "sbsup"];
  const fields = ["diameter_m", "decay_date", "inclination_deg", "name"];
  for (const field of fields) {
    const counts = sources.map(
      (s) =>
        (
          sqlite
            .prepare(
              `SELECT COUNT(*) AS n FROM wide.catalogue_wide
                WHERE "${field}__${s}" IS NOT NULL AND "${field}__${s}" <> ''`,
            )
            .get() as { n: number }
        ).n,
    );
    const union = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM wide.catalogue_wide
            WHERE ${sources
              .map((s) => `("${field}__${s}" IS NOT NULL AND "${field}__${s}" <> '')`)
              .join(" OR ")}`,
        )
        .get() as { n: number }
    ).n;
    const widest = Math.max(...counts);
    assert.ok(
      union > widest,
      `${field}: 并集 ${union} 应严格大于单源最大 ${widest}（${sources
        .map((s, i) => `${s}=${counts[i]}`)
        .join(", ")}）`,
    );
  }
});

// The list query, copied from `listWideObjects` minus the dynamic WHERE clause.
// Kept as a literal so that a change to the source query must also change this.
const LIST_SQL = `
  SELECT catalogue_wide.norad_id AS noradId,
         cls.constellation AS constellation,
         cls.regime AS regime,
         cls.purpose_group AS purposeGroup
    FROM wide.catalogue_wide
    LEFT JOIN object_classification cls ON cls.norad_id = catalogue_wide.norad_id
   ORDER BY catalogue_wide.norad_id
   LIMIT ? OFFSET ?`;

check("列表查询可执行（列名、JOIN、排序均无歧义）", () => {
  const rows = sqlite.prepare(LIST_SQL).all(5, 0) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 5);
});

check("详情查询可执行", () => {
  const row = sqlite.prepare("SELECT norad_id, name__spacetrack FROM wide.catalogue_wide WHERE norad_id = ?").get(5);
  assert.ok(row, "NORAD 5 应存在");
});

check("按 NORAD 过滤的 WHERE 使用限定列名", () => {
  const sql = `${LIST_SQL.replace("ORDER BY", "WHERE catalogue_wide.norad_id = ? ORDER BY")} `;
  const rows = sqlite.prepare(sql).all(5, 1, 0) as unknown[];
  assert.equal(rows.length, 1);
});

check("分类表能按 norad_id 联上宽表", () => {
  const n = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM wide.catalogue_wide w
           JOIN object_classification c ON c.norad_id = w.norad_id`,
      )
      .get() as { n: number }
  ).n;
  assert.ok(n > 60_000, `联表结果 ${n}，预期 > 60000`);
});

check("轨道类型取值在允许集合内", () => {
  const bad = sqlite
    .prepare(
      `SELECT DISTINCT regime FROM object_classification
        WHERE regime NOT IN ('LEO','MEO','GEO','HEO','UNKNOWN')`,
    )
    .all() as Array<{ regime: string }>;
  assert.equal(bad.length, 0, `非法取值：${bad.map((b) => b.regime).join(", ")}`);
});

// ---------------------------------------------------- browse facet queries
// The facet query concatenates a WHERE fragment conditionally; an empty fragment
// produced `near "c": syntax error` in the browser instead of at build time.
const FACET_COLS = {
  regime: "c.regime",
  country: "c.country",
  constellation: "c.constellation",
  purpose: "c.purpose_group",
};

for (const [name, col] of Object.entries(FACET_COLS)) {
  check(`分面查询可执行：${name}（无筛选）`, () => {
    const rows = sqlite
      .prepare(
        `SELECT ${col} AS value, COUNT(*) AS count
           FROM wide.catalogue_wide w
           JOIN object_classification c ON c.norad_id = w.norad_id
          WHERE ${col} IS NOT NULL AND ${col} <> ''
          GROUP BY ${col} ORDER BY count DESC LIMIT 5`,
      )
      .all() as Array<{ value: string; count: number }>;
    assert.ok(rows.length > 0, "分面结果为空");
  });

  check(`分面查询可执行：${name}（带筛选）`, () => {
    const rows = sqlite
      .prepare(
        `SELECT ${col} AS value, COUNT(*) AS count
           FROM wide.catalogue_wide w
           JOIN object_classification c ON c.norad_id = w.norad_id
          WHERE c.regime = ? AND ${col} IS NOT NULL AND ${col} <> ''
          GROUP BY ${col} ORDER BY count DESC LIMIT 5`,
      )
      .all("LEO") as Array<{ value: string; count: number }>;
    assert.ok(Array.isArray(rows), "查询失败");
  });
}

check("分类浏览的列表查询可执行", () => {
  const rows = sqlite
    .prepare(
      `SELECT w.norad_id AS noradId, COALESCE(w.name__spacetrack, w.name__spacebook) AS name,
              c.constellation AS constellation, c.regime AS regime
         FROM wide.catalogue_wide w
         JOIN object_classification c ON c.norad_id = w.norad_id
        WHERE c.constellation = ?
        ORDER BY w.norad_id LIMIT 10`,
    )
    .all("Starlink") as unknown[];
  assert.ok(rows.length > 0, "Starlink 应有结果");
});

sqlite.close();

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
if (failed > 0) process.exit(1);
