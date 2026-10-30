/**
 * Fail when the stylesheets reference a CSS custom property that nothing defines.
 *
 * ## Why this check exists
 *
 * The sidebar collapsed on every page while every route still returned HTTP 200.
 * Nine custom properties were referenced by `globals.css` and emitted by nothing:
 *
 *   --sidebar-w  --bg-elev-1  --bg-elev-2  --bg-label
 *   --ok  --bad  --operator-ephemeris  --spacex-optical
 *
 * CSS does not warn on an undefined `var()`. The declaration is dropped, so the
 * rail had no width, its icons sat on top of each other, and the nav wrapped one
 * character per line. A build passes, `tsc` passes, and the page answers 200.
 *
 * The root cause was two naming schemes: `tools/vi.ts` emits `--bg-elev2`, the
 * stylesheet asks for `--bg-elev-2`. The aliases are now emitted by the generator,
 * so the token file stays the only place that names a colour.
 *
 * Run: npm run check:css
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const FILES = [
  join(ROOT, "src", "app", "globals.css"),
  join(ROOT, "src", "app", "vi-tokens.css"),
];

function main(): void {
  const present = FILES.filter((f) => existsSync(f));
  if (present.length !== FILES.length) {
    console.error("找不到样式文件：");
    for (const f of FILES) {
      if (!existsSync(f)) console.error(`  ${f}`);
    }
    process.exit(1);
  }

  const css = present.map((f) => readFileSync(f, "utf8")).join("\n");

  // A definition is `--name: value` inside a rule block. Comments are stripped
  // first: the stylesheets explain variable names in prose, and a `--name:` inside
  // a comment is not a definition.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

  const used = new Set([...withoutComments.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]));
  const defined = new Set([...withoutComments.matchAll(/(^|[\s{;])(--[a-z0-9-]+)\s*:/g)].map((m) => m[2]));

  const missing = [...used].filter((v) => !defined.has(v)).sort();

  console.log(`\n  CSS 变量校验\n`);
  console.log(`  引用  ${used.size}`);
  console.log(`  定义  ${defined.size}`);

  if (missing.length === 0) {
    console.log(`\n  未引用的定义  ${[...defined].filter((v) => !used.has(v)).length}（不构成问题）\n`);
    console.log("  All referenced custom properties are defined.\n");
    return;
  }

  console.error(`\n  ${missing.length} 个变量被引用但从未定义，整条声明会被浏览器静默丢弃：\n`);
  for (const v of missing) {
    // Point at the line that uses it, so the fix does not need a search.
    const lines = css.split("\n");
    const at = lines.findIndex((l) => l.includes(`var(${v})`));
    console.error(`    ${v.padEnd(24)} 首次引用 globals.css 附近第 ${at + 1} 行`);
  }
  console.error("");
  process.exit(1);
}

main();
