/**
 * Pull CelesTrak's complete SOCRATES screening into the catalogue database.
 *
 * Run:
 *   npm run socrates:sync
 *
 * This supersedes `keeptrack:feeds -- --only conjunctions`, which wrote ten rows.
 * See `src/lib/sources/celestrak-socrates.ts` for why the KeepTrack copy is unusable.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { loadEnvLocal } from "../scripts/env";
import { fetchSocratesFull } from "../src/lib/sources/celestrak-socrates";
import { SocratesStore } from "../src/lib/sources/socrates-store";

loadEnvLocal();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const dbPath = arg("--db") ?? process.env.SPACE_SAFETY_DB ?? "./data/catalogue.sqlite";
  const archiveDir = arg("--archive-dir") ?? "data/archive/socrates";

  console.log("\n  CelesTrak SOCRATES 同步\n");

  const started = Date.now();
  const { rows, skipped, bytes, lastModified } = await fetchSocratesFull();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  下载        ${(bytes / 1_048_576).toFixed(1)} MB，${seconds} s`);
  console.log(`  解析        ${rows.length} 个交会事件${skipped ? `，跳过 ${skipped} 行` : ""}`);

  if (skipped > 0) {
    console.log(`              跳过行说明有列错位风险，请核查原始文件`);
  }

  const day = new Date().toISOString().slice(0, 10);
  const dir = join(archiveDir, day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `socrates-${day}.json`),
    JSON.stringify({ lastModified, rows }, null, 0),
  );

  const db = new Database(dbPath);
  const store = new SocratesStore(db);
  const n = store.replaceAll(rows, {
    source: "celestrak.org/SOCRATES/sort-minRange.csv",
    source_last_modified: lastModified ?? "",
    row_count: String(rows.length),
  });

  const withPc = rows.filter((r) => r.maxProb !== null).length;
  const under1km = rows.filter((r) => r.minRangeKm !== null && r.minRangeKm < 1).length;
  const closest = rows.reduce(
    (a, r) => (r.minRangeKm !== null && (a === null || r.minRangeKm < a) ? r.minRangeKm : a),
    null as number | null,
  );
  const now = Date.now();
  const future = rows.filter((r) => r.tca !== null && Date.parse(r.tca) > now).length;

  console.log(`  入库        ${n} 行`);
  console.log(`              带 Pc ${withPc}  1 km 内 ${under1km}  最近 ${closest} km  TCA 未过 ${future}`);

  if (store.keepTrackTableExists()) {
    db.prepare("DROP TABLE IF EXISTS keeptrack_conjunction").run();
    console.log(`  清理        已删除 keeptrack_conjunction（10 行旧副本）`);
  }
  db.close();
  console.log("");
}

void main();
