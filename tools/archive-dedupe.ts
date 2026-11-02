/**
 * Remove byte-identical duplicate captures from the archive.
 *
 * ## Why this is needed
 *
 * `archive.store()` was supposed to skip the write when a body matched the
 * previous capture. It compared the 12 hex characters carried in the filename
 * against the full 64-character digest, so the comparison never matched and every
 * capture wrote a new file — including byte-identical ones (see `sameDigest()` in
 * `src/lib/sources/archive.ts` and `tests/archive-dedupe.test.ts`).
 *
 * Four days of captures later, 49 of 124 files / 1 005 MB of 2 501 MB were exact
 * duplicates. The fix stops new duplicates; this tool removes the ones that
 * already exist.
 *
 * ## Why deleting them loses nothing
 *
 * Each group is keyed by the **content hash computed from the bytes now on
 * disk** — not by the hash in the name, which is what went wrong in the first
 * place. Every file deleted is byte-identical to a file kept, so the evidence for
 * "what the provider sent" survives exactly once per distinct body. The newest
 * capture of each group is the one kept, because the newest is the one a reader
 * reaches for first.
 *
 * Two invariants the planner refuses to violate:
 *
 *   * the newest copy of a group is never deleted;
 *   * the newest capture of an endpoint is never deleted, even if it duplicates
 *     an older one — losing the current capture of a source would be a
 *     self-inflicted outage, the same rule the retention policy follows.
 *
 * A manifest of every removal (path, digest, size, kept path) is written before
 * anything is unlinked, so the operation can be audited after the fact.
 *
 * ## Usage
 *
 *   npm run archive:dedupe                    # dry run: report only
 *   npm run archive:dedupe -- --apply         # delete, after writing the manifest
 *   npm run archive:dedupe -- --root data/archive --apply
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ArchiveEntry {
  /** Path relative to the archive root, e.g. `space-track-gp/2026-11-02/050754-abc.json`. */
  path: string;
  size: number;
  /** Digest of the bytes on disk. */
  sha256: string;
}

export interface DuplicatePlan {
  /** One group per (endpoint, sha256) that has more than one capture. */
  groups: Array<{
    endpoint: string;
    sha256: string;
    kept: ArchiveEntry;
    remove: ArchiveEntry[];
  }>;
  reclaimBytes: number;
  reclaimFiles: number;
}

/**
 * Decide what to remove. Pure: no filesystem writes, so it can be asserted.
 *
 * `entries` may arrive in any order; both "newest kept" and "newest capture of the
 * endpoint kept" depend on the path sort, which is chronological because the
 * layout is `<endpoint>/<YYYY-MM-DD>/<HHmmss>-<hash>.<ext>`.
 */
export function planDedupe(entries: ArchiveEntry[]): DuplicatePlan {
  const byEndpoint = new Map<string, ArchiveEntry[]>();
  for (const entry of entries) {
    const endpoint = entry.path.split("/")[0];
    const list = byEndpoint.get(endpoint) ?? [];
    list.push(entry);
    byEndpoint.set(endpoint, list);
  }

  const groups: DuplicatePlan["groups"] = [];
  let reclaimBytes = 0;
  let reclaimFiles = 0;

  for (const [endpoint, list] of [...byEndpoint].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => a.path.localeCompare(b.path));
    const newestOverall = list[list.length - 1];

    const byHash = new Map<string, ArchiveEntry[]>();
    for (const entry of list) {
      const bucket = byHash.get(entry.sha256) ?? [];
      bucket.push(entry);
      byHash.set(entry.sha256, bucket);
    }

    for (const [sha256, bucket] of [...byHash].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (bucket.length < 2) continue;
      // Newest kept: the bucket is already in chronological path order.
      const kept = bucket[bucket.length - 1];
      const remove = bucket.slice(0, -1).filter((e) => e.path !== newestOverall.path);
      if (remove.length === 0) continue;
      groups.push({ endpoint, sha256, kept, remove });
      for (const entry of remove) {
        reclaimBytes += entry.size;
        reclaimFiles += 1;
      }
    }
  }

  return { groups, reclaimBytes, reclaimFiles };
}

/** Digest every capture under `root`. */
export function collectEntries(root: string): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  for (const endpoint of readdirSync(root).sort()) {
    const endpointDir = join(root, endpoint);
    let days: string[];
    try {
      days = readdirSync(endpointDir).sort();
    } catch {
      continue; // a file at the root, not an endpoint directory
    }
    for (const day of days) {
      const dayDir = join(endpointDir, day);
      let files: string[];
      try {
        files = readdirSync(dayDir).sort();
      } catch {
        continue;
      }
      for (const file of files) {
        const abs = join(dayDir, file);
        const stat = statSync(abs);
        if (!stat.isFile()) continue;
        out.push({
          path: `${endpoint}/${day}/${file}`,
          size: stat.size,
          // Hash the bytes, never the name: trusting the name is the bug this
          // tool exists to clean up after.
          sha256: createHash("sha256").update(readFileSync(abs)).digest("hex"),
        });
      }
    }
  }
  return out;
}

/**
 * Repoint ledger rows whose captured file was removed as a duplicate.
 *
 * A row is only repointed when a file with matching bytes still exists under the
 * same endpoint — the row's stored `sha256` is the evidence, and the kept file's
 * name carries the same digest. Rows that cannot be resolved are counted, not
 * guessed at.
 */
