/**
 * Ephemeris downloader — the TypeScript replacement for `tools/download-starlink.py`.
 *
 * ## Why this is a class and not a function
 *
 * The downloader owns state that outlives any single request: a rotation over
 * nodes, per-node failure counts, and the scheduler that keeps N requests in
 * flight. That state is exactly what the project's rules say must live in an
 * object rather than in module-level variables, so the whole thing is one
 * `EphemerisDownloader` whose lifetime is one CLI invocation (or one test).
 *
 * ## Truncation is the failure that matters
 *
 * The host does not signal a short body: a dropped connection still looks like
 * success, and a truncated OCM *parses fine* as a shorter arc, so every
 * downstream number degrades silently. Each file is therefore checked for the
 * `TRAJ_STOP` marker over its **whole** body before it is kept, and a file that
 * fails the check is retried on a different node.
 *
 * Checking the last few kilobytes does not work: `TRAJ_STOP` sits at about line
 * 10 000 of a 5 MB file, followed by the covariance section and the manoeuvre
 * plan. Searching the tail rejected perfectly good files.
 *
 * ## Range requests
 *
 * Never used. This host answers a `Range` header with a `206` prefix, which is a
 * silent truncation. A plain GET with a browser user-agent returns the whole
 * file.
 *
 * ## Why not `fetch` with `undici`'s `ProxyAgent`
 *
 * `ProxyAgent` accepts `socks5://` but resolves the target hostname locally.
 * Behind a SOCKS5 node the whole point is that the *node* resolves the name
 * (`socks5h://` in curl terms); resolving here means a poisoned answer sends the
 * request to the wrong address. Node's `socks` package sends the hostname in
 * SOCKS5's DOMAINNAME form, so the request below dials through it and speaks
 * HTTP/TLS over the returned socket.
 */

import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { connect as tlsConnect } from "node:tls";

import { SocksClient } from "socks";

export interface DownloaderOptions {
  /** Where files land. */
  outDir: string;
  /**
   * SOCKS5 endpoints, `host:port`. Empty means direct.
   *
   * Each entry is an independent upstream node. Spreading files across nodes is
   * both faster and more reliable than raising concurrency against one: measured
   * on this machine, a single node delivered ~1 MB/s while one HTTP proxy path
   * throttled to ~27 KB/s.
   */
  nodes?: string[];
  /** Requests in flight. */
  concurrency?: number;
  /** Per-request socket timeout, ms. */
  timeoutMs?: number;
  /** Attempts per file before giving up. */
  tries?: number;
  log?: (line: string) => void;
}

export type EphemerisKind = "ocm" | "itc";

export interface FetchResult {
  ok: boolean;
  bytes: number;
  ms: number;
  node: string | null;
  error?: string;
}

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** One SOCKS5 node; opens streams that resolve names remotely. */
class SocksDialer {
  private readonly host: string;
  private readonly port: number;

  constructor(endpoint: string) {
    const [host, port] = endpoint.split(":");
    if (!host || !port) throw new Error(`bad node "${endpoint}", expected host:port`);
    this.host = host;
    this.port = Number(port);
  }

  async connect(destHost: string, destPort: number, timeoutMs: number) {
    const { socket } = await SocksClient.createConnection({
      proxy: { host: this.host, port: this.port, type: 5 },
      command: "connect",
      destination: { host: destHost, port: destPort },
      timeout: timeoutMs,
    });
    return socket;
  }
}

/**
 * Ephemerides downloader.
 *
 * `download()` fetches one file; `downloadAll()` runs many with bounded
 * concurrency and reports per-file results.
 */
export class EphemerisDownloader {
  private readonly options: Required<Omit<DownloaderOptions, "log">> & {
    log: (line: string) => void;
  };
  private readonly dialers: Map<string, SocksDialer>;
  private readonly failures = new Map<string, number>();
  private completed = 0;
  private totalBytes = 0;
  private readonly startedAt = Date.now();

