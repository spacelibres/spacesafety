/**
 * Forecast-skill baseline: how far apart are two independent forecasts of the
 * same object, and does that separation stay inside the stated uncertainty?
 *
 * This is the measurement a Pc has to rest on. A collision probability is only as
 * trustworthy as the position uncertainty, and the uncertainty is not a constant:
 * it grows along the prediction arc. The report below states, per horizon, both
 * the observed separation between two forecasts and the ratio of that separation
 * to the claimed 1-sigma.
 *
 *   npm run forecast:baseline
 *   npm run forecast:baseline -- --objects 500
 *   npm run forecast:baseline -- --json
 */

async function main(): Promise<void> {
  const { loadEnvLocal } = await import("./env");
  loadEnvLocal();

  const { getDb } = await import("../src/db");
  const { compareHorizons } = await import("../src/lib/core/forecast-baseline");

  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const asJson = argv.includes("--json");
  const limit = Number(flag("--objects") ?? 10_000);

  const { sqlite } = getDb();
  const report = compareHorizons(sqlite, { objectLimit: limit });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("\n预报一致性基线（OCM vs Modified ITC，同一对象的两个独立产品）\n");
  console.log(`  具备 OCM+ITC 的对象   ${report.objects}`);
  console.log(`  弧段重叠、可比        ${report.comparable}`);

  if (report.horizons.length === 0) {
    console.log("\n  没有可比数据：需要同一对象同时具备 OCM 与 ITC。\n");
    return;
  }

  console.log();
  console.log("  时长  样本  OCM龄  ITC龄   总分离  径向   相位   |Δr|/σ   3σ内");
  for (const h of report.horizons) {
    const within = h.withSigma ? `${h.within3Sigma}/${h.withSigma}` : "—";
    console.log(
      `  ${String(h.horizonHours).padStart(3)}h ${String(h.n).padStart(5)}  ` +
        `${fmt(h.medianOcmAgeHours).padStart(6)}h ${fmt(h.medianItcAgeHours).padStart(6)}h  ` +
        `${fmt(h.medianKm).padStart(10)}km ${fmt(h.medianRadialKm).padStart(8)}km ` +
        `${fmt(h.medianPhaseMinutes).padStart(7)}min ${fmt(h.medianRatio).padStart(9)}  ${within}`,
    );
  }

  if (report.growthKmPerHour !== null) {
    console.log(
      `\n  分离量增长率   ${report.growthKmPerHour.toFixed(2)} km/h ` +
        `（首末两个预报时长的中位分离之差）`,
    );
  }

  for (const note of report.notes) console.log(`  · ${note}`);

  console.log(
    "\n  解读（必须按此理解，否则会得出错误结论）：\n" +
      "    · 总分离主要由两个产品的相位偏置决定，不是预报误差；\n" +
      "    · 径向分离才是轨道形状的一致程度，本例在米级；\n" +
      "    · |Δr|/σ 把相位偏置也除了进去，所以它会极大（上千）——\n" +
      "      这本身不能证明任何一方低估了不确定度，只能说明两者起点不同步。\n" +
      "    · 若要评估预报精度，需要同源跨日观测，而非两个不同产品相减。\n",
  );
}

const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(3));

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
