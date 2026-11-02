/**
 * The archive dedupe plan, asserted before anything is deleted.
 *
 * `npm run archive:dedupe -- --apply` unlinks files from the evidence archive.
 * The safety argument is "every file removed is byte-identical to one kept", so
 * the planner must be checked independently of the tool that acts on it — a
 * planner bug here deletes evidence.
 *
 * The two invariants that matter are asserted directly: the newest copy of a body
 * survives, and the newest capture of an endpoint survives even when it happens to
 * duplicate an older one.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planDedupe, reconcileLedgerPaths, type ArchiveEntry } from "../tools/archive-dedupe";

let pass = 0;
let fail = 0;

function check(name: string, fn: () => void, detail = ""): void {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
    console.log(`       ${(err as Error).message}`);
  }
}

const entry = (path: string, sha256: string, size = 100): ArchiveEntry => ({ path, sha256, size });

const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function main(): Promise<void> {
  console.log("\n归档清理计划：删除前先断言\n");

  check("单个文件不产生任何删除", () => {
    const plan = planDedupe([entry("ep/2026-11-02/050000-aaa.json", A)]);
    assert.equal(plan.groups.length, 0);
    assert.equal(plan.reclaimFiles, 0);
  });

  check("同一内容的两次抓取：留下新的那份", () => {
    const plan = planDedupe([
      entry("ep/2026-11-02/032932-aaa.json", A),
      entry("ep/2026-11-02/050754-aaa.json", A),
    ]);
    assert.equal(plan.groups.length, 1);
    assert.equal(plan.groups[0].kept.path, "ep/2026-11-02/050754-aaa.json");
    assert.deepEqual(
      plan.groups[0].remove.map((e) => e.path),
      ["ep/2026-11-02/032932-aaa.json"],
    );
    assert.equal(plan.reclaimFiles, 1);
    assert.equal(plan.reclaimBytes, 100);
  });

  check("三份相同只留一份", () => {
    const plan = planDedupe([
      entry("ep/2026-10-30/120000-aaa.json", A),
      entry("ep/2026-11-01/120000-aaa.json", A),
      entry("ep/2026-11-02/120000-aaa.json", A),
    ]);
    assert.equal(plan.reclaimFiles, 2);
    assert.equal(plan.groups[0].kept.path, "ep/2026-11-02/120000-aaa.json");
  });

  check("不同内容一律不动", () => {
    const plan = planDedupe([
      entry("ep/2026-11-01/120000-aaa.json", A),
      entry("ep/2026-11-02/120000-bbb.json", B),
    ]);
    assert.equal(plan.groups.length, 0);
    assert.equal(plan.reclaimBytes, 0);
  });

  check("端点之间互不影响：相同哈希分属不同端点不算重复", () => {
    const plan = planDedupe([
      entry("a/2026-11-02/120000-aaa.json", A),
      entry("b/2026-11-02/120000-aaa.json", A),
    ]);
    assert.equal(plan.groups.length, 0, "把两个端点的文件当成了一组");
  });

  check("最新的那份抓取永不删除", () => {
    const entries = [
      entry("ep/2026-11-01/100000-aaa.json", A),
      entry("ep/2026-11-02/050000-bbb.json", B),
      entry("ep/2026-11-02/060000-aaa.json", A),
    ];
    const plan = planDedupe(entries);
    const removed = plan.groups.flatMap((g) => g.remove.map((e) => e.path));
    const newest = "ep/2026-11-02/060000-aaa.json";
    assert.ok(!removed.includes(newest), `删掉了最新的抓取：${removed.join(",")}`);
  });

  check("每个被删文件都有等价的保留副本", () => {
    const plan = planDedupe([
      entry("ep/2026-11-02/032932-aaa.json", A),
      entry("ep/2026-11-02/050754-aaa.json", A),
      entry("ep/2026-11-02/060000-bbb.json", B),
    ]);
    const keptDigests = new Set(
      [...plan.groups.map((g) => g.kept), entry("ep/2026-11-02/060000-bbb.json", B)].map((e) => e.sha256),
    );
    for (const group of plan.groups) {
      for (const removed of group.remove) {
        assert.ok(keptDigests.has(removed.sha256), `${removed.path} 没有同哈希的保留副本`);
      }
    }
  });

  check("回收量与实际删除的文件一致", () => {
    const plan = planDedupe([
      entry("ep/2026-11-02/032932-aaa.json", A, 1000),
      entry("ep/2026-11-02/050754-aaa.json", A, 1000),
      entry("ep/2026-11-02/060000-bbb.json", B, 500),
      entry("ep2/2026-11-02/060000-ccc.json", A, 7),
      entry("ep2/2026-11-02/070000-ccc.json", A, 7),
    ]);
    const manual = plan.groups.reduce((s, g) => s + g.remove.reduce((t, e) => t + e.size, 0), 0);
    assert.equal(plan.reclaimBytes, manual);
    assert.equal(plan.reclaimFiles, plan.groups.reduce((s, g) => s + g.remove.length, 0));
  });


  // ---------------------------------------- 账本引用的修复
  // 删除重复档会让账本里的 path 指向不存在的文件。行内自带的 sha256 就是证据：
  // 同端点、同摘要的文件还在，就把 path 重指过去；找不到就只统计，不猜。
  console.log("\nledger path repair");

  const dbDir = mkdtempSync(join(tmpdir(), "spacesafety-reconcile-"));
  const dbPath = join(dbDir, "ledger.sqlite");
  process.env.SPACE_SAFETY_DB = dbPath;
  {
    const Database = (await import("better-sqlite3")).default;
    const seed = new Database(dbPath);
    seed.exec(`CREATE TABLE source_fetches (
      id TEXT PRIMARY KEY, source_id TEXT, path TEXT, sha256 TEXT)`);
    const ins = seed.prepare("INSERT INTO source_fetches VALUES (?,?,?,?)");
    ins.run("deleted", "space-track-gp", "data/archive/space-track-gp/2026-11-02/032932-0171a3a64e09.json", A);
    ins.run("legacy", "spacebook-xp-tle", "data/spacebook/gone-2020-01-01.tle", B);
    ins.run("intact", "space-track-gp", join(dbDir, "still-here.json"), A);
    seed.close();
    writeFileSync(join(dbDir, "still-here.json"), "x");
  }

  const repaired = reconcileLedgerPaths([
    entry("space-track-gp/2026-11-02/050754-0171a3a64e09.json", A),
  ]);
  check("删掉的那份被重指向到保留副本", () => assert.equal(repaired.repointed, 1));
  check("找不到同摘要的文件只统计，不猜", () => assert.equal(repaired.unresolved, 1));
  {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT id, path FROM source_fetches ORDER BY id").all() as Array<{
      id: string;
      path: string;
    }>;
    check("重指向的目标是仍然存在的保留副本", () =>
      assert.equal(
        rows.find((r) => r.id === "deleted")?.path,
        "data/archive/space-track-gp/2026-11-02/050754-0171a3a64e09.json",
      ),
    );
    check("旧式快照路径没被乱改", () =>
      // 该文件不存在，且归档里没有同摘要的替代品：只能统计，不能改。
      assert.equal(rows.find((r) => r.id === "legacy")?.path, "data/spacebook/gone-2020-01-01.tle"),
    );
    db.close();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