  constructor(options: DownloaderOptions) {
    this.options = {
      outDir: options.outDir,
      nodes: options.nodes ?? [],
      concurrency: options.concurrency ?? 16,
      timeoutMs: options.timeoutMs ?? 180_000,
      tries: options.tries ?? 4,
      log: options.log ?? ((line) => console.log(line)),
    };
    this.dialers = new Map(this.options.nodes.map((n) => [n, new SocksDialer(n)]));
  }

  /** Is `path` a complete OCM / ITC body? */
  async isComplete(path: string, kind: EphemerisKind): Promise<boolean> {
    let handle;
    try {
      handle = await open(path, "r");
      const head = Buffer.alloc(64);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      // An HTML error page or a JSON error body is not an ephemeris, whatever
      // its length.
      const first = head.subarray(0, bytesRead).toString("utf8").trimStart();
      if (first.startsWith("<") || first.startsWith("{")) return false;
      return kind === "itc" ? await this.isCompleteItc(path, head) : await this.isCompleteOcm(path);
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  }

  private async isCompleteOcm(path: string): Promise<boolean> {
    let sawTrajStop = false;
    let sawCov = false;
    for await (const line of linesOf(path)) {
      if (line.startsWith("TRAJ_STOP")) sawTrajStop = true;
      else if (line.startsWith("COV_START")) sawCov = true;
      else if (sawTrajStop && sawCov && line.startsWith("MAN_STOP")) return true;
    }
    // Some files carry no manoeuvre plan; a trajectory plus covariance is still
    // a complete, usable OCM.
    return sawTrajStop && sawCov;
  }

  private async isCompleteItc(path: string, head: Buffer): Promise<boolean> {
    const m = head
      .toString("utf8")
      .match(/ephemeris_start:(\S+ \S+) UTC ephemeris_stop:(\S+ \S+) UTC step_size:(\d+)/);
    if (!m) return false;
    const start = Date.parse(`${m[1]}Z`);
    const stop = Date.parse(`${m[2]}Z`);
    const step = Number(m[3]);
    if (!Number.isFinite(start) || !Number.isFinite(stop) || !(step > 0)) return false;
    const expected = Math.floor((stop - start) / step) + 1;

    let states = 0;
    for await (const line of linesOf(path)) {
      // State lines begin with a 13-digit day-of-year timestamp.
      if (line.length > 13 && /^\d{13}\./.test(line)) states += 1;
    }
    // Two blocks of slack for rounding at either end.
    return states >= expected - 2;
  }

  /** Nodes ordered least-failed first, so a dead node does not absorb every retry. */
  private nodeOrder(): Array<string | null> {
    if (this.dialers.size === 0) return [null];
    return [...this.options.nodes].sort(
      (a, b) => (this.failures.get(a) ?? 0) - (this.failures.get(b) ?? 0),
    );
  }

  /** Download one URL to `dest`, rotating nodes on failure. */
  async download(url: string, dest: string, kind: EphemerisKind): Promise<FetchResult> {
    const started = Date.now();
    await mkdir(dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    let lastError = "";

    for (let attempt = 0; attempt < this.options.tries; attempt += 1) {
      const order = this.nodeOrder();
      const node = order[attempt % order.length];
      try {
        await this.fetchTo(new URL(url), part, node);
        if (!(await this.isComplete(part, kind))) {
          const size = (await stat(part)).size;
          throw new Error(`incomplete (${size} bytes)`);
        }
        await rename(part, dest);
        const size = (await stat(dest)).size;
        return { ok: true, bytes: size, ms: Date.now() - started, node };
      } catch (err) {
        lastError = (err as Error).message;
        const key = node ?? "-";
        this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
        await rm(part, { force: true });
      }
    }
    return { ok: false, bytes: 0, ms: Date.now() - started, node: null, error: lastError };
  }

  private async fetchTo(url: URL, dest: string, node: string | null): Promise<void> {
    const response = await fetchThroughSocket(url, node ? this.dialers.get(node)! : null, this.options.timeoutMs);
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(dest));
  }

  /** Download many files, at most `concurrency` in flight. */
  async downloadAll(
    jobs: Array<{ url: string; dest: string; kind?: EphemerisKind }>,
  ): Promise<FetchResult[]> {
    const results: FetchResult[] = new Array(jobs.length);
    let next = 0;

    const worker = async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= jobs.length) return;
        const job = jobs[index];
        const result = await this.download(job.url, job.dest, job.kind ?? "ocm");
        results[index] = result;
        this.completed += 1;
        if (result.ok) this.totalBytes += result.bytes;
        this.report(job.dest, result);
      }
    };

    const width = Math.max(1, Math.min(this.options.concurrency, jobs.length));
    await Promise.all(Array.from({ length: width }, worker));
    return results;
  }

  private report(dest: string, result: FetchResult): void {
    const name = dest.split("/").pop() ?? dest;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const rate = (this.totalBytes / 1e6 / Math.max(1, elapsed)).toFixed(1);
    const via = result.node ?? "direct";
    if (result.ok) {
      this.options.log(
        `  [${this.completed}] ${name} ${(result.bytes / 1e6).toFixed(2)} MB ` +
          `${(result.ms / 1000).toFixed(1)}s via ${via}  (${rate} MB/s overall)`,
      );
    } else {
      this.options.log(`  [${this.completed}] ${name} FAILED: ${result.error}`);
    }
  }

  /** Where a file for `name` lands. */
  pathFor(name: string): string {
    return join(this.options.outDir, `${name}.txt`);
  }
}

