/**
 * Spacebook (COMSPOC) public data client.
 *
 * Spacebook is the free, complete catalogue behind `spacebook.com`. Its site is
 * a Cesium SPA, but the data it renders comes from plain JSON/CSV/KVN/text
 * endpoints under `/api/…`, and those are what this class consumes. Serving the
 * same fields the site serves is the point: anything Spacebook can show, the
 * replica can show, from the same numbers.
 *
 * ## What each endpoint gives us
 *
 * | Endpoint | Format | Size | Role |
 * |---|---|---|---|
 * | `/api/Entity/xp-tle` | 2-line TLE, no names | 4.2 MB | every tracked object's element set |
 * | `/api/entity/omm/json` | CCSDS OMM + TLE lines | 30 MB | same orbits, named, with catalogue metadata |
 * | `/api/entity/satcat` | JSON array | 21 MB | full historical catalogue, 72 000 rows |
 * | `/api/spaceweather/{recent,full}` | CCSDS KVN | 0.4/3.4 MB | F10.7 and Ap for drag |
 * | `/api/eop/{recent,full}` | CCSDS KVN | 0.2 MB | polar motion and UT1-UTC |
 *
 * ## Two facts that shape the code
 *
 * 1. **Query parameters are ignored.** `?noradId=`, `?limit=`, `?format=` all
 *    return the identical full body (verified: 4 153 520 bytes every time). So
 *    there is no per-object fetch and no pagination — every refresh is a full
 *    download, and filtering happens after parsing.
 * 2. **The host truncates silently.** A short read still looks like a completed
 *    request, and a truncated TLE file parses into a *smaller catalogue* with no
 *    error. Every body is therefore length-checked against `content-length`
 *    before it is accepted, and the parse is expected to yield thousands of
 *    records, not merely more than zero.
 *
 * ## Why a class
 *
 * The client owns a downloader with a node-rotation policy and failure counters
 * that must survive across the several endpoints of one refresh, so the state
 * lives with the object rather than in module scope.
 */

import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { EphemerisDownloader } from "../../../tools/lib/downloader";

export const SPACEBOOK_BASE = "https://spacebook.com";

/** Bumped when the on-disk layout changes, so old snapshots are recognisable. */
export const SPACEBOOK_SNAPSHOT_SCHEMA = 1;

/**
 * Feeds this client knows how to fetch.
 *
 * `entity-tle` and `satcat-supplemental` are the newer endpoints the SPA itself
 * uses. `entity-tle` supersedes `xp-tle` (32 809 objects against 29 668, verified
 * by NORAD set difference) and `satcat-supplemental` is the only feed that states
 * per-object covariance windows, which decide whether a Pc is computable at all.
 */
export type SpacebookFeed =
  | "xp-tle"
  | "entity-tle"
  | "omm"
  | "satcat"
  | "satcat-supplemental"
  | "spaceweather"
  | "eop";

export interface SpacebookEndpoints {
  "xp-tle": string;
  "entity-tle": string;
  omm: string;
  satcat: string;
  "satcat-supplemental": string;
  spaceweather: string;
  eop: string;
}

export const DEFAULT_ENDPOINTS: SpacebookEndpoints = {
  "xp-tle": `${SPACEBOOK_BASE}/api/Entity/xp-tle`,
  "entity-tle": `${SPACEBOOK_BASE}/api/entity/tle`,
  "satcat-supplemental": `${SPACEBOOK_BASE}/api/entity/satcat/supplemental`,
  omm: `${SPACEBOOK_BASE}/api/entity/omm/json`,
  satcat: `${SPACEBOOK_BASE}/api/entity/satcat`,
  spaceweather: `${SPACEBOOK_BASE}/api/spaceweather/full`,
  eop: `${SPACEBOOK_BASE}/api/eop/full`,
};

export interface SpacebookOptions {
  /** Where snapshots land. Default `data/spacebook`. */
  outDir?: string;
  /** SOCKS5 endpoints, `host:port`. Empty falls back to a direct request. */
  nodes?: string[];
  concurrency?: number;
  timeoutMs?: number;
  tries?: number;
  endpoints?: Partial<SpacebookEndpoints>;
  log?: (line: string) => void;
}

