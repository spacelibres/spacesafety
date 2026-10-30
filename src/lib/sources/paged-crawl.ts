/**
 * Paged bulk download with resumable, concurrent fetching.
 *
 * ## Why this is not a simple loop
 *
 * DISCOSweb pages at 100 rows and the largest collection is **93 692 pages**.
 * Measured through the proxy: ~1.1 s per page serially, and the API returns 429
 * above roughly 16 concurrent requests. So the arithmetic that matters is:
 *
 *   serial             93 692 × 1.1 s              ≈ 28 h per collection
 *   concurrency 8      (93 692 / 8) × net round    ≈  7 h, still fragile
 *
 * Seven hours of uninterrupted network is not achievable: a single timeout at
 * hour six would discard everything. This class therefore caches **each page to
 * disk as it arrives** and resumes from the first missing page, so the practical
 * cost of an interruption is one page rather than one collection.
 *
 * ## Why the page number is explicit
 *
 * The server's `links.next` sometimes repeats the current `page[number]`. Trusting
 * it refetched page 1 forever — the first version of this crawler ran for two
 * minutes and collected one page 120 times. The path and filter come from the
 * link; the page number is always written by this class.
 *
 * ## Why 8
 *
 * Measured against the live API: 8 concurrent → all 200; 32 concurrent → roughly
 * half 429. Eight is the concurrency that finished a 232-page collection with no
 * throttling at all, and it leaves headroom for the other requests a refresh run
 * makes. A 429 still back-offs and retries, so the value is a default, not a
 * hard limit.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ACCEPT_ENCODING } from "../net/encoding";

import { request } from "undici";

import { DISCOS_API_VERSION, DISCOS_BASE, totalPagesOf } from "./discos";

export interface CrawlOptions {
  /** Where page bodies are cached. */
  cacheDir: string;
  token: string;
  /** Requests in flight. Default 8, measured safe. */
  concurrency?: number;
  /** Rows per request; the server caps at 100. */
  pageSize?: number;
  timeoutMs?: number;
  /** Abort after this many pages, for a bounded exploratory run. */
  maxPages?: number;
  log?: (line: string) => void;
}

export interface CrawlResult {
  resource: string;
  pages: number;
  fetched: number;
  /** Pages already present from an earlier run. */
  reused: number;
  records: number;
  /** True when every page was present, so the assembled body is complete. */
  complete: boolean;
  ms: number;
}

/** One page of a JSON:API collection. */
interface PageBody {
  data: unknown[];
  totalPages: number | null;
}

export class PagedCrawler {
  private readonly options: Required<Omit<CrawlOptions, "token">> & { token: string };
  /**
   * Current concurrency, lowered when the API throttles.
   *
   * The limit is a token-wide budget shared by every request this process makes,
   * so a fixed worker count drifts into and out of 429s as other endpoints are
   * refreshed alongside. Shrinking on a 429 and recovering slowly afterwards
   * keeps a long crawl moving instead of alternating between fast and blocked.
   */
  private active: number;
  /** Timestamp of the most recent 429, for the recovery delay. */
  private lastThrottleAt = 0;

  constructor(options: CrawlOptions) {
    this.options = {
      cacheDir: options.cacheDir,
      token: options.token,
      concurrency: Math.max(1, Math.min(options.concurrency ?? 8, 16)),
      pageSize: Math.max(1, Math.min(options.pageSize ?? 100, 100)),
      timeoutMs: options.timeoutMs ?? 60_000,
      maxPages: options.maxPages ?? Number.POSITIVE_INFINITY,
      log: options.log ?? ((line) => console.log(line)),
    };
    this.active = this.options.concurrency;
  }

  /** Current worker count. Exposed so a long crawl can report its own pacing. */
  concurrency(): number {
    return this.active;
  }