export function reconcileLedgerPaths(entries: ArchiveEntry[]): {
  repointed: number;
  unresolved: number;
} {
  // Loaded on demand: the planner and its tests must not need a database, and the
  // module is ESM so `require` has to be constructed rather than assumed.
  const req = createRequire(import.meta.url);
  const Database = req("better-sqlite3") as typeof import("better-sqlite3");
  const { existsSync } = req("node:fs") as typeof import("node:fs");

  const dbPath = process.env.SPACE_SAFETY_DB ?? "./data/catalogue.sqlite";
  if (!existsSync(dbPath)) return { repointed: 0, unresolved: 0 };

  const db = new Database(dbPath);
  try {
    const rows = db
      .prepare("SELECT id, path, sha256 FROM source_fetches WHERE path IS NOT NULL")
      .all() as Array<{ id: string; path: string; sha256: string | null }>;

    const byPrefix = new Map<string, string>();
    for (const entry of entries) {
      const endpoint = entry.path.split("/")[0];
      byPrefix.set(`${endpoint}|${entry.sha256.slice(0, 12)}`, entry.path);
    }

    const update = db.prepare("UPDATE source_fetches SET path = ? WHERE id = ?");
    let repointed = 0;
    let unresolved = 0;
    db.transaction(() => {
      for (const row of rows) {
        if (existsSync(row.path)) continue;
        const endpoint = row.path.split("/")[2] ?? row.path.split("/")[0];
        const digest = row.sha256?.slice(0, 12);
        const target = digest ? byPrefix.get(`${endpoint}|${digest}`) : undefined;
        if (!target) {
          unresolved += 1;
          continue;
        }
        update.run(`data/archive/${target}`, row.id);
        repointed += 1;
      }
    })();
    return { repointed, unresolved };
  } finally {
    db.close();
  }
}

function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const apply = argv.includes("--apply");
  const root = flag("--root") ?? "data/archive";

  console.log("\n归档去重 — 删除逐字节重复的抓取\n");
  console.log(`  归档根目录：${root}`);

  const entries = collectEntries(root);
  const plan = planDedupe(entries);
  const totalBytes = entries.reduce((s, e) => s + e.size, 0);

  console.log(
    `  ${entries.length} 个文件 / ${mb(totalBytes)} MB；` +
      `${plan.reclaimFiles} 个重复 / ${mb(plan.reclaimBytes)} MB 可回收`,
  );

  if (plan.groups.length === 0) {
    console.log("\n  没有重复需要删除。");
    // A previous run may have left dangling ledger paths — that is what happens
    // when the deletion ran before this repair existed — so the repair pass runs
    // even when there is nothing to delete.
    if (apply) {
      const repaired = reconcileLedgerPaths(collectEntries(root));
      console.log(
        `  账本引用：重指向 ${repaired.repointed} 条，无法解析 ${repaired.unresolved} 条\n`,
      );
    } else {
      console.log("  （账本引用的修复需要 --apply）\n");
    }
    return;
  }

  console.log("\n  按端点：");
  const perEndpoint = new Map<string, { files: number; bytes: number }>();
  for (const group of plan.groups) {
    const cur = perEndpoint.get(group.endpoint) ?? { files: 0, bytes: 0 };
    for (const entry of group.remove) {
      cur.files += 1;
      cur.bytes += entry.size;
    }
    perEndpoint.set(group.endpoint, cur);
  }
  for (const [endpoint, cur] of [...perEndpoint].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`    ${endpoint.padEnd(30)} ${String(cur.files).padStart(2)} 个  ${mb(cur.bytes).padStart(7)} MB`);
  }

  if (!apply) {
    console.log(
      `\n  dry run：未删除任何文件。` +
        `\n  执行清理：npm run archive:dedupe -- --apply\n`,
    );
    return;
  }

  // Manifest first: if the process dies mid-sweep, the record of what this run
  // intended to delete exists before any byte is unlinked.
  // Kept outside the archive root on purpose: the archive holds provider bytes and
  // nothing else, so a stray manifest there would be one more thing every future
  // reader has to learn to skip.
  const manifestDir = flag("--manifest-dir") ?? "data/archive-dedupe";
  mkdirSync(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, `dedupe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        root,
        files: plan.groups.flatMap((g) =>
          g.remove.map((entry) => ({
            removed: entry.path,
            sha256: entry.sha256,
            size: entry.size,
            kept: g.kept.path,
          })),
        ),
      },
      null,
      2,
    ),
  );
  console.log(`\n  清单已写入 ${manifestPath}`);

  let deleted = 0;
  let freed = 0;
  for (const group of plan.groups) {
    for (const entry of group.remove) {
      // Re-check the kept copy still exists before removing this one: the whole
      // safety argument is "the same bytes remain".
      try {
        statSync(join(root, group.kept.path));
      } catch {
        console.log(`    跳过 ${entry.path}：保留副本 ${group.kept.path} 不见了`);
        continue;
      }
      unlinkSync(join(root, entry.path));
      deleted += 1;
      freed += entry.size;
    }
  }

  const remaining = collectEntries(root);

  // Deleting a duplicate leaves ledger rows pointing at a path that no longer
  // exists. The row's own `sha256` proves the kept copy is the same body, so the
  // path is repointed rather than left dangling — a trace that points at nothing
  // is worse than no trace.
  const repaired = reconcileLedgerPaths(remaining);
  if (repaired.repointed > 0 || repaired.unresolved > 0) {
    console.log(
      `  账本引用：重指向 ${repaired.repointed} 条，无法解析 ${repaired.unresolved} 条`,
    );
  }

  const remainingBytes = remaining.reduce((s, e) => s + e.size, 0);
  console.log(
    `\n  已删除 ${deleted} 个文件，回收 ${mb(freed)} MB。` +
      `\n  现在 ${remaining.length} 个文件 / ${mb(remainingBytes)} MB。\n`,
  );
}

// Only run when executed directly, so the planner can be imported by tests.
if (process.argv[1]?.endsWith("archive-dedupe.ts")) void main();