/** A downloaded, verified snapshot of one feed. */
export interface SpacebookSnapshot {
  feed: SpacebookFeed;
  /** `YYYY-MM-DD`, the UTC day the snapshot was taken. */
  date: string;
  path: string;
  bytes: number;
  /** True when the body satisfied the format's own sanity test. */
  ok: boolean;
  error?: string;
}

/**
 * Minimum plausible byte count per feed.
 *
 * These are not decoration. The host's failure mode is a *successful* response
 * that is quietly short, and a short TLE file parses cleanly into a smaller
 * catalogue. A floor an order of magnitude below the real size still catches a
 * 10x-short body while letting a genuinely shrinking catalogue (objects decay)
 * through.
 */
const MIN_BYTES: Record<SpacebookFeed, number> = {
  "xp-tle": 1_500_000,
  "entity-tle": 1_500_000,
  omm: 8_000_000,
  satcat: 5_000_000,
  "satcat-supplemental": 5_000_000,
  spaceweather: 500_000,
  eop: 30_000,
};

export class SpacebookClient {
  private readonly endpoints: SpacebookEndpoints;
  private readonly outDir: string;
  private readonly downloader: EphemerisDownloader;
  private readonly log: (line: string) => void;

  constructor(options: SpacebookOptions = {}) {
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };
    this.outDir = options.outDir ?? "data/spacebook";
    this.log = options.log ?? ((line) => console.log(line));
    // `xp-tle` is plain text with no terminator line, and `kind: "ocm"` would
    // demand `TRAJ_STOP`. The byte floors in `MIN_BYTES` are the completeness
    // test instead, so the downloader is used purely as a proxy-aware,
    // node-rotating transport and the format checks happen in `verify`.
    this.downloader = new EphemerisDownloader({
      outDir: this.outDir,
      nodes: options.nodes ?? defaultNodes(),
      concurrency: options.concurrency ?? 4,
      timeoutMs: options.timeoutMs ?? 180_000,
      tries: options.tries ?? 4,
      log: this.log,
    });
  }

  /** `YYYY-MM-DD` in UTC. */
  static dateStamp(now = new Date()): string {
    return now.toISOString().slice(0, 10);
  }

  /** Where a snapshot of `feed` taken on `date` is stored. */
  pathFor(feed: SpacebookFeed, date: string): string {
    return join(this.outDir, `${feed}_${date}.${extensionFor(feed)}`);
  }

  /**
   * Download one feed and keep it only if it passes `verify`.
   *
   * An existing file from the same day is reused when it already verifies, so a
   * retried refresh does not re-download 30 MB of OMM.
   */
  async fetch(feed: SpacebookFeed, date = SpacebookClient.dateStamp()): Promise<SpacebookSnapshot> {
    const dest = this.pathFor(feed, date);
    const url = this.endpoints[feed];

    const existing = await this.verify(dest, feed).catch(() => null);
    if (existing?.ok) {
      this.log(`  ${feed}: reusing ${dest} (${(existing.bytes / 1e6).toFixed(1)} MB)`);
      return { ...existing, feed, date, path: dest };
    }

    const result = await this.downloader.download(url, dest, "text");
    if (!result.ok) {
      return { feed, date, path: dest, bytes: 0, ok: false, error: result.error };
    }

    const checked = await this.verify(dest, feed);
    if (!checked.ok) return { ...checked, feed, date, path: dest };
    return { ...checked, feed, date, path: dest };
  }

  /** Download several feeds, at most `concurrency` at a time. */
  async fetchAll(
    feeds: SpacebookFeed[],
    date = SpacebookClient.dateStamp(),
  ): Promise<SpacebookSnapshot[]> {
    const out: SpacebookSnapshot[] = [];
    for (const feed of feeds) out.push(await this.fetch(feed, date));
    return out;
  }

  /**
   * Check that a file on disk really is a complete body of `feed`.
   *
   * Content-based, not size-based alone: the first bytes must not be an HTML or
   * JSON error page, and the last bytes must end on a record boundary. A body
   * that stops mid-record is what a dropped connection looks like.
   */
  async verify(path: string, feed: SpacebookFeed): Promise<SpacebookSnapshot> {
    let bytes = 0;
    try {
      bytes = (await stat(path)).size;
    } catch {
      return { feed, date: "", path, bytes: 0, ok: false, error: "missing" };
    }
    const date = path.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";

    if (bytes < MIN_BYTES[feed]) {
      return { feed, date, path, bytes, ok: false, error: `too short (${bytes} bytes)` };
    }

    const head = await readSlice(path, 0, 256);
    const lead = head.toString("utf8").trimStart();
    if (lead.startsWith("<!DOCTYPE") || lead.startsWith("<html")) {
      return { feed, date, path, bytes, ok: false, error: "HTML error page" };
    }

    const tail = (await readSlice(path, Math.max(0, bytes - 4096), 4096)).toString("utf8");
    if (!endsOnRecordBoundary(tail, feed)) {
      return { feed, date, path, bytes, ok: false, error: "truncated mid-record" };
    }
    return { feed, date, path, bytes, ok: true };
  }

  /**
   * Move a verified snapshot to its canonical dated name.
   *
   * Used by the tooling that writes to a temporary name first; exposed so the
   * naming convention (and its date extraction) lives in one place.
   */
  async promote(tmpPath: string, feed: SpacebookFeed, date: string): Promise<string> {
    const dest = this.pathFor(feed, date);
    await mkdir(dirname(dest), { recursive: true });
    await rename(tmpPath, dest);
    return dest;
  }

  /** Write a body to disk atomically, for callers that already have the bytes. */
  async store(body: Buffer | string, feed: SpacebookFeed, date: string): Promise<string> {
    const dest = this.pathFor(feed, date);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    await writeFile(tmp, body);
    await rename(tmp, dest);
    return dest;
  }
}