  /** Directory holding one resource's cached pages. */
  private dir(resource: string): string {
    return join(this.options.cacheDir, resource.replace(/\//g, "_"));
  }

  private pagePath(resource: string, page: number): string {
    return join(this.dir(resource), `${String(page).padStart(6, "0")}.json`);
  }

  /**
   * Download every page of `resource`, reusing cached ones.
   *
   * The first request establishes the total page count; the rest are scheduled
   * against that count so a resumed run knows exactly how much is left.
   */
  async crawl(resource: string, onProgress?: (done: number, total: number) => void): Promise<CrawlResult> {
    const started = Date.now();
    await mkdir(this.dir(resource), { recursive: true });

    const firstPath = this.pagePath(resource, 1);
    let total: number | null = null;

    if (existsSync(firstPath)) {
      total = (await this.readPage(firstPath))?.totalPages ?? null;
    }
    if (total === null) {
      const first = await this.fetchPage(resource, 1);
      await this.writePage(firstPath, first);
      total = first.totalPages;
    }

    if (total === null) {
      // The API did not report a size. Walk until an empty page, which is the only
      // remaining end signal and is not resumable — say so rather than pretending.
      this.options.log(`    ${resource}: no totalPages reported; walking until empty`);
      total = await this.countByWalking(resource);
    }

    const target = Math.min(total, this.options.maxPages);
    // A `maxPages` run caches only the pages it walked; the cache directory keeps
    // them, so a later full run resumes rather than starting over.
    const cached = new Set(await this.listCached(resource));
    let reused = 0;
    let fetched = 0;
    let done = 0;

    const todo: number[] = [];
    for (let page = 1; page <= target; page += 1) {
      if (cached.has(page)) {
        reused += 1;
        done += 1;
      } else {
        todo.push(page);
      }
    }
    if (reused > 0) this.options.log(`    ${resource}: resuming, ${reused} page(s) already cached`);
    onProgress?.(done, target);

    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= todo.length) return;
        const page = todo[index];
        const body = await this.fetchPageWithRetry(resource, page);
        await this.writePage(this.pagePath(resource, page), body);
        fetched += 1;
        done += 1;
        // Reporting every page of a 93 000-page crawl is noise; every 100 keeps a
        // long run visibly alive without flooding the log.
        if (done % 100 === 0) onProgress?.(done, target);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.active, Math.max(1, todo.length)) }, worker),
    );
    onProgress?.(done, target);

    const records = await this.countRecords(resource, target);
    const complete = target >= total;

    return {
      resource,
      pages: target,
      fetched,
      reused,
      records,
      complete,
      ms: Date.now() - started,
    };
  }

  /**
   * Assemble the cached pages into one JSON:API document.
   *
   * Written to disk rather than held in memory: 93 692 pages of objects is
   * hundreds of megabytes, and the archive wants bytes, not objects.
   */
  async assemble(resource: string, totalPages: number): Promise<Buffer> {
    const parts: string[] = ['{"data":['];
    let first = true;
    for (let page = 1; page <= totalPages; page += 1) {
      const body = await this.readPage(this.pagePath(resource, page));
      if (!body) continue;
      for (const record of body.data) {
        if (!first) parts.push(",");
        // `type` is omitted per record by some endpoints; stamp the resource so the
        // archive is self-describing without knowing which endpoint produced it.
        parts.push(JSON.stringify(record));
        first = false;
      }
    }
    parts.push("]}");
    return Buffer.from(parts.join(""), "utf8");
  }

  /** Remove cached pages after they have been archived. */
  async clearCache(resource: string): Promise<void> {
    await rm(this.dir(resource), { recursive: true, force: true });
  }

  /** How many pages of `resource` are currently cached. */
  async cachedCount(resource: string): Promise<number> {
    return (await this.listCached(resource)).length;
  }

  private async listCached(resource: string): Promise<number[]> {
    const dir = this.dir(resource);
    if (!existsSync(dir)) return [];
    const names = await readdir(dir);
    return names
      .filter((n) => /^\d{6}\.json$/.test(n))
      .map((n) => Number(n.slice(0, 6)))
      .sort((a, b) => a - b);
  }

  private async readPage(path: string): Promise<PageBody | null> {
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as {
        data?: unknown[];
        meta?: unknown;
      };
      if (!Array.isArray(parsed.data)) return null;
      return { data: parsed.data, totalPages: totalPagesOf(parsed) };
    } catch {
      // A half-written page from a killed process is not a page.
      return null;
    }
  }

  private async writePage(path: string, body: PageBody): Promise<void> {
    const tmp = `${path}.part`;
    // Store only what `assemble` needs: the records and the page count.
    await writeFile(
      tmp,
      JSON.stringify({ data: body.data, meta: { pagination: { totalPages: body.totalPages } } }),
    );
    await rename(tmp, path);
  }

  /**
   * Fetch one page, backing off properly when throttled.
   *
   * A 429 here is a quota event, not a transient error: measured against the live
   * API, retrying a throttled page after 3 s fails again, and six attempts at
   * that pace exhausted into "failed after 6 attempts" while the token simply
   * needed a minute. The schedule below starts at 30 s and doubles, which is the
   * difference between a crawl that finishes and one that dies at page 104.
   */
  private async fetchPageWithRetry(resource: string, page: number, attempts = 8): Promise<PageBody> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.fetchPage(resource, page);
      } catch (err) {
        lastError = err as Error;
        const throttled = /429/.test(lastError.message);
        if (throttled) {
          // Shrink before sleeping: every other worker is about to hit the same
          // limit, and letting them keep their pace guarantees the next batch
          // throttles too.
          this.lastThrottleAt = Date.now();
          this.active = Math.max(1, Math.floor(this.active / 2));
        }
        if (attempt === attempts - 1) break;
        // 30 s, 60 s, 120 s, 240 s… capped at ten minutes. A throttled token needs
        // minutes, not milliseconds; retrying sooner only extends the throttle.
        const base = throttled ? 30_000 : 1_000;
        const waitMs = Math.min(base * 2 ** attempt, 600_000);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw new Error(
      `${resource} page ${page} failed after ${attempts} attempts: ${lastError?.message}`,
    );
  }

  private async fetchPage(resource: string, page: number): Promise<PageBody> {
    const url = new URL(`/api/${resource}`, DISCOS_BASE);
    url.searchParams.set("page[size]", String(this.options.pageSize));
    url.searchParams.set("page[number]", String(page));

    const res = await request(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/vnd.api+json",
        "accept-encoding": ACCEPT_ENCODING,
        "discosweb-api-version": DISCOS_API_VERSION,
        authorization: `Bearer ${this.options.token}`,
      },
      headersTimeout: this.options.timeoutMs,
      bodyTimeout: this.options.timeoutMs,
    });
    const text = await res.body.text();

    if (res.statusCode === 401) {
      throw new Error(
        "DISCOSweb returned 401; SPACE_SAFETY_DISCOS_TOKEN is missing or expired",
      );
    }
    if (res.statusCode !== 200) {
      throw new Error(`${resource} page ${page} returned HTTP ${res.statusCode}`);
    }

    const parsed = JSON.parse(text) as { data?: unknown[]; meta?: unknown };
    if (!Array.isArray(parsed.data)) {
      throw new Error(`${resource} page ${page} has no data array`);
    }
    return { data: parsed.data, totalPages: totalPagesOf(parsed) };
  }

  /** Walk pages until one comes back empty; used only when totalPages is absent. */
  private async countByWalking(resource: string): Promise<number> {
    for (let page = 1; page < 200_000; page += 1) {
      const body = await this.fetchPageWithRetry(resource, page);
      await this.writePage(this.pagePath(resource, page), body);
      if (body.data.length === 0) return page - 1;
    }
    return 0;
  }

  private async countRecords(resource: string, totalPages: number): Promise<number> {
    let count = 0;
    for (let page = 1; page <= totalPages; page += 1) {
      const body = await this.readPage(this.pagePath(resource, page));
      if (body) count += body.data.length;
    }
    return count;
  }
}

/** Stable hash of a resource name, for cache directories that must not collide. */
export function resourceKey(resource: string): string {
  return createHash("sha1").update(resource).digest("hex").slice(0, 8);
}

/** Whether every expected page of `resource` is cached. */
export async function isFullyCached(cacheDir: string, resource: string, totalPages: number): Promise<boolean> {
  const dir = join(cacheDir, resource.replace(/\//g, "_"));
  if (!existsSync(dir)) return false;
  const names = await readdir(dir);
  const pages = new Set(
    names.filter((n) => /^\d{6}\.json$/.test(n)).map((n) => Number(n.slice(0, 6))),
  );
  for (let page = 1; page <= totalPages; page += 1) if (!pages.has(page)) return false;
  return true;
}
