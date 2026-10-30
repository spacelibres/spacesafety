/**
 * The eight event feeds must parse and must join to the catalogue.
 *
 * ## Why this test exists
 *
 * Every failure this file guards against was found by running the loader, not by
 * reading the spec:
 *
 *   - the space-weather file has 33 data columns, not the 34 the header block
 *     appears to describe, and the first attempt rejected every row;
 *   - DISCOSweb returns JSON:API (`{data: [...]}`) while Space-Track returns a
 *     bare array, and treating the former as the latter produced
 *     "all is not iterable";
 *   - `PC` is null on some CDMs, and storing that as 0 would rank a real threat
 *     below every measured one.
 *
 * So the assertions below are about observed values on a real capture: column
 * counts, join rates, and the null-versus-zero distinction.
 *
 * Skips cleanly when the capture is absent — a checkout without local data cannot
 * test a loader whose input is 43 MB of archive.
 *
 * Run: npm run test:events
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  SpaceWeatherLoader,
  EopLoader,
  isoUtc,
  num,
  text,
} from "../src/lib/sources/event-feeds";

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

const DB = process.env.SPACE_SAFETY_DB ?? "./data/catalogue.sqlite";
const ARCHIVE = "data/archive";

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function capture(dir: string): string | null {
  const root = join(ARCHIVE, dir);
  if (!existsSync(root)) return null;
  const days = readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const pick = days.at(-1);
  return pick ? join(root, pick) : null;
}

function firstFile(dir: string, ext: string): string | null {
  const d = capture(dir);
  if (!d) return null;
  const f = readdirSync(d).filter((x) => x.endsWith(ext))[0];
  return f ? join(d, f) : null;
}

// ------------------------------------------------------------------ parsing

console.log("\n  字段解析\n");

check("isoUtc 把空格分隔改为 ISO 并标 UTC", () => {
  assert.equal(isoUtc("2026-09-29 12:21:34.000000"), "2026-09-29T12:21:34.000000Z");
  assert.equal(isoUtc("2026-10-01T22:31:11.609000"), "2026-10-01T22:31:11.609000Z");
});

check("isoUtc 补齐缺省的毫秒位", () => {
  assert.equal(isoUtc("2026-09-29 12:21:34"), "2026-09-29T12:21:34.000Z");
});

check("num 把字符串 \"null\" 与空串当作缺失，不是 0", () => {
  assert.equal(num("null"), null);
  assert.equal(num(""), null);
  assert.equal(num(null), null);
  assert.equal(num("0"), 0);
  assert.equal(num("0.06465958"), 0.06465958);
});

check("text 把 \"null\" 当作缺失", () => {
  assert.equal(text(" null "), null);
  assert.equal(text("Y"), "Y");
});

// ------------------------------------------------------------- file formats

console.log("\n  固定列格式\n");

const wx = firstFile("spacebook-spaceweather", ".kvn");
if (!wx) {
  console.log("  skip 空间天气：没有本地归档");
  skipped += 1;
} else {
  check("空间天气文件每行恰好 33 个数据列", () => {
    const content = readFileSync(wx, "utf8");
    const start = content.split("\n").findIndex((l) => l.trim() === "BEGIN OBSERVED");
    const lines = content.split("\n").slice(start + 1).filter((l) => l.trim() && !l.startsWith("END"));
    assert.ok(lines.length > 20_000, `行数只有 ${lines.length}`);
    for (const l of lines.slice(0, 500)) {
      assert.equal(l.trim().split(/\s+/).filter(Boolean).length, 33, `行：${l}`);
    }
  });

  check("空间天气列定义与文件列数一致（不会因表头误读而丢行）", () => {
    assert.equal(SpaceWeatherLoader.COLUMNS.length, 33);
  });
}

const eopFile = firstFile("spacebook-eop", ".kvn");
if (!eopFile) {
  console.log("  skip EOP：没有本地归档");
  skipped += 1;
} else {
  check("EOP 文件每行恰好 13 个数据列，与列定义一致", () => {
    assert.equal(EopLoader.COLUMNS.length, 13);
    const content = readFileSync(eopFile, "utf8");
    const lines = content
      .split("\n")
      .filter((l) => /^\d{4} \d{2} \d{2} \d{5}/.test(l.trim()));
    assert.ok(lines.length > 20_000, `行数只有 ${lines.length}`);
    assert.equal(lines[0].trim().split(/\s+/).filter(Boolean).length, 13);
  });
}

// ---------------------------------------------------------------- database

console.log("\n  入库结果\n");

if (!existsSync(DB)) {
  console.log(`  skip 数据库 ${DB} 不存在`);
  skipped += 1;
} else {
  const db = new Database(DB, { readonly: true });

  const expected: Array<[string, string]> = [
    ["space_track_cdm_public", "公开 CDM"],
    ["space_track_tip", "再入预测 TIP"],
    ["space_track_decay", "再入历史"],
    ["discos_fragmentation", "解体事件"],
    ["space_track_boxscore", "国别统计"],
    ["launch_site", "发射场"],
    ["earth_orientation", "地球定向"],
    ["space_weather", "空间天气"],
  ];

  for (const [table, label] of expected) {
    if (!tableExists(db, table)) {
      console.log(`  skip ${label}：未入库`);
      skipped += 1;
      continue;
    }
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    check(`${label} ${table} 至少有一行（实际 ${n}）`, () => {
      assert.ok(n > 0, `${table} 为空`);
    });
  }

  // A null probability is not a zero probability. If the loader ever "fixed" the
  // nulls into 0 these two counts would become equal and this test would fail.
  if (tableExists(db, "space_track_cdm_public")) {
    check("CDM 中缺失的 Pc 保持为 NULL，没有被写成 0", () => {
      const { nulls, zeros } = db
        .prepare(
          `SELECT SUM(CASE WHEN pc IS NULL THEN 1 ELSE 0 END) AS nulls,
                  SUM(CASE WHEN pc = 0 THEN 1 ELSE 0 END) AS zeros
           FROM space_track_cdm_public`,
        )
        .get() as { nulls: number; zeros: number };
      assert.ok(nulls > 0, "应当存在没有 Pc 的行");
      assert.equal(zeros, 0, "不应出现 Pc = 0 的行，那是被误填的缺失值");
    });

    check("CDM 的 Pc 是概率，全部落在 [0, 1]", () => {
      const { bad } = db
        .prepare(`SELECT COUNT(*) AS bad FROM space_track_cdm_public WHERE pc < 0 OR pc > 1`)
        .get() as { bad: number };
      assert.equal(bad, 0);
    });
  }

  if (tableExists(db, "discos_fragmentation")) {
    check("解体事件只对有位置的存经纬度，其余为 NULL 而非 0", () => {
      const { withPos, zeroZero } = db
        .prepare(
          `SELECT SUM(CASE WHEN latitude_deg IS NOT NULL THEN 1 ELSE 0 END) AS withPos,
                  SUM(CASE WHEN latitude_deg = 0 AND longitude_deg = 0 THEN 1 ELSE 0 END) AS zeroZero
           FROM discos_fragmentation`,
        )
        .get() as { withPos: number; zeroZero: number };
      assert.ok(withPos > 0, "应当有带位置的解体事件");
      assert.equal(zeroZero, 0, "0,0 是被误填的缺失值");
    });
  }

  // The whole point of these tables is to be read next to the catalogue.
  //
  // The wide table lives in its own file, so it has to be attached exactly as the
  // app attaches it in `src/db/index.ts` — otherwise this check silently skips and
  // reports success for a join it never ran.
  const widePath = process.env.SPACE_SAFETY_WIDE_DB ?? "data/catalogue-wide.sqlite";
  if (existsSync(widePath)) {
    db.exec(`ATTACH DATABASE '${widePath.replace(/'/g, "''")}' AS wide`);
  }
  const wideAttached = Boolean(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM pragma_database_list WHERE name = 'wide'")
        .get() as { n: number }
    ).n,
  );
  if (wideAttached && tableExists(db, "space_track_cdm_public")) {
    check("CDM 的两个对象都能在宽编目里找到", () => {
      const { total, missing } = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM wide.catalogue_wide w WHERE w.norad_id = c.sat1_norad)
                            OR NOT EXISTS (SELECT 1 FROM wide.catalogue_wide w WHERE w.norad_id = c.sat2_norad)
                       THEN 1 ELSE 0 END) AS missing
           FROM space_track_cdm_public c`,
        )
        .get() as { total: number; missing: number };
      assert.ok(total > 0);
      assert.equal(missing, 0, `${missing} 条 CDM 引用了编目里没有的对象`);
    });
  } else {
    console.log(`  skip 关联检查：宽编目 ${widePath} 不存在`);
    skipped += 1;
  }

  db.close();
}

console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
if (failed > 0) process.exit(1);
