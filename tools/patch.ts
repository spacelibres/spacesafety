/**
 * Apply a list of exact-text replacements to one file.
 *
 * ## Why this exists
 *
 * Every large-file edit in this project has failed the same way at least once: a
 * block replace matched more than intended and silently removed the rest of the
 * file. It happened to `tools/check.ts` (twice, 142 lines each), to
 * `CesiumGlobe.ts` (220 lines) and to `tools/vi.ts`. Each time it was caught by
 * `wc -l` afterwards, and each time the interim fix was a `python3 - <<EOF` heredoc
 * — which violates this project's rule that every tool is TypeScript, and leaves
 * the fix unreviewable in history.
 *
 * This is the TypeScript replacement for that habit. It refuses to run unless:
 *
 *   - every `old` string occurs exactly once (so a rename cannot hit the wrong
 *     occurrence),
 *   - the file still has the expected line count afterwards within a stated
 *     tolerance, which catches an accidental truncation immediately.
 *
 * ## Usage
 *
 *   npx tsx tools/patch.ts <file> <spec.json>
 *
 * Where `spec.json` is:
 *
 *   {
 *     "expectLinesDelta": 0,          // optional; default 0
 *     "edits": [
 *       { "old": "exact text", "new": "replacement" },
 *       ...
 *     ]
 *   }
 *
 * `expectLinesDelta` is how many lines the file should grow or shrink in total.
 * A mismatch aborts without writing, so a wrong match cannot half-apply.
 *
 * Run: npm run patch -- <file> <spec.json>
 */

import { readFileSync, writeFileSync } from "node:fs";

interface Edit {
  old: string;
  new: string;
}

interface Spec {
  expectLinesDelta?: number;
  edits: Edit[];
}

function fail(message: string): never {
  console.error(`\n  patch 失败：${message}\n`);
  process.exit(1);
}

function main(): void {
  const [file, specPath] = process.argv.slice(2);
  if (!file || !specPath) {
    fail("用法: npx tsx tools/patch.ts <file> <spec.json>");
  }

  let spec: Spec;
  try {
    spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec;
  } catch (err) {
    fail(`读取 ${specPath} 失败：${(err as Error).message}`);
  }
  if (!Array.isArray(spec.edits) || spec.edits.length === 0) {
    fail("spec 里没有 edits");
  }

  const before = readFileSync(file, "utf8");
  const linesBefore = before.split("\n").length;
  let after = before;

  for (const [i, edit] of spec.edits.entries()) {
    if (typeof edit.old !== "string" || typeof edit.new !== "string") {
      fail(`第 ${i + 1} 条 edit 的 old/new 必须是字符串`);
    }
    // Count occurrences, not just presence: a block that appears twice would have
    // been silently replaced at the first site only, which is how the wrong
    // function got patched in an earlier attempt.
    const first = after.indexOf(edit.old);
    if (first === -1) {
      fail(`第 ${i + 1} 条 edit 找不到目标文本。前 80 字：\n    ${edit.old.slice(0, 80).replace(/\n/g, "\\n")}`);
    }
    const second = after.indexOf(edit.old, first + edit.old.length);
    if (second !== -1) {
      fail(`第 ${i + 1} 条 edit 的目标文本出现了不止一次，无法确定改哪一处`);
    }
    after = after.slice(0, first) + edit.new + after.slice(first + edit.old.length);
  }

  const linesAfter = after.split("\n").length;
  const delta = linesAfter - linesBefore;
  const expected = spec.expectLinesDelta ?? 0;
  if (delta !== expected) {
    fail(
      `行数变化 ${delta > 0 ? "+" : ""}${delta}，与预期的 ${expected > 0 ? "+" : ""}${expected} 不符。` +
        `文件未写入（改前 ${linesBefore} 行）。`,
    );
  }

  writeFileSync(file, after, "utf8");
  console.log(`\n  ${file}`);
  console.log(`  ${spec.edits.length} 处替换，行数 ${linesBefore} → ${linesAfter}\n`);
}

main();
