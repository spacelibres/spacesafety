/**
 * Restore the Spacebook model rows into `model_asset`.
 *
 * ## Why this is a separate step
 *
 * There are two model tables and only one of them is read by the UI:
 *
 *   `spacebook_model`  the Spacebook catalogue, maintained by
 *                      `npm run spacebook:models` (42 public `.glb` assets)
 *   `model_asset`      what `/models` and `/api/models/*` serve, filled by
 *                      `tools/models-sync.ts` from NASA's repository (257 meshes)
 *
 * Nothing ever copied the Spacebook rows across, so the model library was 257 while
 * the documented total was 299. The two sync scripts each maintained their own table
 * and both reported success.
 *
 * The `.glb` files for the 42 are not on disk — they need a Spacebook session that
 * the token cannot renew. So this inserts the rows with `local_path` set to NULL
 * rather than to a path that does not exist: a row pointing at a missing file is
 * worse than an honest "not downloaded", because the viewer would try to load it and
 * fail at render time.
 *
 * Run: npx tsx tools/models-restore-spacebook.ts
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

const DB = process.env.SPACE_SAFETY_DB ?? "data/catalogue.sqlite";
const MODEL_ROOT = "data/models";

function main(): void {
  const db = new Database(DB);

  const existing = db.prepare("SELECT COUNT(*) AS n FROM spacebook_model").get() as { n: number };
  if (existing.n === 0) {
    console.log("\n  spacebook_model 为空，先运行 npm run spacebook:models\n");
    db.close();
    return;
  }

  const rows = db
    .prepare("SELECT id, filename, name, fetched_at FROM spacebook_model")
    .all() as Array<{ id: string; filename: string; name: string; fetched_at: string }>;

  const insert = db.prepare(
    `INSERT INTO model_asset
       (id, source, name, path, filename, url, size_bytes, preview_url, local_path, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );

  let present = 0;
  let missing = 0;
  db.transaction(() => {
    for (const r of rows) {
      const rel = join(MODEL_ROOT, r.filename);
      const hasFile = existsSync(rel);
      if (hasFile) present += 1;
      else missing += 1;
      insert.run(
        r.id,
        "spacebook",
        r.name,
        `/api/models/${r.filename}`,
        r.filename.split("/").pop() ?? r.filename,
        `spacebook://${r.filename}`,
        hasFile ? rel : null,
        r.fetched_at,
      );
    }
  })();

  const total = db.prepare("SELECT COUNT(*) AS n FROM model_asset").get() as { n: number };
  const bySource = db
    .prepare("SELECT source, COUNT(*) AS n FROM model_asset GROUP BY source ORDER BY n DESC")
    .all() as Array<{ source: string; n: number }>;

  console.log("\n  Spacebook 模型行恢复\n");
  console.log(`  spacebook_model 记录    ${rows.length}`);
  console.log(`  本地文件存在            ${present}`);
  console.log(`  本地文件缺失            ${missing}`);
  console.log("\n  model_asset 现状\n");
  for (const s of bySource) console.log(`  ${s.source.padEnd(12)}${String(s.n).padStart(6)}`);
  console.log(`  ${"合计".padEnd(12)}${String(total.n).padStart(6)}`);
  console.log("");

  db.close();
}

main();
