/**
 * Distance formatting must not lose information at any scale.
 *
 * ## Why this test exists
 *
 * The conjunction table showed "0.0 km" for two of the six highest-risk events on
 * the page. The value was real — a 19 m miss — but fixed one-decimal kilometres
 * cannot express it, so the most urgent row read as the least informative one.
 *
 * The rule under test: under 1 km the unit is metres with no decimals; from 1 km
 * up it is kilometres, one decimal below 100 km and none above. A scale error or a
 * unit regression shows up here rather than on screen.
 *
 * Run: npm run test:distance
 */

import assert from "node:assert/strict";

import { distanceLabel, formatDistance } from "../src/lib/space-safety/distance";

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

console.log("\n  距离格式化\n");

check("不足 1 km 用米，且不显示小数", () => {
  assert.deepEqual(formatDistance(0.019), { value: "19", unit: "m" });
  assert.deepEqual(formatDistance(0.5), { value: "500", unit: "m" });
  assert.deepEqual(formatDistance(0.999), { value: "999", unit: "m" });
});

check("19 米不再被显示成 0.0 km", () => {
  const f = formatDistance(0.019);
  assert.ok(f);
  assert.notEqual(f.value, "0.0");
  assert.equal(f.unit, "m");
});

check("1 km 及以上用公里", () => {
  assert.deepEqual(formatDistance(1), { value: "1.0", unit: "km" });
  assert.deepEqual(formatDistance(47.4), { value: "47.4", unit: "km" });
  assert.deepEqual(formatDistance(99.9), { value: "99.9", unit: "km" });
});

check("100 km 以上不带小数（0.1 km 精度在那里是噪声）", () => {
  assert.deepEqual(formatDistance(100), { value: "100", unit: "km" });
  assert.deepEqual(formatDistance(771), { value: "771", unit: "km" });
  assert.deepEqual(formatDistance(2530), { value: "2530", unit: "km" });
});

check("0 显示为 0 m 而不是 0.0 km", () => {
  assert.deepEqual(formatDistance(0), { value: "0", unit: "m" });
});

check("缺失值返回 null，由调用方决定显示什么", () => {
  assert.equal(formatDistance(null), null);
  assert.equal(formatDistance(undefined), null);
  assert.equal(formatDistance(Number.NaN), null);
});

check("distanceLabel 插入字典里的单位", () => {
  const t = (k: string) => (k === "unit.m" ? "m" : k === "unit.km" ? "km" : "?");
  assert.equal(distanceLabel(0.019, "—", t), "19 m");
  assert.equal(distanceLabel(47.4, "—", t), "47.4 km");
  assert.equal(distanceLabel(null, "—", t), "—");
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
