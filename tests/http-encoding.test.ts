/**
 * Content encoding: every outbound byte is asked for compressed.
 *
 * ## Why this is a test rather than a comment
 *
 * The catalogue bodies are the largest thing this project moves — Spacebook's
 * `/api/entity/omm/json` is 30.37 MB, KeepTrack's `/sats` is the whole catalogue
 * — and the vendors send **no** `ETag` / `Last-Modified`, so compression is the
 * only lever that actually reduces transferred bytes (see `docs/DATA-SOURCES.md`).
 *
 * Two things can silently undo it:
 *
 *   1. A call site that forgets the header. There are five transport paths
 *      (`download()`, the legacy `EphemerisDownloader`'s two branches, the DISCOS
 *      page crawler, KeepTrack, web fetches), so "we always ask" is a claim that
 *      needs a check, not a promise.
 *   2. A raw-socket path that asks for gzip but hands the still-encoded bytes to
 *      a text pipeline. That failure is invisible at first — the body is non-empty
 *      — and surfaces later as "incomplete body", or worse, as a truncated parse.
 *
 * The fixture here counts the bytes that actually went over the socket, so
 * "compressed" is measured rather than assumed.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { gzipSync, deflateSync, deflateRawSync, brotliCompressSync } from "node:zlib";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { download } from "../src/lib/net/download";
import { ACCEPT_ENCODING, decodeBody } from "../src/lib/net/encoding";

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

/** A host that compresses only when the client asks — like the vendors. */
interface GzipFixture {
  url: string;
  /** Body bytes written to the socket, compressed or not. */
  wireBytes: () => number;
  /** The `accept-encoding` the client actually sent. */
  seenAcceptEncoding: () => string | undefined;
  close: () => Promise<void>;
}

async function startGzipFixture(payload: string): Promise<GzipFixture> {
  let wireBytes = 0;
  let seen: string | undefined;
  const raw = Buffer.from(payload, "utf8");

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    seen = (req.headers["accept-encoding"] as string | undefined) ?? undefined;
    const wantsGzip = (seen ?? "").includes("gzip");
    const body = wantsGzip ? gzipSync(raw) : raw;

    res.writeHead(200, {
      "content-type": "text/plain",
      "content-length": String(body.length),
      ...(wantsGzip ? { "content-encoding": "gzip" } : {}),
    });
    // Count what is really written: `content-length` is the claim, this is the fact.
    res.end(body, () => {
      wireBytes += body.length;
    });
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/element-sets.txt`,
    wireBytes: () => wireBytes,
    seenAcceptEncoding: () => seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function main(): Promise<void> {
  console.log("\n内容编码：让每个出口都要压缩\n");

  // ------------------------------------------------------------ 常量本身
  await check("常量先要 gzip，且不提 brotli", () => {
    assert.ok(ACCEPT_ENCODING.startsWith("gzip"), ACCEPT_ENCODING);
    // Brotli is deliberately absent: undici negotiates it by default and it is
    // both larger and slower on these single-shot bulk bodies.
    assert.equal(/br\b/.test(ACCEPT_ENCODING), false, ACCEPT_ENCODING);
  });

  // ------------------------------------------------------------ 解码器
  const text = "1 44714U 19029A   26290.50000000  .00001234  00000-0  60000-4 0  9999\n";
  const raw = Buffer.from(text, "utf8");

  await check("identity 原样返回", () => {
    assert.deepEqual(decodeBody(raw, null), raw);
    assert.deepEqual(decodeBody(raw, ""), raw);
    assert.deepEqual(decodeBody(raw, "identity"), raw);
  });

  await check("gzip 解码（含 x-gzip 别名）", () => {
    assert.equal(decodeBody(gzipSync(raw), "gzip").toString(), text);
    assert.equal(decodeBody(gzipSync(raw), "X-GZIP").toString(), text);
  });

  await check("brotli 解码", () => {
    assert.equal(decodeBody(brotliCompressSync(raw), "br").toString(), text);
  });

  await check("deflate 兼容 zlib 包装与裸流两种", () => {
    assert.equal(decodeBody(deflateSync(raw), "deflate").toString(), text);
    // Some hosts send raw deflate while declaring `deflate`; both must decode.
    assert.equal(decodeBody(deflateRawSync(raw), "deflate").toString(), text);
  });

  await check("无法解码的编码必须报错，不得把压缩字节当正文交出去", () => {
    assert.throws(() => decodeBody(raw, "zstd"), /unsupported content-encoding "zstd"/);
    // Returning `raw` here would push still-encoded bytes into a text pipeline,
    // and the failure would surface much later with no clue about the cause.
  });

  await check("已经解过码的正文不会被二次解压", () => {
    // `fetch` callers get a decoded body; running it through the decoder again
    // must fail loudly rather than produce garbage.
    assert.throws(() => decodeBody(Buffer.from(text, "utf8"), "gzip"));
  });

  // ------------------------------------------- 真实请求：确实要了，也确实省了
  // A TLE-shaped body with enough repetition that gzip wins by a wide margin.
  const payload = Array.from({ length: 4000 }, (_, i) =>
    `1 ${44000 + i}U 19029A   26290.50000000  .00001234  00000-0  60000-4 0  9999`,
  ).join("\n");
  const fixture = await startGzipFixture(payload);

  try {
    await check("download() 发出的请求带 gzip，并且拿到的是解压后的正文", async () => {
      const result = await download(fixture.url, (b) => b.length > 0);
      assert.equal(result.status, 200);
      assert.equal(result.complete, true);
      assert.equal(result.body.toString(), payload, "正文必须是解压后的原文");
      assert.equal(
        fixture.seenAcceptEncoding(),
        ACCEPT_ENCODING,
        `实际发出的 accept-encoding 是 ${fixture.seenAcceptEncoding()}`,
      );
    });

    await check("线路上的字节数确实远小于原文", () => {
      const wire = fixture.wireBytes();
      assert.ok(wire > 0, "夹具没有写入任何字节");
      const original = Buffer.byteLength(payload, "utf8");
      assert.ok(
        wire < original / 4,
        `压缩后 ${wire} 字节，原文 ${original} 字节——压缩比不足 4 倍`,
      );
    });
  } finally {
    await fixture.close();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
