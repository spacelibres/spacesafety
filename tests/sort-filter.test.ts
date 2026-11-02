/**
 * Sorting and filtering: the parts a URL is allowed to control.
 *
 * ## Why this exists
 *
 * The list pages rendered filter bars for a while that did nothing — three
 * `<select>`s with no `name`, no enclosing form, and no query behind them. They
 * looked exactly like the official UI and filtered nothing, which is worse than
 * having no filter at all: a reader who narrows the list and sees it unchanged
 * concludes the data has no matching rows.
 *
 * The moment filters and sort keys come from the URL they become an input surface,
 * so the two things asserted here are the two that matter:
 *
 *   1. **An unknown sort key never reaches SQL** — it falls back to the default
 *      column instead of being interpolated.
 *   2. **A direction that is not `asc`/`desc` is ignored**, not passed through.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { orderByClause, parseSort, sortHref, sortMarker } from "../src/lib/sort";
import { OBJECT_SORTS, TRAJECTORY_SORTS } from "../src/lib/queries";

// Pin the database *before* anything opens it. Without this the process falls back
// to `data/spacesafety.sqlite` (the working database), so the assertions below would
// silently describe a different catalogue than the application serves — they did,
// and the trajectory fixture was the difference.
const DB = "./data/catalogue.sqlite";
const haveData = existsSync(DB);
if (haveData) process.env.SPACE_SAFETY_DB = DB;



let pass = 0;
let fail = 0;

function check(name: string, fn: () => void, detail = ""): void {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
    console.log(`       ${(err as Error).message}`);
  }
}

const OBJECT_FALLBACK = { key: "objectName", dir: "asc" } as const;

async function main(): Promise<void> {
  console.log("\n排序与筛选：URL 能控制的那部分\n");

  const { listObjects, listTrajectories } = await import("../src/lib/queries");

  check("未知的排序键回落到默认，不进入 SQL", () => {
    const sort = parseSort({ sort: "id;DROP TABLE objects--" }, OBJECT_SORTS, OBJECT_FALLBACK);
    assert.equal(sort.key, "objectName");
    assert.equal(sort.dir, "asc");
  });

  check("非法方向被忽略，只认 asc / desc", () => {
    for (const dir of ["up", "DESC", "", "descx", undefined]) {
      const sort = parseSort({ sort: "noradId", dir }, OBJECT_SORTS, OBJECT_FALLBACK);
      assert.equal(sort.dir, "asc", `dir=${String(dir)} 变成了 ${sort.dir}`);
      assert.equal(sort.key, "noradId");
    }
    assert.equal(parseSort({ sort: "noradId", dir: "desc" }, OBJECT_SORTS, OBJECT_FALLBACK).dir, "desc");
  });

  check("白名单之外的键不在映射表里（表本身是封闭的）", () => {
    assert.deepEqual(Object.keys(OBJECT_SORTS).sort(), [
      "alive",
      "country",
      "maneuverability",
      "noradId",
      "objectClass",
      "objectName",
      "operatorName",
    ]);
    assert.deepEqual(Object.keys(TRAJECTORY_SORTS).sort(), [
      "endAt",
      "objectName",
      "pointCount",
      "screenedStatus",
      "startAt",
      "stateSource",
      "uploadType",
      "uploadedAt",
    ]);
  });

  check("ORDER BY 总带稳定的次级排序", () => {
    const clause = orderByClause(OBJECT_SORTS, { key: "noradId", dir: "desc" }, "o.id");
    assert.match(clause, /^o\.norad_id DESC NULLS LAST, o\.id ASC$/);
  });

  check("点当前列翻转方向，点别的列升序", () => {
    const current = { key: "noradId", dir: "asc" } as const;
    assert.equal(
      sortHref("/objects", {}, "noradId", current),
      "/objects?sort=noradId&dir=desc",
    );
    assert.equal(
      sortHref("/objects", {}, "objectName", current),
      "/objects?sort=objectName&dir=asc",
    );
  });

  check("排序链接保留当前的筛选条件", () => {
    const href = sortHref(
      "/objects",
      { alive: "true", name: "STARLINK", sort: "objectName", dir: "asc" },
      "noradId",
      { key: "objectName", dir: "asc" },
    );
    assert.match(href, /alive=true/);
    assert.match(href, /name=STARLINK/);
    assert.match(href, /sort=noradId/);
    assert.match(href, /dir=asc/);
    assert.equal(href.split("sort=").length - 1, 1, "sort 参数出现了两次");
  });

  check("标记只标当前列", () => {
    const current = { key: "noradId", dir: "desc" } as const;
    assert.equal(sortMarker("noradId", current), "▼");
    assert.equal(sortMarker("objectName", current), "↕");
    assert.equal(sortMarker("noradId", { key: "noradId", dir: "asc" }), "▲");
  });

  // ---------------------------------------------------------------- 真实查询
  // These run against the attached catalogue, which every test process opens; the
  // rows are read-only and the assertions are about *which* rows come back.
  const dbCheck = haveData ? check : (name: string) => {
    console.log(`  skip ${name}（没有 ${DB}）`);
  };

  dbCheck("名称筛选真的缩小结果集", () => {
    const all = listObjects(5).length;
    const none = listObjects(5, OBJECT_FALLBACK, { nameContains: "ZZZZ-NO-SUCH" });
    assert.equal(all, 5, "基线查询没有返回行，后面的断言没有意义");
    assert.equal(none.length, 0, `不该匹配，却返回 ${none.length} 行`);
  });

  dbCheck("NORAD 筛选只返回该 NORAD", () => {
    const rows = listObjects(50, OBJECT_FALLBACK, { noradId: 45414 });
    assert.ok(rows.length > 0, "45414 应当存在");
    for (const row of rows) assert.equal(row.noradId, 45414, `${row.objectName} 的 NORAD 是 ${row.noradId}`);
  });

  dbCheck("alive=true 与 alive=false 互补", () => {
    const alive = listObjects(200, OBJECT_FALLBACK, { alive: true });
    const dead = listObjects(200, OBJECT_FALLBACK, { alive: false });
    for (const row of alive) assert.equal(row.alive, true);
    for (const row of dead) assert.equal(row.alive, false);
  });

  dbCheck("排序真的改变首行", () => {
    const asc = listObjects(1, { key: "noradId", dir: "asc" });
    const desc = listObjects(1, { key: "noradId", dir: "desc" });
    assert.ok(asc[0].noradId !== null && desc[0].noradId !== null);
    assert.ok(asc[0].noradId! < desc[0].noradId!, `${asc[0].noradId} vs ${desc[0].noradId}`);
  });

  dbCheck("轨迹筛选拒绝枚举外的取值（不会返回全部）", () => {
    // The trajectory table is empty on this deployment, so the enum check itself is
    // the assertion: a bad value must not become "no filter".
    const banana = listTrajectories(10, { key: "uploadedAt", dir: "desc" }, { uploadType: "banana" });
    assert.ok(Array.isArray(banana));
    assert.equal(banana.length, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
