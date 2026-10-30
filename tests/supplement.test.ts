/**
 * The supplement layer's admission rules.
 *
 * These tests exist because the whole point of this layer is to keep unattributable
 * numbers out of the catalogue. A rule that is not tested is a rule that will be
 * loosened the first time a crawl produces a large batch and someone wants it stored.
 *
 * Run: npm run test:supplement
 */

import assert from "node:assert/strict";

import Database from "better-sqlite3";

import {
  scoreConfidence,
  SupplementStore,
  validateClaim,
  type SupplementClaim,
  type SourceType,
} from "../src/lib/sources/supplement";

let passed = 0;
let failed = 0;

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

function claim(over: Partial<SupplementClaim> = {}): SupplementClaim {
  return {
    noradId: 101144,
    cosparId: "2026-239A",
    objectName: "HAWK 16A",
    field: "manufacturer",
    valueNum: null,
    valueText: "HawkEye 360",
    unit: null,
    sourceUrl: "https://www.hawkeye360.com/press/hawk-16",
    sourceType: "official",
    quote: "HawkEye 360 confirmed the launch of Hawk 16A aboard a Falcon 9 on 23 October 2026.",
    evidenceCount: 2,
    corroboration: ["https://spacenews.com/hawk-16-launch"],
    confidence: 0.9,
    note: null,
    ...over,
  };
}

function freshStore(): { store: SupplementStore; sqlite: Database.Database } {
  const sqlite = new Database(":memory:");
  const store = new SupplementStore(sqlite);
  return { store, sqlite };
}

console.log("\n补充数据准入规则\n");

check("A 级来源带原文摘录时通过", () => {
  assert.equal(validateClaim(claim()), null);
});

check("没有来源 URL 的拒绝", () => {
  const r = validateClaim(claim({ sourceUrl: "" }));
  assert.ok(r && r.includes("URL"), `应因缺 URL 被拒，实际：${r}`);
});

check("非 http 协议的 URL 也拒绝", () => {
  const r = validateClaim(claim({ sourceUrl: "file:///tmp/a.html" }));
  assert.ok(r && r.includes("URL"));
});

check("原文摘录过短的拒绝", () => {
  const r = validateClaim(claim({ quote: "mass 260 kg" }));
  assert.ok(r && r.includes("过短"), `实际：${r}`);
});

check("原文摘录过长的拒绝", () => {
  const r = validateClaim(claim({ quote: "x".repeat(2100) }));
  assert.ok(r && r.includes("过长"));
});

check("既无 NORAD 也无 COSPAR 的拒绝", () => {
  const r = validateClaim(claim({ noradId: null, cosparId: null }));
  assert.ok(r && r.includes("无法定位"));
});

check("只有 COSPAR 时通过", () => {
  assert.equal(validateClaim(claim({ noradId: null })), null);
});

check("没有任何值的拒绝", () => {
  const r = validateClaim(claim({ valueText: null, valueNum: null }));
  assert.ok(r && r.includes("没有值"));
});

check("未知来源类型的拒绝", () => {
  const r = validateClaim(claim({ sourceType: "forum" as SourceType }));
  assert.ok(r && r.includes("未知来源类型"));
});

check("confidence 超出 0..1 的拒绝", () => {
  assert.ok(validateClaim(claim({ confidence: 1.5 })));
  assert.ok(validateClaim(claim({ confidence: -0.1 })));
});

console.log("\n来源分级\n");

check("航天机构、厂商官网、FCC 属 A 级", () => {
  for (const t of ["agency", "official", "fcc"] as SourceType[]) {
    assert.ok(scoreConfidence({ sourceType: t, evidenceCount: 1, quote: "" }) >= 0.75, t);
  }
});

check("A 级高于 B 级", () => {
  const a = scoreConfidence({ sourceType: "agency", evidenceCount: 1, quote: "x" });
  const b = scoreConfidence({ sourceType: "press", evidenceCount: 1, quote: "x" });
  assert.ok(a > b, `A=${a} 应大于 B=${b}`);
});

check("独立佐证提高置信度，但不超过 0.99", () => {
  const one = scoreConfidence({ sourceType: "press", evidenceCount: 1, quote: "m 260 kg" });
  const three = scoreConfidence({ sourceType: "press", evidenceCount: 3, quote: "m 260 kg" });
  const nine = scoreConfidence({ sourceType: "agency", evidenceCount: 9, quote: "m 260 kg" });
  assert.ok(three > one, "佐证应提高置信度");
  assert.ok(nine <= 0.99, `上限 0.99，实际 ${nine}`);
});

console.log("\n入库\n");

check("C 级来源在入库时被拒，不进入待审队列", () => {
  const { store } = freshStore();
  // `forum` is not in SOURCE_TYPES, so it fails validation before a grade is chosen.
  const res = store.add([claim({ sourceType: "forum" as SourceType })]);
  assert.equal(res.stored, 0);
  assert.equal(res.rejected.length, 1);
  assert.equal(store.pending().length, 0);
});

check("合法记录入库后处于未审核状态", () => {
  const { store } = freshStore();
  const res = store.add([claim()]);
  assert.equal(res.stored, 1);
  const pending = store.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.verified, 0);
  // A stored claim must never be confirmed by the insert itself.
  assert.notEqual(pending[0]!.verified, 1);
});

check("审核确认后进入已确认集合", () => {
  const { store } = freshStore();
  store.add([claim()]);
  const id = String(store.pending()[0]!.id);
  store.review(id, true, "reviewer");
  assert.equal(store.pending().length, 0);
  const confirmed = store.confirmedFor(101144);
  assert.equal(confirmed.get("manufacturer")?.length, 1);
});

check("否决的记录不出现在已确认集合", () => {
  const { store } = freshStore();
  store.add([claim()]);
  const id = String(store.pending()[0]!.id);
  store.review(id, false, "reviewer", "引文未在页面中找到");
  assert.equal(store.confirmedFor(101144).size, 0);
});

check("确认值保留完整溯源", () => {
  const { store } = freshStore();
  store.add([claim()]);
  const id = String(store.pending()[0]!.id);
  store.review(id, true, "reviewer");
  const row = store.confirmedFor(101144).get("manufacturer")![0]!;
  assert.equal(row.sourceUrl, "https://www.hawkeye360.com/press/hawk-16");
  assert.equal(row.sourceGrade, "A");
  assert.ok(String(row.quote).includes("Hawk 16A"));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
