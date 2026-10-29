/**
 * Evidence-driven source analysis.
 *
 * Every number this produces is computed from the database or from an archived
 * capture, and every finding carries its own sample size. There is no inference
 * step: if the data cannot support a statement, the report says so and names the
 * missing input rather than estimating.
 *
 * ## What is measured
 *
 * 1. **Coverage** — which catalogue numbers does each source know, and in what
 *    combination. This decides what is even comparable.
 * 2. **Freshness** — the epoch age of each source relative to the newest source
 *    for the same object. Measured per object, then summarised, never assumed.
 * 3. **Consistency** — for objects two sources both hold, propagate both to one
 *    instant and decompose the separation into radial and along-track parts.
 * 4. **Physical model** — how much of the cross-section data actually exists, by
 *    object class, because a mean area over 6% of the catalogue is not evidence.
 * 5. **Internal consistency** — cross-format checks: the same provider's JSON,
 *    KVN and XML bodies must describe the same records, or the provider is
 *    rewriting history between endpoints.
 *
 *   npm run analyze
 *   npm run analyze -- --fast        # skip the propagation pass
 *   npm run analyze -- --sample 5000
 *   npm run analyze -- --json        # machine-readable summary only
 */

import { readFile, writeFile } from "node:fs/promises";

async function main(): Promise<void> {
  const { loadEnvLocal } = await import("../scripts/env");
  loadEnvLocal();

  const { getDb } = await import("../src/db");
  const { SourceArchive } = await import("../src/lib/sources/archive");
  const { parseTleFile } = await import("../src/lib/orbit/tle");

  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const fast = argv.includes("--fast");
  const asJson = argv.includes("--json");
  const sampleLimit = Number(flag("--sample") ?? 4000);

  const { sqlite } = getDb();
  const archive = new SourceArchive();

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    database: {},
    coverage: {},
    freshness: {},
    physical: {},
    crossFormat: {},
    consistency: {},
  };

  const log = (line = "") => {
    if (!asJson) console.log(line);
  };
  const head = (title: string) => {
    log();
    log("=".repeat(74));
    log(title);
    log("=".repeat(74));
  };

  // ---------------------------------------------------------------- 1. DB state
  head("1. 数据库状态");

  const dbCounts = sqlite
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM satcat) AS satcat,
         (SELECT COUNT(*) FROM discos_objects) AS discos,
         (SELECT COUNT(*) FROM discos_objects WHERE mass IS NOT NULL) AS discosMass,
         (SELECT COUNT(*) FROM discos_objects WHERE x_sect_avg IS NOT NULL) AS discosArea,
         (SELECT COUNT(*) FROM objects) AS objects,
         (SELECT COUNT(*) FROM trajectories) AS trajectories,
         (SELECT COUNT(*) FROM object_sources) AS states,
         (SELECT COUNT(*) FROM data_sources) AS sources,
         (SELECT COUNT(*) FROM source_fetches WHERE status='ok') AS fetchesOk`,
    )
    .get() as Record<string, number>;

  report.database = dbCounts;
  for (const [k, v] of Object.entries(dbCounts)) log(`  ${k.padEnd(14)} ${v}`);

  // ------------------------------------------------------------- 2. Coverage
  head("2. 覆盖度：每个源认识哪些对象");

  const perSource = sqlite
    .prepare(
      `SELECT source_id AS id, COUNT(*) AS objects, MIN(epoch) AS oldest, MAX(epoch) AS newest
         FROM object_sources GROUP BY source_id ORDER BY objects DESC`,
    )
    .all() as Array<{ id: string; objects: number; oldest: string | null; newest: string | null }>;

  log();
  log("  源                          对象数         最早历元              最新历元");
  for (const row of perSource) {
    log(
      `  ${row.id.padEnd(26)} ${String(row.objects).padStart(7)}   ` +
        `${(row.oldest ?? "—").slice(0, 19).padEnd(20)} ${(row.newest ?? "—").slice(0, 19)}`,
    );
  }

  // Set overlap between the two full element-set providers.
  const overlap = sqlite
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM object_sources WHERE source_id='space-track') AS st,
         (SELECT COUNT(*) FROM object_sources WHERE source_id='spacebook-entity-tle') AS sb,
         (SELECT COUNT(*) FROM object_sources a JOIN object_sources b
            ON a.norad_id=b.norad_id
           WHERE a.source_id='space-track' AND b.source_id='spacebook-entity-tle') AS both`,
    )
    .get() as { st: number; sb: number; both: number };

  const onlySt = overlap.st - overlap.both;
  const onlySb = overlap.sb - overlap.both;

  log();
  log("  Space-Track ∩ Spacebook(entity/tle)：");
  log(`    Space-Track 独有   ${String(onlySt).padStart(7)}`);
  log(`    Spacebook 独有     ${String(onlySb).padStart(7)}`);
  log(`    两者都有           ${String(overlap.both).padStart(7)}`);
  log(
    `    并集               ${String(onlySt + onlySb + overlap.both).padStart(7)}  ` +
      `（单向覆盖遗漏 ${((onlySb / (onlySt + onlySb + overlap.both)) * 100).toFixed(2)}%）`,
  );

  // Which DISCOS objects have no element set at all — the physical model is
  // useless for an object nobody tracks.
  const discosOrphan = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM discos_objects d
        WHERE NOT EXISTS (SELECT 1 FROM object_sources o WHERE o.norad_id = d.norad_id)`,
    )
    .get() as { n: number };

  // Which tracked objects have no physical model — the converse gap, and the one
  // that limits Pc quality.
  const noMass = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM objects o
        WHERE NOT EXISTS (SELECT 1 FROM discos_objects d
                           WHERE d.norad_id = o.norad_id AND d.mass IS NOT NULL)`,
    )
    .get() as { n: number };

  const totalObjects = dbCounts.objects;

  log();
  log("  物理模型覆盖（DISCOS 质量）");
  log(`    已跟踪但无质量           ${String(noMass.n).padStart(7)} / ${totalObjects}  ` +
      `(${((noMass.n / Math.max(1, totalObjects)) * 100).toFixed(1)}% 缺失)`);
  log(`    DISCOS 有但无任何根数    ${String(discosOrphan.n).padStart(7)}`);

  report.coverage = { perSource, onlySt, onlySb, both: overlap.both, noMass: noMass.n, discosOrphan: discosOrphan.n };

  // ------------------------------------------------------------ 3. Freshness
  head("3. 新鲜度：每个源相对最新源的历元差（逐对象测量）");

  const freshness = sqlite
    .prepare(
      `WITH newest AS (
         SELECT norad_id, MAX(epoch) AS newest FROM object_sources GROUP BY norad_id
       )
       SELECT o.source_id AS id,
              COUNT(*) AS n,
              MIN((julianday(n.newest) - julianday(o.epoch)) * 24) AS minH,
              AVG((julianday(n.newest) - julianday(o.epoch)) * 24) AS avgH,
              MAX((julianday(n.newest) - julianday(o.epoch)) * 24) AS maxH
         FROM object_sources o JOIN newest n ON n.norad_id = o.norad_id
        WHERE o.epoch IS NOT NULL AND n.newest IS NOT NULL
        GROUP BY o.source_id ORDER BY avgH`,
    )
    .all() as Array<{ id: string; n: number; minH: number; avgH: number; maxH: number }>;

  log();
  log("  源                          样本      最小h     平均h     最大h");
  for (const row of freshness) {
    log(
      `  ${row.id.padEnd(26)} ${String(row.n).padStart(7)}  ` +
        `${row.minH.toFixed(1).padStart(8)} ${row.avgH.toFixed(1).padStart(9)} ${row.maxH.toFixed(1).padStart(9)}`,
    );
  }

  // Paired comparison: same object, Space-Track vs Spacebook entity/tle. A paired
  // difference is the only sound way to ask "which is fresher", because the
  // absolute ages depend on when the sweep ran.
  const paired = sqlite
    .prepare(
      `SELECT a.norad_id AS n,
              (julianday(b.epoch) - julianday(a.epoch)) * 24 AS lagH
         FROM object_sources a JOIN object_sources b ON a.norad_id = b.norad_id
        WHERE a.source_id='space-track' AND b.source_id='spacebook-entity-tle'
          AND a.epoch IS NOT NULL AND b.epoch IS NOT NULL`,
    )
    .all() as Array<{ n: number; lagH: number }>;

  const lags = paired.map((p) => p.lagH).sort((a, b) => a - b);
  const quantile = (arr: number[], q: number) =>
    arr.length === 0 ? null : arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];
  const mean = (arr: number[]) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);

  log();
  log(`  配对差（Spacebook − Space-Track），n = ${lags.length}`);
  log(
    `    单位：小时。正数表示 Spacebook 更旧。\n` +
      `    min ${quantile(lags, 0)?.toFixed(2)}  p25 ${quantile(lags, 0.25)?.toFixed(2)}  ` +
      `median ${quantile(lags, 0.5)?.toFixed(2)}  p75 ${quantile(lags, 0.75)?.toFixed(2)}  ` +
      `p95 ${quantile(lags, 0.95)?.toFixed(2)}  max ${quantile(lags, 0.999)?.toFixed(2)}`,
  );
  const identical = lags.filter((v) => Math.abs(v) < 1e-6).length;
  log(`    完全同一历元      ${String(identical).padStart(6)}  (${((identical / Math.max(1, lags.length)) * 100).toFixed(2)}%)`);
  log(`    平均差            ${mean(lags)?.toFixed(2)} h`);

  report.freshness = {
    perSource: freshness,
    pairedSamples: lags.length,
    medianLagH: quantile(lags, 0.5),
    meanLagH: mean(lags),
    identicalEpochs: identical,
  };

  // ------------------------------------------------------- 4. Physical model
  head("4. 物理模型：按对象类别统计覆盖率");

  const physical = sqlite
    .prepare(
      `SELECT d.object_class AS cls,
              COUNT(*) AS n,
              SUM(CASE WHEN d.mass IS NOT NULL THEN 1 ELSE 0 END) AS withMass,
              SUM(CASE WHEN d.x_sect_avg IS NOT NULL THEN 1 ELSE 0 END) AS withArea,
              AVG(CASE WHEN d.mass IS NOT NULL THEN d.mass END) AS avgMass,
              AVG(CASE WHEN d.x_sect_avg IS NOT NULL THEN d.x_sect_avg END) AS avgArea,
              MIN(CASE WHEN d.x_sect_avg IS NOT NULL THEN d.x_sect_min END) AS minArea,
              MAX(CASE WHEN d.x_sect_avg IS NOT NULL THEN d.x_sect_max END) AS maxArea
         FROM discos_objects d GROUP BY d.object_class ORDER BY n DESC`,
    )
    .all() as Array<{
    cls: string | null;
    n: number;
    withMass: number;
    withArea: number;
    avgMass: number | null;
    avgArea: number | null;
    minArea: number | null;
    maxArea: number | null;
  }>;

  log();
  log("  类别              对象数   有质量   有截面       平均质量kg   平均截面m²  截面范围m²");
  for (const row of physical) {
    log(
      `  ${(row.cls ?? "(null)").padEnd(16)} ${String(row.n).padStart(7)}  ` +
        `${String(row.withMass).padStart(7)}  ${String(row.withArea).padStart(7)}  ` +
        `${(row.avgMass?.toFixed(1) ?? "—").padStart(11)}  ` +
        `${(row.avgArea?.toFixed(3) ?? "—").padStart(11)}  ` +
        `${row.minArea?.toFixed(3) ?? "—"} … ${row.maxArea?.toFixed(1) ?? "—"}`,
    );
  }
  report.physical = physical;

  // The ratio that matters for the collision model: how far a single representative
  // area can be from the true mean, per object.
  const spread = sqlite
    .prepare(
      `SELECT COUNT(*) AS n,
              AVG(x_sect_max / x_sect_avg) AS avgMaxRatio,
              MAX(x_sect_max / x_sect_avg) AS worstMaxRatio,
              AVG(x_sect_avg / x_sect_min) AS avgMinRatio
         FROM discos_objects
        WHERE x_sect_avg > 0 AND x_sect_max > 0 AND x_sect_min > 0`,
    )
    .get() as { n: number; avgMaxRatio: number; worstMaxRatio: number; avgMinRatio: number };

  log();
  log(`  截面各向异性（n = ${spread.n}）`);
  log(`    最大/平均 截面比  平均 ${spread.avgMaxRatio.toFixed(2)}×，最大 ${spread.worstMaxRatio.toFixed(2)}×`);
  log(`    平均/最小 截面比  平均 ${spread.avgMinRatio.toFixed(2)}×`);

  // ------------------------------------------------------- 5. Cross-format
  head("5. 跨格式一致性：同一供应商的 JSON / KVN / XML 是否描述同一批记录");

  const fmt: Record<string, { records: number; norads: Set<number> }> = {};

  for (const [name, id] of [
    ["json", "spacebook-omm-json"],
    ["kvn", "spacebook-omm-kvn"],
    ["xml", "spacebook-omm-xml"],
  ] as const) {
    const text = await archive.latestText(id);
    if (!text) {
      log(`  ${name}: 无归档`);
      continue;
    }
    // Record counts are format-agnostic here: every OMM body states a NORAD id per
    // record, in `NORAD_CAT_ID = n` (KVN), `"NORAD_CAT_ID":n` (JSON) or
    // `<NORAD_CAT_ID>n<` (XML). Counting distinct ids is the comparison that works
    // across all three.
    const ids = new Set<number>();
    for (const m of text.matchAll(/NORAD_CAT_ID["'>\s:=]*\s*<?["']?\s*(\d{1,6})/g)) {
      ids.add(Number(m[1]));
    }
    fmt[name] = { records: ids.size, norads: ids };
    log(`  ${name.padEnd(5)} 解析到 ${String(ids.size).padStart(6)} 个唯一 NORAD，${(text.length / 1e6).toFixed(1)} MB`);
  }

  const crossFormat: Record<string, unknown> = {};
  if (fmt.json && fmt.kvn && fmt.xml) {
    const all = [fmt.json, fmt.kvn, fmt.xml];
    const union = new Set<number>();
    for (const f of all) for (const id of f.norads) union.add(id);
    const inter = [...fmt.json.norads].filter((id) => fmt.kvn.norads.has(id) && fmt.xml.norads.has(id));
    log();
    log(`  并集 ${union.size}，三格式交集 ${inter.length}`);
    log(
      inter.length === union.size
        ? "  → 三种格式描述的记录集合完全一致"
        : `  → 不一致：有 ${union.size - inter.length} 个对象未在三种格式中同时出现`,
    );
    crossFormat.union = union.size;
    crossFormat.intersection = inter.length;
    crossFormat.consistent = inter.length === union.size;
  }
  report.crossFormat = crossFormat;

  // ------------------------------------------------------- 6. Consistency
  if (!fast) {
    head("6. 一致性：把两源根数传播到同一时刻，分解径向与沿迹差");

    // Two comparisons, because the two pairs answer different questions.
    //
    // (a) Space-Track vs Spacebook entity/tle: measured earlier in this report to
    //     share an epoch for 99.98% of objects, so this can only check the few
    //     that differ. A large result here would mean one feed rewrote elements.
    // (b) Space-Track vs Spacebook XP-TLE: the genuinely older feed, which is
    //     where an aged element set can actually be studied.
    log();
    log("-- (a) Space-Track vs Spacebook entity/tle（只比较历元真的不同的对象）");
    const sameEpochPairs = await analyzeConsistency(sqlite, sampleLimit, log);

    log();
    log("-- (b) Space-Track vs Spacebook XP-TLE（已知滞后的源）");
    const agedPairs = await analyzeConsistency(
      sqlite,
      sampleLimit,
      log,
      "space-track",
      "spacebook-xp-tle",
    );

    report.consistency = { sameEpochPairs, agedPairs };
  } else {
    log();
    log("（--fast：跳过传播一致性分析）");
  }

  // ---------------------------------------------------------------- output
  const outPath = "data/analysis-report.json";
  await writeFile(outPath, JSON.stringify(report, null, 2));
  log();
  log(`报告已写入 ${outPath}`);

  if (asJson) console.log(JSON.stringify(report, null, 2));
}

/**
 * Propagate every shared object's two element sets to one instant and split the
 * separation.
 *
 * The split is the point: a large total separation with a small radial part is an
 * aged phase, not a wrong orbit, and the two require different decisions.
 */
async function analyzeConsistency(
  sqlite: import("better-sqlite3").Database,
  limit: number,
  log: (line?: string) => void,
  sourceA = "space-track",
  sourceB = "spacebook-entity-tle",
) {
  const { propagateTle } = await import("../src/lib/orbit/sgp4");
  const { parseTleFile: parse } = await import("../src/lib/orbit/tle");

  const shared = sqlite
    .prepare(
      `SELECT a.norad_id AS n
         FROM object_sources a JOIN object_sources b ON a.norad_id = b.norad_id
        WHERE a.source_id = ? AND b.source_id = ?
          AND a.epoch IS NOT NULL AND b.epoch IS NOT NULL
          AND ABS(julianday(a.epoch) - julianday(b.epoch)) > 1e-7
        ORDER BY a.norad_id LIMIT ?`,
    )
    .all(sourceA, sourceB, limit) as Array<{ n: number }>;

  const fileStmt = sqlite.prepare(
    `SELECT t.state_source AS src, f.file_text AS text
       FROM trajectories t JOIN trajectory_files f ON f.trajectory_id = t.id
      WHERE t.object_id = (SELECT id FROM objects WHERE norad_id = ? LIMIT 1)
        AND t.state_source IN (?, ?)`,
  );
  const metaStmt = sqlite.prepare(
    "SELECT object_type AS t, period AS p FROM satcat WHERE norad_id = ? LIMIT 1",
  );

  const rows: Array<{
    norad: number;
    epochGapH: number;
    total: number;
    radial: number;
    along: number;
    phaseMin: number;
    type: string;
  }> = [];

  for (const { n } of shared) {
    const files = fileStmt.all(n, sourceA, sourceB) as Array<{ src: string; text: string }>;
    if (files.length < 2) continue;
    const tles = new Map<string, Record<string, unknown>>();
    for (const f of files) {
      const parsed = parse(f.text);
      if (parsed.tles[0]) tles.set(f.src, parsed.tles[0] as unknown as Record<string, unknown>);
    }
    const a = tles.get(sourceA);
    const b = tles.get(sourceB);
    if (!a || !b) continue;

    const epochA = a.epochMs as number;
    const epochB = b.epochMs as number;
    // Propagate the older set forward to the newer epoch: a shorter extrapolation,
    // so the SGP4 error stays as small as the data allows.
    const joint = Math.max(epochA, epochB);

    const sa = propagateTle(a as never, { startMs: joint, spanHours: 1, stepSeconds: 3_600 });
    const sb = propagateTle(b as never, { startMs: joint, spanHours: 1, stepSeconds: 3_600 });
    const pa = sa.states[0];
    const pb = sb.states[0];
    if (!pa || !pb) continue;

    const ra = Math.hypot(pa.position[0], pa.position[1], pa.position[2]);
    const rb = Math.hypot(pb.position[0], pb.position[1], pb.position[2]);
    const dx = pa.position[0] - pb.position[0];
    const dy = pa.position[1] - pb.position[1];
    const dz = pa.position[2] - pb.position[2];
    const total = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const radial = Math.abs(ra - rb);
    const along = Math.sqrt(Math.max(0, total * total - radial * radial));
    const speed = Math.hypot(pa.velocity[0], pa.velocity[1], pa.velocity[2]);
    const meta = metaStmt.get(n) as { t: string | null; p: number | null } | undefined;

    rows.push({
      norad: n,
      epochGapH: Math.abs((epochA - epochB) / 3_600_000),
      total,
      radial,
      along,
      phaseMin: speed > 0 ? along / speed / 60 : 0,
      type: meta?.t ?? "UNKNOWN",
    });
  }
  
  const stats = (arr: number[]) => {
    const s = [...arr].sort((x, y) => x - y);
    const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null);
    return {
      n: s.length,
      min: q(0),
      p50: q(0.5),
      p90: q(0.9),
      p99: q(0.99),
      max: s[s.length - 1] ?? null,
      mean: s.length ? s.reduce((acc, v) => acc + v, 0) / s.length : null,
    };
  };

  log();
  log(`  对照：${sourceA} vs ${sourceB}`);
  log(`  样本 n = ${rows.length}（两源历元确实不同的对象）`);
  log();
  log("  总量分离 (km)      " + fmtStats(stats(rows.map((r) => r.total))));
  log("  径向分离 (km)      " + fmtStats(stats(rows.map((r) => r.radial))));
  log("  沿迹分离 (km)      " + fmtStats(stats(rows.map((r) => r.along))));
  log("  相位误差 (min)     " + fmtStats(stats(rows.map((r) => r.phaseMin))));
  log("  历元差 (h)         " + fmtStats(stats(rows.map((r) => r.epochGapH))));

  // The claim to test: the disagreement is dominated by along-track phase, not by
  // a differing orbit. Measured as the share of objects where the radial part is
  // under 10% of the total.
  const phaseDominated = rows.filter((r) => r.total > 1 && r.radial / r.total < 0.1).length;
  const radialDominated = rows.filter((r) => r.total > 1 && r.radial / r.total > 0.5).length;
  log();
  log(`  径向占比 <10%（纯相位差）   ${phaseDominated} / ${rows.length}  (${((phaseDominated / Math.max(1, rows.length)) * 100).toFixed(1)}%)`);
  log(`  径向占比 >50%（轨道本身不同）${String(radialDominated).padStart(4)} / ${rows.length}  (${((radialDominated / Math.max(1, rows.length)) * 100).toFixed(1)}%)`);

  // Per object class, because debris and payloads behave differently.
  log();
  log("  按类别：");
  const byType = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }
  for (const [type, list] of [...byType].sort((x, y) => y[1].length - x[1].length)) {
    const med = (pick: (r: (typeof rows)[number]) => number) => {
      const s = list.map(pick).sort((p, q) => p - q);
      return s[Math.floor(s.length / 2)];
    };
    log(
      `    ${type.padEnd(14)} n=${String(list.length).padStart(5)}  ` +
        `总分离中位 ${med((r) => r.total).toFixed(1)} km，` +
        `径向中位 ${med((r) => r.radial).toFixed(1)} km，` +
        `相位中位 ${med((r) => r.phaseMin).toFixed(1)} min`,
    );
  }

  return {
    n: rows.length,
    sourceA,
    sourceB,
    total: stats(rows.map((r) => r.total)),
    radial: stats(rows.map((r) => r.radial)),
    along: stats(rows.map((r) => r.along)),
    phaseMinutes: stats(rows.map((r) => r.phaseMin)),
    epochGapHours: stats(rows.map((r) => r.epochGapH)),
    phaseDominated,
    radialDominated,
  };
}

function fmtStats(s: {
  n: number;
  min: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}): string {
  const f = (v: number | null) => (v === null ? "—" : v.toFixed(2).padStart(10));
  return (
    `n=${String(s.n).padStart(5)}  min${f(s.min)}  median${f(s.p50)}  ` +
    `p90${f(s.p90)}  p99${f(s.p99)}  max${f(s.max)}  mean${f(s.mean)}`
  );
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