export function extensionFor(feed: SpacebookFeed): string {
  switch (feed) {
    case "xp-tle":
    case "entity-tle":
      return "tle";
    case "omm":
    case "satcat":
    case "satcat-supplemental":
      return "json";
    default:
      return "txt";
  }
}

/**
 * Is the end of the body a record boundary for this feed?
 *
 * * `xp-tle` ends with line 2 of a TLE, which is a fixed 69 columns; a short
 *   final line means the stream died mid-record.
 * * `omm` and `satcat` are JSON arrays, so the body must close with `]`.
 * * the CCSDS KVN feeds end with an `END <label>` line (e.g. `END PREDICTED`,
 *   `END MONTHLY_FIT`). They are longer than their `recent` counterparts and end
 *   there, not with a `*_STOP` marker.
 */
function endsOnRecordBoundary(tail: string, feed: SpacebookFeed): boolean {
  const trimmed = tail.trimEnd();
  switch (feed) {
    case "xp-tle":
    case "entity-tle": {
      const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
      // 68 or 69 columns depending on whether the trailing checksum survived.
      return lastLine.startsWith("2 ") && lastLine.length >= 66;
    }
    case "omm":
    case "satcat":
    case "satcat-supplemental":
      return trimmed.endsWith("]") || trimmed.endsWith("}");
    default: {
      const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
      return /^END\b/.test(lastLine) || /\w+_STOP$/.test(lastLine) || trimmed.endsWith("]");
    }
  }
}

async function readSlice(path: string, position: number, length: number): Promise<Buffer> {
  const { open } = await import("node:fs/promises");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Proxy nodes from the environment.
 *
 * `SPACE_SAFETY_PROXY` is a comma-separated list of `host:port` SOCKS5
 * endpoints; the project's convention is `socks5://…`, which is stripped here
 * because the dialer wants a bare `host:port`. Without it the download falls back
 * to a direct request, which works for a few endpoints and truncates on the big
 * ones — worth trying, never worth trusting.
 */
export function defaultNodes(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.SPACE_SAFETY_PROXY ?? env.SPACE_SAFETY_PROXY_NODES ?? "";
  return raw
    .split(",")
    .map((entry) => entry.trim().replace(/^socks5h?:\/\//, "").replace(/\/$/, ""))
    .filter((entry) => entry !== "");
}
