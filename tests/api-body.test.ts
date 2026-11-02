/**
 * Request bodies: bounded, and malformed input is a 400 rather than a 500.
 *
 * ## The two defects this pins down
 *
 * `readJson` used to be `JSON.parse(await request.text())` with no ceiling. Two
 * consequences, both measured on the code rather than guessed:
 *
 *   1. **Unbounded allocation.** Nothing capped the body, so one client could make
 *      the process buffer gigabytes — charged as a single rate-limit token, because
 *      the limiter counts requests and not bytes. The documented maximum is
 *      `MAX_FILE_CHARS` (30 MiB of ephemeris text) plus the JSON envelope, so the
 *      cap is set just above it.
 *   2. **A 500 for a client mistake.** The two `PATCH` handlers parsed the body
 *      inline with a bare `JSON.parse`, so `{"oops"` escaped as a SyntaxError and
 *      the wrapper reported `internal_error`. A malformed body is the caller's
 *      problem; it must read as 400.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const workDir = mkdtempSync(join(tmpdir(), "spacesafety-body-"));
process.env.SPACE_SAFETY_DB = join(workDir, "body.sqlite");
process.env.SPACE_SAFETY_ALLOW_X_OPERATOR = "1";
process.env.SPACE_SAFETY_DEMO = "1";

console.log("\nAPI — 请求体上限与畸形 JSON\n");

async function main(): Promise<void> {
  const { readJson, MAX_BODY_BYTES } = await import("../src/lib/api/http");
  const { ApiError } = await import("../src/lib/api/errors");

  const jsonPost = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  await check("正常 JSON 原样解析", async () => {
    const parsed = await readJson<{ a: number }>(jsonPost('{"a":1}'));
    assert.equal(parsed.a, 1);
  });

  await check("空体是 400，不是 500", async () => {
    const err = await readJson(jsonPost("   ")).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof ApiError, "没有抛出 ApiError");
    assert.equal(err.status, 400);
  });

  await check("畸形 JSON 是 400，不是 500", async () => {
    const err = await readJson(jsonPost('{"oops"')).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof ApiError, "没有抛出 ApiError");
    assert.equal(err.status, 400);
    assert.equal(err.errorType, "bad_request");
  });

  await check("声明长度超上限时，读之前就拒绝", async () => {
    // Constructing a `Request` around a stream pulls once on its own, so the
    // baseline is taken after construction: what matters is that `readJson` adds
    // nothing, i.e. the `content-length` check runs before the stream is touched.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(16));
        controller.close();
      },
    });
    const req = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const err = await readJson(req).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof ApiError, "没有抛出 ApiError");
    assert.equal(err.status, 413, `status=${err.status}`);
    // `received_bytes` proves which path ran: the declared length, not the 16
    // bytes the stream would actually have yielded.
    assert.equal(
      err.metadata.received_bytes,
      MAX_BODY_BYTES + 1,
      `用了流计数而不是声明长度：received_bytes=${String(err.metadata.received_bytes)}`,
    );
    assert.ok(pulled <= 1, `读取前就从流里拉了 ${pulled} 次`);
  });

  await check("没有长度声明时，读到超限就中断并返回 413", async () => {
    // Chunked upload: no `content-length`, so only the counted stream can stop it.
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        if (sent > MAX_BODY_BYTES + 4 * 1024 * 1024) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const req = new Request("http://localhost/x", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    const err = await readJson(req).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof ApiError, "没有抛出 ApiError");
    assert.equal(err.status, 413, `status=${err.status}`);
    assert.ok(
      sent < MAX_BODY_BYTES + 4 * 1024 * 1024,
      `读完了整个流才开始拒绝（发了 ${sent} 字节）`,
    );
  });

  // ------------------------------------------------- at the route, not the helper
  const { getDb } = await import("../src/db");
  const schema = await import("../src/db/schema");
  const { db } = getDb();
  const now = new Date().toISOString();
  const me = "11111111-1111-4111-8111-111111111111";
  const myObject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  db.insert(schema.operators)
    .values({
      id: me,
      name: "Body A",
      email: "a@example.test",
      phone: "+1",
      maxObjects: 5,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(schema.objects)
    .values({
      id: myObject,
      operatorId: me,
      objectName: "BODY-MINE",
      hardBodyRadius: 1,
      maneuverability: false,
      alive: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const { PATCH } = await import("../src/app/api/v1/object/[id]/route");
  const patch = (body: string) =>
    PATCH(
      new Request(`http://localhost/api/v1/object/${myObject}`, {
        method: "PATCH",
        headers: { "x-space-safety-operator": me, "content-type": "application/json" },
        body,
      }),
      { params: Promise.resolve({ id: myObject }) },
    );

  await check("PATCH 合法请求仍然成功", async () => {
    const res = await patch('{"object_name":"RENAMED"}');
    assert.equal(res.status, 200, `status=${res.status}`);
    const row = db.select().from(schema.objects).all().find((o) => o.id === myObject);
    assert.equal(row?.objectName, "RENAMED");
  });

  await check("PATCH 畸形 JSON 返回 400，且没有改动数据", async () => {
    const res = await patch('{"object_name":"SHOULD-NOT-APPLY"');
    assert.equal(res.status, 400, `status=${res.status}`);
    const body = (await res.json()) as { error_type?: string };
    assert.equal(body.error_type, "bad_request", JSON.stringify(body));
    const row = db.select().from(schema.objects).all().find((o) => o.id === myObject);
    assert.equal(row?.objectName, "RENAMED", "被拒绝的请求仍然改了名字");
  });

  await check("PATCH 空体返回 400", async () => {
    const res = await patch("");
    assert.equal(res.status, 400, `status=${res.status}`);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
