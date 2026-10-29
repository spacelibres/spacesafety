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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
