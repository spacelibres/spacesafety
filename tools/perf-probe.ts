/**
 * Where the `/catalogue` request time actually goes.
 *
 * The page was measured at a steady 1.1–1.4 s per request while `listWideObjects`
 * takes 1 ms and `COUNT(*)` takes 2 ms, so the cost is elsewhere. This prints the
 * split so the fix targets the real query rather than the one that looks big.
 *
 * Run: npx tsx tools/perf-probe.ts
 */

import { performance } from "node:perf_hooks";

import { loadEnvLocal } from "../scripts/env";

async function main(): Promise<void> {
  loadEnvLocal();
  const { getDb } = await import("../src/db");
  const { listWideObjects, countWideObjects, wideStats } = await import("../src/lib/wide-catalogue");

  const h = getDb();
  console.log(`\n  wideAttached = ${h.wideAttached}\n`);

  const time = (label: string, fn: () => unknown): void => {
    const t = performance.now();
    const r = fn();
    const ms = performance.now() - t;
    const extra = typeof r === "number" ? `  =${r}` : Array.isArray(r) ? `  rows=${r.length}` : "";
    console.log(`  ${label.padEnd(22)}${ms.toFixed(1).padStart(8)} ms${extra}`);
  };

  time("COUNT(*)", () => countWideObjects());
  time("listWideObjects(100)", () => listWideObjects({ limit: 100, offset: 0 }).length);
  time("listWideObjects(100) 再跑", () => listWideObjects({ limit: 100, offset: 0 }).length);
  time("wideStats()", () => wideStats().objects);

  // Warm, to separate "first call pays for statement preparation" from a genuinely
  // expensive query.
  wideStats();
  time("wideStats() 第二次", () => wideStats().objects);

  // The coverage aggregate on its own: one full scan per field per source.
  const t = performance.now();
  h.sqlite
    .prepare(
      `SELECT SUM(CASE WHEN name__spacetrack IS NOT NULL THEN 1 ELSE 0 END) AS a,
              SUM(CASE WHEN inclination_deg__spacetrack IS NOT NULL THEN 1 ELSE 0 END) AS b
         FROM wide.catalogue_wide`,
    )
    .get();
  console.log(`  ${"单字段聚合 ×2".padEnd(22)}${(performance.now() - t).toFixed(1).padStart(8)} ms`);

  console.log("");
}

main();
