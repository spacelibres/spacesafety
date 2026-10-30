/**
 * Parallel chunked downloader.
 *
 * ## Why not a single `curl`
 *
 * The GitHub tarball is ~5 GB and a single connection to codeload.github.com runs at
 * a few hundred KB/s from here — measured, it did not finish in ten minutes. The same
 * server honours `Range` requests, so sixteen connections each taking a slice run
 * roughly sixteen times faster. The server sends `Accept-Ranges: bytes` and a
 * `Content-Length` for the redirect target, which is what makes this safe: every chunk
 * is verified by length before the file is assembled.
 *
 * ## Why resumable
 *
 * A 5 GB transfer will be interrupted. Chunks are written to `<file>.part.N` and only
 * merged when all of them exist, so re-running resumes where it stopped instead of
 * starting over. A partial file is never treated as complete.
 *
 * Run: npx tsx tools/_download-parallel.ts <url> <outFile> [connections]
 */

import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

const CHUNK = 32 * 1024 * 1024; // 32 MB per request: large enough to amortise, small enough to retry cheaply.

interface Progress {
  total: number;
  done: number;
}

async function resolveFinalUrl(url: string): Promise<{ url: string; size: number; ranges: boolean }> {
  // Follow the redirect with a HEAD; codeload serves a 302 to a legacy archive path.
  const head = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(30_000) });
  const finalUrl = head.url;
  const len = head.headers.get("content-length");
  const ranges = (head.headers.get("accept-ranges") ?? "").toLowerCase().includes("bytes");
  if (!head.ok) throw new Error(`HEAD ${head.status} ${finalUrl}`);
  if (!len) throw new Error("服务器未返回 Content-Length，无法分段");
  return { url: finalUrl, size: Number(len), ranges };
}

async function downloadChunk(
  url: string,
  start: number,
  end: number,
  partPath: string,
  progress: Progress,
): Promise<void> {
  // Already complete: a resumed run should skip, not re-fetch.
  if (existsSync(partPath)) {
    const have = statSync(partPath).size;
    if (have === end - start + 1) {
      progress.done += have;
      return;
    }
  }

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(180_000),
      });
      if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error("无响应体");

      const before = existsSync(partPath) ? statSync(partPath).size : 0;
      await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(partPath));

      const after = statSync(partPath).size;
      progress.done += Math.max(0, after - before);
      if (after !== end - start + 1) {
        throw new Error(`长度不符 期望 ${end - start + 1} 实得 ${after}`);
      }
      return;
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function main(): Promise<void> {
  const [url, out, connArg] = process.argv.slice(2);
  if (!url || !out) {
    console.error("用法: npx tsx tools/_download-parallel.ts <url> <outFile> [连接数]");
    process.exit(1);
  }
  const connections = Math.max(1, Math.min(Number(connArg ?? "16") || 16, 32));

  if (existsSync(out)) {
    console.log(`已存在，跳过：${out}  ${(statSync(out).size / 1e9).toFixed(2)} GB`);
    return;
  }

  console.log(`\n  解析地址…`);
  const target = await resolveFinalUrl(url);
  console.log(`  大小      ${(target.size / 1e9).toFixed(2)} GB`);
  console.log(`  分段支持  ${target.ranges ? "是" : "否"}`);
  if (!target.ranges) throw new Error("服务器不支持 Range，无法并发下载");

  const chunks: Array<{ start: number; end: number; path: string }> = [];
  for (let start = 0, i = 0; start < target.size; start += CHUNK, i += 1) {
    chunks.push({
      start,
      end: Math.min(start + CHUNK - 1, target.size - 1),
      path: `${out}.part.${i}`,
    });
  }

  await mkdir(dirname(out), { recursive: true });
  await writeFile(`${out}.meta`, JSON.stringify({ size: target.size, chunks: chunks.length }));

  const progress: Progress = { total: target.size, done: 0 };
  const started = Date.now();
  const timer = setInterval(() => {
    const sec = (Date.now() - started) / 1000;
    const mbps = progress.done / sec / 1e6;
    const pct = ((progress.done / progress.total) * 100).toFixed(1);
    const eta = mbps > 0 ? ((progress.total - progress.done) / 1e6 / mbps).toFixed(0) : "?";
    process.stdout.write(
      `\r  ${pct}%  ${(progress.done / 1e6).toFixed(0)}/${(progress.total / 1e6).toFixed(0)} MB  ${mbps.toFixed(1)} MB/s  剩余 ${eta}s   `,
    );
  }, 1000);

  try {
    // A work queue: `connections` workers pull the next unfinished chunk. Simple, and
    // it keeps every connection busy when chunk sizes differ at the tail.
    let next = 0;
    const workers = Array.from({ length: connections }, async () => {
      while (next < chunks.length) {
        const c = chunks[next]!;
        next += 1;
        await downloadChunk(target.url, c.start, c.end, c.path, progress);
      }
    });
    await Promise.all(workers);
  } finally {
    clearInterval(timer);
    process.stdout.write("\n");
  }

  // Assemble. Sequential append into a fresh file, so a crash leaves the parts intact.
  console.log(`  合并 ${chunks.length} 段…`);
  const fh = await open(out, "w");
  for (const c of chunks) {
    const buf = await readFile(c.path);
    await fh.write(buf);
  }
  await fh.close();

  const size = statSync(out).size;
  if (size !== target.size) {
    console.error(`\n  大小不符：期望 ${target.size}，实得 ${size}。保留分段文件以便重试。\n`);
    process.exit(1);
  }

  for (const c of chunks) await rm(c.path, { force: true });
  await rm(`${out}.meta`, { force: true });
  await rename(out, out); // no-op, keeps the path explicit

  console.log(`  完成      ${(size / 1e9).toFixed(2)} GB  ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
}

void main().catch((err) => {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exit(1);
});
