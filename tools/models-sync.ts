/**
 * Sync the NASA 3D model catalogue from the repository's git tree.
 *
 * ## Why the tree API and not the tarball
 *
 * The repository is 5.2 GB, mostly `.blend`, `.max`, `.fbx` sources and 3D-print
 * files; the `.glb` meshes that a web viewer can use are 609 MB of that. Downloading
 * the archive means 4.6 GB of unusable data over a link that runs at a few hundred
 * KB/s.
 *
 * One call to `/git/trees/master?recursive=1` returns every path with its size in
 * about three seconds — 1 583 entries, 257 `.glb`, untruncated. That is the whole
 * catalogue, and the files can then be fetched in parallel by name.
 *
 * The earlier per-directory approach used the contents API, which is limited to 60
 * anonymous requests an hour; 227 directories exhausted it and 168 silently failed.
 *
 * Run:
 *   npx tsx tools/models-sync.ts              # catalogue only (3 s)
 *   npx tsx tools/models-sync.ts --download   # + fetch the .glb files
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";

const REPO = "nasa/NASA-3D-Resources";
const BRANCH = "master";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

interface Local {
  id: string;
  source: string;
  name: string;
  path: string;
  filename: string;
  url: string;
  sizeBytes: number;
  previewUrl: string | null;
  localPath: string | null;
}

const DDL = `
CREATE TABLE IF NOT EXISTS model_asset (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL,
  filename    TEXT NOT NULL,
  url         TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  preview_url TEXT,
  local_path  TEXT,
  fetched_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS model_name_idx ON model_asset(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS model_source_idx ON model_asset(source);
`;

/**
 * NASA names carry a model revision in parentheses — `Aqua (A)`, `Aura (C)` — which
 * is not part of the satellite's name. Kept, it would never match a catalogue entry.
 */
function cleanName(dir: string): string {
  return dir.replace(/\s*\([A-Z]\)\s*$/, "").trim();
}

async function fetchTree(): Promise<TreeEntry[]> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`GitHub tree ${res.status}`);
  const j = (await res.json()) as { tree?: TreeEntry[]; truncated?: boolean };
  if (!j.tree) throw new Error("返回缺少 tree");
  if (j.truncated) throw new Error("tree 被截断，需改用分页");
  return j.tree;
}

/**
 * Download with a small worker pool.
 *
 * GitHub serves each file over its own connection, so the pool size is what decides
 * throughput. 12 keeps the host comfortable and does not trip the abuse detector that
 * a 50-way burst would.
 */
async function downloadAll(
  items: Array<{ url: string; dest: string; id: string }>,
  db: Database.Database,
  concurrency = 12,
): Promise<{ done: number; skipped: number; failed: number }> {
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let next = 0;
  const update = db.prepare("UPDATE model_asset SET local_path = ? WHERE id = ?");
  const started = Date.now();

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;

      if (existsSync(item.dest)) {
        skipped += 1;
        update.run(item.dest, item.id);
        continue;
      }

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const res = await fetch(item.url, { signal: AbortSignal.timeout(180_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          await writeFile(item.dest, buf);
          update.run(item.dest, item.id);
          done += 1;
          break;
        } catch {
          if (attempt === 3) failed += 1;
          else await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }

      const n = done + skipped + failed;
      if (n % 10 === 0) {
        const sec = (Date.now() - started) / 1000;
        process.stdout.write(
          `\r  下载 ${n}/${items.length}  成功 ${done}  跳过 ${skipped}  失败 ${failed}  ${(done / Math.max(sec, 1)).toFixed(1)} 个/s   `,
        );
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write("\r" + " ".repeat(90) + "\r");
  return { done, skipped, failed };
}

async function main(): Promise<void> {
  const download = process.argv.includes("--download");
  const dbPath = process.env.SPACE_SAFETY_DB ?? "./data/catalogue.sqlite";

  console.log("\n  NASA 3D 模型库\n");

  const tree = await fetchTree();
  const glbs = tree.filter((t) => t.type === "blob" && t.path.toLowerCase().endsWith(".glb"));
  const pngs = tree.filter((t) => t.type === "blob" && /\.(png|jpg|jpeg)$/i.test(t.path));

  // Preview images are matched per directory: the directory name identifies the model.
  const previewByDir = new Map<string, string>();
  for (const p of pngs) {
    const dir = p.path.slice(0, p.path.lastIndexOf("/"));
    if (!previewByDir.has(dir)) previewByDir.set(dir, RAW + encodeURI(p.path));
  }

  const records: Local[] = [];
  for (const g of glbs) {
    const dir = g.path.slice(0, g.path.lastIndexOf("/"));
    const dirName = dir.slice(dir.lastIndexOf("/") + 1);
    const filename = g.path.slice(g.path.lastIndexOf("/") + 1);
    records.push({
      id: `nasa:${g.path}`,
      source: "nasa-github",
      name: cleanName(dirName),
      path: dir,
      filename,
      url: RAW + encodeURI(g.path),
      sizeBytes: g.size ?? 0,
      previewUrl: previewByDir.get(dir) ?? null,
      localPath: null,
    });
  }

  const totalMb = records.reduce((a, r) => a + r.sizeBytes, 0) / 1e6;
  const withPreview = records.filter((r) => r.previewUrl).length;
  const names = new Set(records.map((r) => r.name));
  console.log(`  仓库条目    ${tree.length}`);
  console.log(`  模型文件    ${records.length} 个  ${totalMb.toFixed(0)} MB`);
  console.log(`  不同对象    ${names.size}`);
  console.log(`  带预览图    ${withPreview}`);

  const db = new Database(dbPath);
  db.exec(DDL);
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO model_asset
       (id, source, name, path, filename, url, size_bytes, preview_url, local_path, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction((rows: Local[]) => {
    // Only NASA rows are replaced; Spacebook's come from its own sync.
    db.prepare("DELETE FROM model_asset WHERE source = 'nasa-github'").run();
    for (const r of rows) {
      stmt.run(r.id, r.source, r.name, r.path, r.filename, r.url, r.sizeBytes, r.previewUrl, r.localPath, now);
    }
  })(records);
  console.log(`  入库        ${records.length} 行`);

  if (download) {
    const outDir = "data/models/nasa";
    mkdirSync(outDir, { recursive: true });
    const items = records.map((r) => ({
      id: r.id,
      url: r.url,
      dest: join(outDir, r.id.replace(/^nasa:/, "").replace(/[^\w().-]+/g, "_")),
    }));
    const res = await downloadAll(items, db);
    console.log(`  下载        新增 ${res.done}  已存在 ${res.skipped}  失败 ${res.failed}`);
  }

  const total = db.prepare("SELECT COUNT(*) AS n FROM model_asset").get() as { n: number };
  const localed = db.prepare("SELECT COUNT(*) AS n FROM model_asset WHERE local_path IS NOT NULL").get() as { n: number };
  console.log(`\n  model_asset 合计 ${total.n}，本地已下载 ${localed.n}\n`);

  db.close();
}

void main().catch((err) => {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exit(1);
});
