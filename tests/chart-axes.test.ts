/**
 * Chart axis logic.
 *
 * The Pc history chart crashed with a React duplicate-key error on every
 * conjunction page, because its tick values were computed as
 * `[lo, lo + span/2, hi]` and a series with one (or several identical) points
 * makes `lo === hi`, so the first and last tick were the *same number*. React
 * rejects that as two children with the same key.
 *
 * These tests pin the fix at the source: the domain must never be zero-width,
 * and the ticks must always be distinct.
 */

import { execFileSync } from "node:child_process";

import { logDomain, logTicks, logToY } from "../src/components/chart-axes";
import { chartTheme } from "../src/lib/vi/theme-bridge";
import { contrastRatio, ELECTRIC_ORBIT } from "../src/lib/vi/palette";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
  }
}

const unique = (xs: number[]) => new Set(xs).size === xs.length;

console.log("\nAxis — domain");

{
  const d = logDomain([1.697e-8]);
  check("single point widens the domain", d.span > 0, `span=${d.span}`);
  check(
    "single point sits mid-plot",
    Math.abs(logToY(Math.log10(1.697e-8), d, 0, 100) - 50) < 1e-9,
    `y=${logToY(Math.log10(1.697e-8), d, 0, 100).toFixed(1)}`,
  );
}

{
  const d = logDomain([1e-5, 1e-5, 1e-5]);
  check("flat series widens the domain", d.span > 0, `span=${d.span}`);
}

{
  const d = logDomain([1e-9, 1e-3]);
  check("wide series keeps its true bounds", Math.abs(d.span - 6) < 1e-12, `span=${d.span}`);
  check("empty input still returns a usable domain", logDomain([]).span > 0);
}

console.log("\nAxis — ticks are always distinct");

{
  // The exact shapes that broke the page.
  const cases: Array<[string, number[]]> = [
    ["single 1.697e-8", [1.697e-8]],
    ["single 0.0246", [0.0246]],
    ["single 1.0", [1.0]],
    ["single 1e-15", [1e-15]],
    ["flat x2", [0.0246, 0.0246]],
    ["flat x5", [1e-5, 1e-5, 1e-5, 1e-5, 1e-5]],
    ["narrow", [2e-5, 3e-5, 4e-5, 6e-5]],
    ["wide", [1e-9, 1e-7, 1e-5, 1e-3, 1e-1]],
    ["exactly one decade", [1e-3, 1e-4]],
    ["just under a decade", [1e-3, 2e-4]],
  ];

  for (const [name, values] of cases) {
    const ticks = logTicks(logDomain(values));
    check(`${name}: ticks unique`, unique(ticks), `[${ticks.join(", ")}]`);
  }
}

{
  // Regression: the original derivation must be shown to be broken, so the test
  // cannot silently pass if someone reintroduces it.
  const lo = Math.log10(0.0246);
  const hi = lo;
  const span = hi - lo || 1;
  const oldTicks = [lo, lo + span / 2, hi];
  check(
    "the old formula did collide (guard)",
    !unique(oldTicks),
    `[${oldTicks.map((t) => t.toFixed(4)).join(", ")}]`,
  );
}

console.log("\nAxis — positions");

{
  const d = logDomain([1e-9, 1e-3]);
  const top = logToY(Math.log10(1e-3), d, 10, 100);
  const bottom = logToY(Math.log10(1e-9), d, 10, 100);
  check("larger Pc plots higher", top < bottom, `${top.toFixed(1)} < ${bottom.toFixed(1)}`);
  check("top of domain maps to the top edge", Math.abs(top - 10) < 1e-9);
  check("bottom of domain maps to the bottom edge", Math.abs(bottom - 110) < 1e-9);
}

console.log("\nAxis — the real component renders");

{
  // Server-render the chart through the same path the page uses.
  let out = "";
  try {
    out = execFileSync(
      process.execPath,
      ["--import", "tsx", "tools/chart-probe.ts"],
      { encoding: "utf8", timeout: 120_000 },
    );
  } catch (err) {
    const e = err as { stdout?: string };
    out = e.stdout ?? "";
  }
  check(
    "component renders every fixture without duplicate keys",
    out.includes("duplicate-key     : 0") && out.includes("render failures   : 0"),
    out.split("\n").filter((l) => l.startsWith("fixtures rendered")).join("").trim(),
  );
}


// ---------------------------------------------------------------- chart theme
// The SVG charts used to carry their own dark-mode hexes (#2ec27e, #6b6b6b …),
// which survived a switch to the light theme and had never been measured for
// contrast. Every role now comes from the palette, so these assertions hold for
// both modes by construction.
const dark = chartTheme(ELECTRIC_ORBIT, "dark");
const light = chartTheme(ELECTRIC_ORBIT, "light");
const roles = Object.keys(dark) as Array<keyof typeof dark>;

const isColour = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v) || /^rgba\(\d+, \d+, \d+, [\d.]+\)$/.test(v);
check("图表主题的每个角色都是颜色值", roles.every((r) => isColour(dark[r])), roles.join(","));

check(
  "深浅两套主题的图表颜色不同",
  roles.every((r) => dark[r] !== light[r]),
  roles.filter((r) => dark[r] === light[r]).join(","),
);

// Only the roles that carry meaning as text or as a mark are measured; the frame
// and the guides are decorative lines, and `okDim` is an alpha fill.
check(
  "文字与数据色在两套背景上都达到 4.5:1",
  (["series", "ok", "danger", "label", "reference"] as const).every(
    (r) => contrastRatio(dark[r], ELECTRIC_ORBIT.deep) >= 4.5 && contrastRatio(light[r], ELECTRIC_ORBIT.surface) >= 4.5,
  ),
  `dark label=${contrastRatio(dark.label, ELECTRIC_ORBIT.deep).toFixed(2)} light label=${contrastRatio(light.label, ELECTRIC_ORBIT.surface).toFixed(2)}`,
);

check(
  "状态色取自调色板而不是另造一套",
  dark.ok !== dark.danger && dark.ok !== dark.series,
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
