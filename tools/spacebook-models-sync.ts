/**
 * Sync the Spacebook 3D model catalogue.
 *
 * Small and complete (42 public `.glb` assets), so the run is a full replace. It
 * needs a token, and the token cannot be refreshed — see `spacebook-models.ts`. When
 * the token has expired this exits with an instruction rather than silently doing
 * nothing, because a sync that reports success while writing zero rows is how the
 * `__keeptrack` column stayed empty for a day.
 *
 * Run: npx tsx tools/spacebook-models-sync.ts
 */

import Database from "better-sqlite3";

import { loadEnvLocal } from "../scripts/env";
import { fetchModels, SpacebookModelStore } from "../src/lib/sources/spacebook-models";

loadEnvLocal();

async function main(): Promise<void> {
  const dbPath = process.env.SPACE_SAFETY_DB ?? "./data/catalogue.sqlite";

  console.log("\n  Spacebook 三维模型同步\n");

  const { models, note, needsLogin } = await fetchModels();
  if (needsLogin) {
    console.error(`  ${note}\n  运行 npm run spacebook:login 后在浏览器完成授权\n`);
    process.exit(1);
  }
  if (note) {
    console.error(`  失败：${note}\n`);
    process.exit(1);
  }
  if (models.length === 0) {
    console.error("  接口返回 0 条，未写入\n");
    process.exit(1);
  }

  const db = new Database(dbPath);
  const store = new SpacebookModelStore(db);
  const n = store.replaceAll(models);

  const pub = models.filter((m) => m.isPublic).length;
  console.log(`  模型        ${n} 个，其中公开 ${pub} 个`);
  console.log(`  存储        spacebook_model`);

  const sample = models.filter((m) => m.isPublic).slice(0, 8);
  console.log(`\n  样例：`);
  for (const m of sample) {
    console.log(`    ${m.name.padEnd(24)} ${m.filename}`);
  }

  db.close();
  console.log("");
}

void main();
