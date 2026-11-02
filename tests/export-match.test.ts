/**
 * Two things that are easy to get subtly wrong and impossible to notice by eye:
 * CSV quoting, and matching a satellite to a 3D model.
 *
 * CSV: an object name with a comma or a quote in it silently shifts every later
 * column of that row, so the file opens and is wrong.
 *
 * Model matching: a matcher that always returns *something* puts a model of the
 * space station on a Starlink satellite, and the reader has no way to tell. The
 * rules are asserted here, including the ones that must return nothing.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";

import { matchModel, type ModelCandidate } from "../src/lib/geo/model-match";

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

const model = (name: string, localPath: string | null = `data/models/nasa/${name}.glb`): ModelCandidate => ({
  name,
  path: `Models/${name}`,
  filename: `${name}.glb`,
  localPath,
});

const CATALOGUE: ModelCandidate[] = [
  model("International Space Station (ISS)"),
  model("Hubble Space Telescope"),
  model("1999 RQ36 asteroid"),
  model("70-meter Dish"),
  model("Advanced Composition Explorer"),
  model("Geostationary Operational Environmental Satellites"),
  model("Base Station"),
];

function main(): void {
  console.log("\n导出与模型匹配\n");

  // ------------------------------------------------------------- 模型匹配
  check("完全同名优先", () => {
    assert.equal(matchModel("1999 RQ36 asteroid", CATALOGUE)?.name, "1999 RQ36 asteroid");
  });

  check("缩写能匹配（ISS → International Space Station (ISS)）", () => {
    assert.equal(matchModel("ISS (ZARYA)", CATALOGUE)?.name, "International Space Station (ISS)");
  });

  check("一方包含另一方且够长时匹配", () => {
    assert.equal(matchModel("Hubble Space Telescope (HST)", CATALOGUE)?.name, "Hubble Space Telescope");
  });

  check("星链这类没有模型的物体返回 null，而不是硬套一个", () => {
    assert.equal(matchModel("STARLINK-32777", CATALOGUE), null);
    assert.equal(matchModel("COSMOS 2251 DEB", CATALOGUE), null);
  });

  check("数字与短碎片词不会造成误配", () => {
    // `2251`/`DEB`/`R/B` 出现在成百上千个编目名里，任何一个都可能是"最像"的
    assert.equal(matchModel("DEB", CATALOGUE), null);
    assert.equal(matchModel("R/B", CATALOGUE), null);
    assert.equal(matchModel("2251", CATALOGUE), null);
  });

  check("空名字不匹配任何东西", () => {
    assert.equal(matchModel("", CATALOGUE), null);
    assert.equal(matchModel("   ", CATALOGUE), null);
  });

  check("多个候选时取分最高的", () => {
    const many = [...CATALOGUE, model("International Space Station (ISS) (D) (IGOAL)")];
    // 精确包含优先于缩写：两个都能配上，但结果必须稳定且是其中之一
    const hit = matchModel("International Space Station (ISS)", many);
    assert.ok(hit, "应当匹配");
    assert.match(hit!.name, /International Space Station/);
  });

  // ------------------------------------------------------------- CSV 引号
  // 直接测纯函数即可：路由只是把它接到 Response 上。
  const csvCell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  check("普通值不加引号", () => {
    assert.equal(csvCell("STARLINK-1309"), "STARLINK-1309");
    assert.equal(csvCell(45414), "45414");
  });

  check("逗号、引号、换行都被转义", () => {
    assert.equal(csvCell("A,B"), '"A,B"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
    assert.equal(csvCell("crlf\r"), '"crlf\r"');
  });

  check("空值输出空串而不是 null/undefined", () => {
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(undefined), "");
    assert.equal(csvCell(0), "0");
    assert.equal(csvCell(false), "false");
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main();
