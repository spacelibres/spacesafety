/**
 * Build the unified database: merge the sources (L1), then compute (L2).
 *
 *   npm run master:build
 *   npm run master:build -- --skip-orbits
 *   npm run master:build -- --report
 *
 * ## Why this is a separate step and not part of ingest
 *
 * Ingest records what a provider said, one row per provider. The merge decides
 * what *we* believe, and that decision must be visible and re-runnable: when a
 * precedence rule changes, the merge is rebuilt in seconds without re-downloading
 * 507 MB, and every number in the derived layer is recomputed from the new base.
 *
 * ## Order matters
 *
 * L1 first, then L2. The derived layer reads `master_element_set` to know which
 * orbit to summarise; computing it against a half-written base would summarise the
 * wrong source.
 */

async function main(): Promise<void> {
  const { loadEnvLocal } = await import("./env");
  loadEnvLocal();

  const { getDb } = await import("../src/db");
  const { MasterMerge } = await import("../src/lib/sources/master-merge");
  const { DerivedLayer } = await import("../src/lib/sources/derived-layer");
  const { ClassNormaliser } = await import("../src/lib/sources/class-normalise");

  const argv = process.argv.slice(2);
  const skipOrbits = argv.includes("--skip-orbits");
  const reportOnly = argv.includes("--report");

  const { sqlite } = getDb();

  if (!reportOnly) {
    console.log("\n=== L1 合并：把各源的数据合成一份事实 ===\n");
    const merge = new MasterMerge(sqlite, { log: () => {} }).run();

    console.log(`  对象全集           ${merge.universe}`);
    console.log(`  写入主表           ${merge.objects}`);
    console.log(`  选定规范星历       ${merge.withElements}`);
    console.log(`  有质量             ${merge.withMass}`);
    console.log(`  有横截面积         ${merge.withCrossSection}`);
    console.log(`  记录冲突           ${merge.conflicts}`);
    for (const [field, n] of Object.entries(merge.conflictsByField).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${field.padEnd(16)} ${n}`);
    }
    console.log(`  星历来源分布：`);
    for (const [src, n] of Object.entries(merge.bySource).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${src.padEnd(24)} ${n}`);
    }
    console.log(`  耗时               ${(merge.ms / 1000).toFixed(1)}s`);

    // Classification is a separate, auditable decision on top of the merge. It
    // rewrites only `object_class` and `maneuverable`, so a change to the scheme
    // never requires re-merging 72 000 objects.
    const normalised = new ClassNormaliser(sqlite).run();
    console.log("\n=== 编目归一 ===\n");
    console.log(`  分类值改写         ${normalised.changed}`);
    console.log(`  机动性纠正         ${normalised.manoeuvrabilityFixed}`);
    console.log(`  耗时               ${(normalised.ms / 1000).toFixed(1)}s`);
    console.log(`\n  归一后的分类：`);
    for (const [cls, n] of Object.entries(normalised.after)) {
      console.log(`    ${cls.padEnd(34)} ${String(n).padStart(7)}`);
    }

    console.log("\n=== L2 派生：我们计算出来的数 ===\n");
    const derived = new DerivedLayer(sqlite, { skipOrbits, log: () => {} }).run();
    console.log(`  对象               ${derived.objects}`);
    console.log(`  派生值行数         ${derived.rows}`);
    console.log(`  含轨道摘要         ${derived.withOrbitSummary}`);
    console.log(`  耗时               ${(derived.ms / 1000).toFixed(1)}s`);
  }

  // ---------------------------------------------------------------- report
  console.log("\n=== 主库现状 ===\n");

  const counts = sqlite
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM master_object) AS objects,
         (SELECT COUNT(*) FROM master_object WHERE mass_kg IS NOT NULL) AS withMass,
         (SELECT COUNT(*) FROM master_object WHERE cross_section_avg_m2 IS NOT NULL) AS withArea,
         (SELECT COUNT(*) FROM master_object WHERE object_class = 'Payload') AS payloads,
         (SELECT COUNT(*) FROM master_element_set) AS elements,
         (SELECT COUNT(*) FROM derived_state) AS derived,
         (SELECT COUNT(*) FROM master_conflict) AS conflicts`,
    )
    .get() as Record<string, number>;

  console.log("  L1 观测/合并");
  console.log(`    master_object              ${counts.objects}`);
  console.log(`      其中 Payload             ${counts.payloads}`);
  console.log(`      有质量                   ${counts.withMass}`);
  console.log(`      有横截面积               ${counts.withArea}`);
  console.log(`    master_element_set         ${counts.elements}`);

  console.log("\n  L2 派生（可随时重算，不影响 L1）");
  const kinds = sqlite
    .prepare(
      `SELECT kind, COUNT(*) AS n, COUNT(DISTINCT field) AS fields
         FROM derived_state GROUP BY kind ORDER BY n DESC`,
    )
    .all() as Array<{ kind: string; n: number; fields: number }>;
  for (const k of kinds) {
    console.log(`    ${k.kind.padEnd(26)} ${String(k.n).padStart(8)}  (${k.fields} 个字段)`);
  }

  console.log("\n  L3 未决冲突");
  const conflicts = sqlite
    .prepare(
      `SELECT field, resolution, COUNT(*) AS n
         FROM master_conflict GROUP BY field, resolution ORDER BY n DESC`,
    )
    .all() as Array<{ field: string; resolution: string; n: number }>;
  if (conflicts.length === 0) {
    console.log("    （无）");
  } else {
    for (const c of conflicts) {
      console.log(`    ${c.field.padEnd(16)} ${c.resolution.padEnd(12)} ${c.n}`);
    }
  }

  console.log("\n  注意：L2 中的数值是计算结果，不是观测值。引用时必须说明来源层级。\n");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
