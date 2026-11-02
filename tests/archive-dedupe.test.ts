/**
 * The archive must not write a second copy of a body it already has.
 *
 * ## The defect this locks down
 *
 * `archive.ts` documents the hash suffix as making "a re-fetch of unchanged
 * content a five-second no-op instead of another 69 MB write". That was never
 * true: files are named `HHmmss-<sha256:12>`, and `hashOfName()` read those 12
 * hex characters back, while `store()` compared them against the **full**
 * 64-character digest. The comparison could never match, so every capture wrote
 * a new file — including byte-identical ones.
 *
 * It went unnoticed because nothing depends on the file count: row counts, the
 * ledger and the pages all looked right. What it cost was write amplification —
 * a full sweep of all 25 endpoints wrote ~500 MB of duplicate files, and the
 * archive reached 2.5 GB for four days of captures.
 *
 * The lesson is the one this project keeps relearning: a documented optimisation
 * that nothing asserts is not an optimisation, it is a comment.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { SourceArchive, sameDigest } from "../src/lib/sources/archive";
import type { DownloadSpec } from "../src/lib/sources/downloads";

let pass = 0;
let fail = 0;

async function check(name: string, fn: () => Promise<void> | void, detail = ""): Promise<void> {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
    console.log(`       ${(err as Error).message}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "spacesafety-archive-"));

/** The minimum a `DownloadSpec` needs to be archived. */
const spec = { id: "test-endpoint", format: "json" } as unknown as DownloadSpec;

function filesIn(endpoint: string): string[] {
  try {
    return readdirSync(join(root, endpoint, "2026-11-02")).sort();
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  console.log("\n归档去重：同一份内容不得写第二次\n");

  // Fixed clock so the date directory is predictable.
  const archive = new SourceArchive({ root, now: () => new Date("2026-11-02T05:07:41Z") });

  await check("sameDigest 认为 12 位前缀与完整摘要相同", () => {
    const digest = createHash("sha256").update("payload").digest("hex");
    assert.equal(sameDigest(digest.slice(0, 12), digest), true);
    assert.equal(sameDigest(digest, digest.slice(0, 12)), true);
    assert.equal(sameDigest(digest, digest), true);
    assert.equal(sameDigest("000000000000", digest), false);
    assert.notEqual(digest.slice(0, 12), digest, "前提：文件名里只有前 12 位");
  });

  const body = Buffer.from('{"objects":[1,2,3]}', "utf8");
  const first = await archive.store(spec, body);

  await check("第一次存档写出一个文件", () => {
    assert.equal(first.unchanged, false);
    assert.equal(filesIn("test-endpoint").length, 1, filesIn("test-endpoint").join(","));
    assert.equal(first.sha256.length, 64);
  });

  // This is the shape the downloader passes: the hash read back from the name.
  const fromName = first.path.match(/-([0-9a-f]{12})\.[a-z]+$/)![1];

  await check("同一份内容再抓一次：不写新文件", async () => {
    const again = await archive.store(spec, body, { sha256: fromName, path: first.path });
    assert.equal(again.unchanged, true, "unchanged 没被识别");
    assert.equal(again.path, first.path, "指向了新路径");
    assert.equal(filesIn("test-endpoint").length, 1, `目录里有 ${filesIn("test-endpoint").length} 个文件`);
  });

  await check("完整摘要作为 previous 时同样识别", async () => {
    const again = await archive.store(spec, body, { sha256: first.sha256, path: first.path });
    assert.equal(again.unchanged, true);
    assert.equal(filesIn("test-endpoint").length, 1);
  });

  await check("内容变化时写出第二个文件", async () => {
    const changed = await archive.store(spec, Buffer.from('{"objects":[1,2,4]}'), {
      sha256: fromName,
      path: first.path,
    });
    assert.equal(changed.unchanged, false);
    assert.notEqual(changed.sha256, first.sha256);
    assert.equal(filesIn("test-endpoint").length, 2, filesIn("test-endpoint").join(","));
  });

  await check("previous 指向的文件已不存在时重新写一份", async () => {
    const missing = await archive.store(spec, body, {
      sha256: fromName,
      path: join(root, "test-endpoint", "2026-11-02", "000000-deadbeef0000.json"),
    });
    assert.equal(missing.unchanged, false, "消失了的上一次抓取被当成了有效去重目标");
    // The clock is fixed in this test, so an identical body lands on the same
    // `HHmmss-<hash>` name it had before: the file is rewritten, and the count
    // stays at 2. With a real clock this would be a third file.
    assert.equal(filesIn("test-endpoint").length, 2, filesIn("test-endpoint").join(","));
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
