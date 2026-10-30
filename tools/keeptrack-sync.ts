/**
 * Localise the KeepTrack catalogue.
 *
 * One request brings the whole source down — 50 539 objects in about 8 s and 24 MB.
 * There is nothing to page and nothing to resume, so the operation is a full
 * replace: a fetch either completes and supersedes the old table, or fails and
 * leaves it untouched. That is simpler and safer than a partial merge, which would
 * leave rows from an aborted run looking current.
 *
 * ## Why the raw response is also archived
 *
 * The parsed table keeps the fields this project uses. The raw JSON keeps everything,
 * including fields KeepTrack may add later, so a future question can be answered from
 * what was actually received rather than from a re-request that may by then return
 * something different. It is 24 MB per day, which is affordable; the three primary
 * catalogues are archived the same way.
 *
 * Run:
 *   npx tsx tools/keeptrack-sync.ts
 *   npx tsx tools/keeptrack-sync.ts --dry-run
 *   npx tsx tools/keeptrack-sync.ts --db data/catalogue.sqlite
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { loadEnvLocal } from "../scripts/env";
import { fetchAllKeepTrack, KeepTrackStore } from "../src/lib/sources/keeptrack";

loadEnvLocal();

function parseArgs(argv: string[]) {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    db: flag("--db") ?? process.env.SPACE_SAFETY_DB ?? "./data/catalogue.sqlite",
    dryRun: argv.includes("--dry-run"),
    archiveDir: flag("--archive-dir") ?? "data/archive/keeptrack-sats",
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log("\n  KeepTrack 全量同步\n");
  const started = Date.now();

  const { records, total, errors, provisional, note } = await fetchAllKeepTrack();
  if (note) {
    console.error(`  失败：${note}\n`);
    process.exit(1);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  收到        ${total} 条，解析 ${records.length}，无标识 ${errors}`);
  console.log(`  其中临时编号  ${provisional ?? 0}（无 NORAD，按 COSPAR 归档）`);
  console.log(`  耗时        ${elapsed}s`);

  if (args.dryRun) {
    const has = (f: keyof (typeof records)[number]) =>
      records.filter((r) => r[f] !== null && r[f] !== "").length;
    for (const f of ["manufacturer", "bus", "shape", "launchMassKg", "spanM", "motor"] as const) {
      const n = has(f);
      console.log(`  ${f.padEnd(16)} ${String(n).padStart(6)}  ${((n / records.length) * 100).toFixed(1)}%`);
    }
    console.log("\n  --dry-run，未写入\n");
    return;
  }

  // Archive the parsed records before writing, so the table can always be rebuilt
  // from what was received even if this process dies mid-write.
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(args.archiveDir, day);
  mkdirSync(dir, { recursive: true });
  const archivePath = join(dir, `keeptrack-${day}.json`);
  writeFileSync(archivePath, JSON.stringify(records));
  console.log(`  归档        ${archivePath}`);

  const db = new Database(args.db);
  const store = new KeepTrackStore(db);
  const written = store.replaceAll(records);

  console.log(`  写入        keeptrack_object ${written} 行`);
  console.log(`\n  字段覆盖：`);
  for (const c of store.coverage()) {
    console.log(`    ${c.field.padEnd(16)} ${String(c.n).padStart(6)}  ${c.pct.toFixed(1)}%`);
  }

  db.close();
  console.log("");
}

void main();
