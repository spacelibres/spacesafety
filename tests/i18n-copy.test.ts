/**
 * The panels that only appear when data is missing must still be translated.
 *
 * ## Why this exists
 *
 * `tools/check.ts` forbids Chinese literals under `src/`, which catches copy
 * written in one language. It cannot catch copy written in *English* and never
 * routed through the dictionary — `Not enough uploads to evaluate prediction
 * accuracy.` passed every check in the project while rendering as English in all
 * six languages, because the old heuristic only looked at single-line JSX text
 * nodes.
 *
 * These two components are reachable only with trajectory data, and this
 * checkout has no trajectories, so no page and no browser run exercises them.
 * Rendering them directly is the only way to see what they actually emit.
 *
 * The render happens in `tools/i18n-copy-probe.ts` because `react-dom/server`
 * cannot load under the `react-server` condition that `npm test` uses.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${(err as Error).message}`);
  }
}

console.log("\n无数据面板的多语言渲染\n");

type Rendered = Record<string, { accuracy: string; elements: string }>;

const raw = execFileSync(process.execPath, ["--import", "tsx", "tools/i18n-copy-probe.ts"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 120_000,
});
const rendered = JSON.parse(raw.trim().split("\n").pop() ?? "{}") as Rendered;

const CJK = /[\u4e00-\u9fff]/;
const LOCALES = ["zh-CN", "en", "es", "fr", "de", "ja"] as const;
/** Copy that used to be hard-coded, verbatim. */
const LEAKS = ["Not enough uploads", "Not enough states", "Supported formats: OCM"];

check("六语种全部渲染出内容", () => {
  for (const locale of LOCALES) {
    assert.ok(rendered[locale], `${locale} 没有输出`);
    assert.ok(rendered[locale].accuracy.length > 0, `${locale} 的精度面板是空的`);
    assert.ok(rendered[locale].elements.length > 0, `${locale} 的轨道根数面板是空的`);
  }
});

for (const locale of LOCALES) {
  // English legitimately renders these words: they are the reference table's
  // values. The defect was every *other* locale rendering them too.
  if (locale === "en") continue;

  check(`${locale}：没有绕过字典的英文原文`, () => {
    const text = `${rendered[locale].accuracy} ${rendered[locale].elements}`;
    for (const leak of LEAKS) {
      assert.ok(!text.includes(leak), `出现硬编码英文「${leak}」：${text.slice(0, 90)}`);
    }
  });

  check(`${locale}：文案与英文不同（真的翻译过）`, () => {
    const mine = `${rendered[locale].accuracy} ${rendered[locale].elements}`;
    const english = `${rendered.en.accuracy} ${rendered.en.elements}`;
    assert.notEqual(mine, english, "与英文完全相同，说明没有走字典");
  });
}

for (const locale of ["en", "es", "fr", "de"] as const) {
  check(`${locale}：不出现中文字符`, () => {
    const text = `${rendered[locale].accuracy} ${rendered[locale].elements}`;
    assert.ok(!CJK.test(text), `出现中文：${text.slice(0, 90)}`);
  });
}

for (const locale of ["zh-CN", "ja"] as const) {
  check(`${locale}：中文字符来自本地字典`, () => {
    const text = `${rendered[locale].accuracy} ${rendered[locale].elements}`;
    assert.ok(CJK.test(text), "没有出现中文，可能回退到了英文");
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