/** Yield a file's lines without loading it whole. */
async function* linesOf(path: string): AsyncGenerator<string> {
  const handle = await open(path, "r");
  try {
    let carry = "";
    const buffer = Buffer.alloc(1 << 16);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      carry += buffer.subarray(0, bytesRead).toString("utf8");
      let nl = carry.indexOf("\n");
      while (nl !== -1) {
        yield carry.slice(0, nl).trimStart();
        carry = carry.slice(nl + 1);
        nl = carry.indexOf("\n");
      }
    }
    if (carry) yield carry.trimStart();
  } finally {
    await handle.close();
  }
}

/**
 * GET `url`, through a SOCKS5 node when given.
 *
 * Two paths, one contract. Without a node this is Node's own `fetch`, which
 * already handles TLS, redirects and keep-alive correctly. With a node the
 * request goes over a socket the SOCKS5 client opened, and only the narrow
 * dialect this host needs is implemented by hand — one plain GET to one host
 * with `Connection: close`, no redirects — because undici offers no way to hand
 * it a pre-connected socket.
 *
 * Hand-rolling the direct path was a mistake worth recording: a bespoke client
 * that forgot to wrap the socket in TLS read the TLS handshake bytes as an HTTP
 * status line and failed with "Expected HTTP/". Node's client does not.
 */
async function fetchThroughSocket(
  url: URL,
  dialer: SocksDialer | null,
  timeoutMs: number,
): Promise<Response> {
  if (!dialer) {
    return fetch(url, {
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,text/plain,*/*",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  const raw = await dialer.connect(url.hostname, port, timeoutMs);
  const socket =
    url.protocol === "https:" ? tlsConnect({ socket: raw, servername: url.hostname }) : raw;

  const { status, headers, body } = await new Promise<{
    status: number;
    headers: Headers;
    body: Readable;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout after ${timeoutMs} ms`));
    }, timeoutMs);

    const req = httpRequest(
      {
        host: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,text/plain,*/*",
          "accept-language": "en-US,en;q=0.9",
          host: url.hostname,
          connection: "close",
        },
        createConnection: () => socket,
      },
      (res) => {
        clearTimeout(timer);
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          h.set(k, Array.isArray(v) ? v.join(",") : v);
        }
        resolve({ status: res.statusCode ?? 0, headers: h, body: res });
      },
    );
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });

  // Drain here so the caller's `pipeline` sees a complete stream and the socket
  // is released before the promise resolves.
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return new Response(Buffer.concat(chunks), { status, headers });
}
