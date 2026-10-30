/**
 * Conditional GET: the poll must not re-transfer a file that did not change.
 *
 * ## What this proves
 *
 * The catalogue sources publish on their own clocks (Space-Track GP every 2 h,
 * SATCAT daily, DISCOS 不定期). Before this, every cycle re-downloaded the full
 * body and *then* discovered, by hashing the archive, that the bytes were
 * identical — 552 MB of bandwidth a day to learn nothing.
 *
 * The archive layer already deduplicated by SHA-256, so the waste was invisible
 * in the row counts: the only symptom was transfer. That means the fix has to be
 * proven at the HTTP layer, not at the database layer.
 *
 * So these tests start a real `node:http` server that behaves like the vendor
 * hosts do — `ETag` + `Last-Modified` on every response, `304` with an empty body
 * when the client's validator matches — and count the bytes actually written to
 * the socket. "Unchanged" is then a measured fact: the second request transfers
 * a response body of zero bytes.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { download } from "../src/lib/net/download";

let pass = 0;
let fail = 0;

async function check(name: string, fn: () => Promise<void>, detail = ""): Promise<void> {
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

/** A vendor-like static file host, instrumented so the test can count bytes. */
interface Fixture {
  server: Server;
  url: string;
  /** Total response-body bytes written, across all requests. */
  bodyBytes: () => number;
  /** Requests served as 304. */
  notModified: () => number;
  /** Requests served with a body. */
  full: () => number;
  /** Change the published content (and therefore the ETag). */
  rewrite: (content: string) => void;
  close: () => Promise<void>;
}

/**
 * Serve \`content\` with an ETag and a Last-Modified, honouring conditional
 * requests exactly as a conforming static host does.
 */
async function startFixture(initial: string): Promise<Fixture> {
  let content = initial;
  let etag = `"${Buffer.byteLength(content)}-${content.length}"`;
  let lastModified = new Date("2026-10-30T00:00:00Z").toUTCString();
  let bodyBytes = 0;
  let notModified = 0;
  let full = 0;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const inm = req.headers["if-none-match"];
    const ims = req.headers["if-modified-since"];

    // An ETag match is authoritative; Last-Modified is the fallback. Both are
    // what the vendors actually send and what the client must send back.
    const matched = typeof inm === "string" && inm === etag;
    const fresh =
      !matched &&
      typeof ims === "string" &&
      new Date(ims).getTime() >= new Date(lastModified).getTime();

    if (matched || fresh) {
      notModified += 1;
      res.writeHead(304, { etag, "last-modified": lastModified });
      res.end(); // no body: this is the whole point
      return;
    }

    full += 1;
    bodyBytes += Buffer.byteLength(content);
    res.writeHead(200, {
      etag,
      "last-modified": lastModified,
      "content-type": "text/plain",
      "content-length": String(Buffer.byteLength(content)),
    });
    res.end(content);
  };

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    server,
    url: `http://127.0.0.1:${port}/fixture.txt`,
    bodyBytes: () => bodyBytes,
    notModified: () => notModified,
    full: () => full,
    rewrite: (next: string) => {
      content = next;
      etag = `"${Buffer.byteLength(next)}-${next.length}"`;
      lastModified = new Date("2026-10-30T12:00:00Z").toUTCString();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The completeness predicate a vendor text file would use. */
const complete = (body: Buffer): boolean => body.length > 0 && body.toString().includes("END");

async function main(): Promise<void> {
  console.log("\n条件请求：没有更新的数据不重复下载\n");

  const body = "line one\nline two\nline three\nEND\n";
  const fixture = await startFixture(body);

  try {
    // ---------------------------------------------------------------- 首次抓取
    await check("首次请求没有 validator，取回完整主体", async () => {
      const first = await download(fixture.url, complete);
      assert.equal(first.status, 200);
      assert.equal(first.notModified, false);
      assert.equal(first.complete, true);
      assert.equal(first.body.toString(), body);
      assert.ok(first.etag, "响应必须带回 ETag，否则下次无法做条件请求");
      assert.ok(first.lastModified, "响应必须带回 Last-Modified");
      assert.equal(fixture.full(), 1);
      assert.equal(fixture.notModified(), 0);
    });

    // -------------------------------------------------------- 带 validator 重放
    await check("带上上次的 validator：304，且不传输任何字节", async () => {
      // A stale validator must not be treated as "unchanged": the server answers
      // 200 with the real body whenever what we hold does not match.
      const stale = await download(fixture.url, complete, {
        conditional: { etag: '"0-0"', lastModified: null },
      });
      assert.equal(stale.status, 200, "不匹配的 validator 必须取回主体");
      assert.equal(stale.complete, true);

      const stored = stale.etag!;
      const before = fixture.bodyBytes();
      const cached = await download(fixture.url, complete, {
        conditional: { etag: stored, lastModified: null },
      });

      assert.equal(cached.status, 304);
      assert.equal(cached.notModified, true);
      assert.equal(cached.body.length, 0, "304 不得携带主体");
      assert.equal(cached.complete, true, "304 表示“与存档一致”，应视为完整");
      assert.equal(cached.etag, stored, "304 后仍要保留 validator 供下轮使用");
      assert.equal(fixture.bodyBytes(), before, "304 未写入任何主体字节，带宽为 0");
      assert.equal(fixture.notModified(), 1);
    });

    // ------------------------------------------------------------ 内容变了
    await check("内容变化后不再 304，取回新主体与新 validator", async () => {
      const oldEtag = `"${Buffer.byteLength(body)}-${body.length}"`;
      fixture.rewrite("line one\nline two\nline three\nline four\nEND\n");

      const changed = await download(fixture.url, complete, {
        conditional: { etag: oldEtag, lastModified: null },
      });
      assert.equal(changed.status, 200);
      assert.equal(changed.notModified, false);
      assert.equal(changed.body.toString(), "line one\nline two\nline three\nline four\nEND\n");
      assert.notEqual(changed.etag, oldEtag, "ETag 必须随内容改变");
    });

    // ------------------------------------------------- 仅用 Last-Modified
    await check("只有 Last-Modified 时也能得到 304", async () => {
      const probe = await download(fixture.url, complete);
      const lm = probe.lastModified!;
      const again = await download(fixture.url, complete, {
        conditional: { etag: null, lastModified: lm },
      });
      assert.equal(again.status, 304);
      assert.equal(fixture.bodyBytes() > 0, true);
    });

    // ------------------------------------------------------ 无 validator
    await check("没有 validator 时不发送条件头，服务器照常返回 200", async () => {
      const plain = await download(fixture.url, complete);
      assert.equal(plain.status, 200);
      assert.equal(plain.notModified, false);
      assert.equal(plain.body.length, Buffer.byteLength("line one\nline two\nline three\nline four\nEND\n"));
    });
  } finally {
    await fixture.close();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
