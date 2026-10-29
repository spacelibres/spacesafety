/**
 * Chart rendering probe.
 *
 * The Pc history chart is shared between server and client. The duplicate-key
 * warning that prompted this file came from the **server** render: React reports
 * repeated keys during hydration/SSR, while a purely client-side render can stay
 * silent. So this probe renders the real component with `renderToString`, which
 * is the same code path the page uses, and inspects the console.
 *
 * Fixtures are chosen to break naive axis code:
 *   - a single point — makes the log domain zero-width, which is exactly what
 *     produced `[lo, lo + 0.5, lo]` and two identical keys;
 *   - a flat series — the same zero-width problem from repeated values;
 *   - a narrow series — all values inside one decade;
 *   - a wide series spanning several decades;
 *   - NULL probabilities interleaved, which must be skipped, not plotted.
 *
 *   npx tsx tools/chart-probe.ts
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface Point {
  id: string;
  createdAt: string;
  pc: number | null;
  isActive: boolean;
  source1: string;
  source2: string;
}

function series(name: string, pcs: Array<number | null>): { name: string; points: Point[] } {
  return {
    name,
    points: pcs.map((pc, i) => ({
      id: `${name}-${i}`,
      createdAt: `2026-10-26T0${i}:00:00Z`,
      pc,
      isActive: i === pcs.length - 1,
      source1: "operator_ephemeris",
      source2: "operator_ephemeris",
    })),
  };
}

const FIXTURES = [
  series("single", [1.697e-8]),
  series("single-high-pc", [0.0246]),
  series("flat", [1e-5, 1e-5, 1e-5, 1e-5]),
  series("narrow", [2e-5, 3e-5, 4e-5, 6e-5]),
  series("wide", [1e-9, 1e-7, 1e-5, 1e-3, 1e-1]),
  series("nulls", [1e-6, null, 5e-6, null, 2e-5]),
];

async function main() {
  const React = require("react") as typeof import("react");
  // tsx transpiles the .tsx source with the classic runtime, which expects a
  // global `React`. The Next build uses the automatic runtime, so this shim only
  // exists for the probe.
  (globalThis as { React?: unknown }).React = React;
  const { renderToStaticMarkup } = require("react-dom/server") as {
    renderToStaticMarkup: (el: unknown) => string;
  };

  // tsx can import the .tsx source directly.
  const mod = (await import("../src/components/Charts")) as {
    PcHistoryChart: import("react").ComponentType<{ points: Point[] }>;
  };

  // Capture everything React prints while rendering, at every severity.
  const messages: string[] = [];
  const originals = {
    error: console.error,
    warn: console.warn,
  };
  console.error = (...args: unknown[]) => messages.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => messages.push(args.map(String).join(" "));

  let rendered = 0;
  let markupFailures = 0;
  try {
    for (const fixture of FIXTURES) {
      try {
        const html = renderToStaticMarkup(
          React.createElement(mod.PcHistoryChart, { points: fixture.points }),
        );
        if (html.includes("sparkline") || html.includes("No probability values")) rendered += 1;
        // A chart must never emit two identical keys. The empty state for an
        // all-NULL series is fine, but a rendered chart should have content.
      } catch (err) {
        markupFailures += 1;
        messages.push(`render threw for ${fixture.name}: ${String(err)}`);
      }
    }
  } finally {
    console.error = originals.error;
    console.warn = originals.warn;
  }

  const duplicateKey = messages.filter((m) => /two children with the same key/i.test(m));
  const other = messages.filter((m) => !/two children with the same key/i.test(m) && m.trim());

  console.log(`fixtures rendered : ${rendered}/${FIXTURES.length}`);
  console.log(`render failures   : ${markupFailures}`);
  console.log(`duplicate-key     : ${duplicateKey.length}`);
  for (const m of duplicateKey.slice(0, 4)) console.log("  " + m.slice(0, 160));
  console.log(`other warnings    : ${other.length}`);
  for (const m of other.slice(0, 6)) console.log("  " + m.slice(0, 160));

  const ok = rendered === FIXTURES.length && markupFailures === 0 && duplicateKey.length === 0 && other.length === 0;
  console.log(ok ? "\nOK" : "\nFAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
