/**
 * Dated archive for every upstream body.
 *
 * ## Why archive raw bodies at all
 *
 * The database holds a *conclusion* — this object had these elements at this
 * time. The archive holds the *evidence*: the exact bytes the provider sent. The
 * two answer different questions:
 *
 *   "What is STARLINK-1008's mean motion?"        → database
 *   "Did Spacebook rewrite last week's elements?"  → archive
 *
 * Without the second, a provider silently revising an element set is
 * undetectable, and a cross-source discrepancy cannot be re-investigated once the
 * next refresh has overwritten the rows.
 *
 * ## Layout
 *
 *   data/archive/<download-id>/<YYYY-MM-DD>/<HHmmss>-<sha256:12>.<ext>
 *
 * The time-of-day prefix keeps the files in fetch order; the hash suffix makes a
 * re-fetch of unchanged content a five-second no-op instead of another 69 MB
 * write, and makes a *changed* body visible as a new file rather than an
 * overwritten one.
 *
 * ## Retention
 *
 * Every capture of a large, rarely-changing body (`satcat/details`, the OMM
 * variants) would otherwise cost hundreds of megabytes a day. The policy keeps:
 *
 *   * every capture from the last 7 days,
 *   * the first and last capture of each day for the previous 90,
 *   * the first capture of each month after that.
 *
 * A body is never deleted while it is the most recent capture of its endpoint —
 * losing the current data to a retention sweep would be a self-inflicted outage.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DownloadSpec } from "./downloads";

export type ArchiveRoot = string;

export interface CaptureResult {
  ok: boolean;
  /** Absolute path of the kept file. */
  path: string;
  bytes: number;
  sha256: string;
  /** True when this body is byte-identical to the previous capture. */
  unchanged: boolean;
  ms: number;
  error?: string;
}

export interface ArchiveOptions {
  /** Default `data/archive`. */
  root?: string;
  /** Injected for tests. */
  now?: () => Date;
}

export class SourceArchive {
  private readonly root: ArchiveRoot;
  private readonly now: () => Date;

  constructor(options: ArchiveOptions = {}) {
    this.root = options.root ?? "data/archive";
    this.now = options.now ?? (() => new Date());
  }

  /** Directory holding one endpoint's captures. */
  dirFor(downloadId: string): string {
    return join(this.root, downloadId);
  }

  /** All capture files for an endpoint, oldest first (names sort chronologically). */
  async captures(downloadId: string): Promise<string[]> {
    const dir = this.dirFor(downloadId);
    if (!existsSync(dir)) return [];
    const days = (await readdir(dir)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    const out: string[] = [];
    for (const day of days) {
      const files = (await readdir(join(dir, day))).filter((f) => !f.endsWith(".part")).sort();
      for (const file of files) out.push(join(dir, day, file));
    }
    return out;
  }

  /** Most recent capture for an endpoint, or null. */
  async latest(downloadId: string): Promise<string | null> {
    const all = await this.captures(downloadId);
    return all.length ? all[all.length - 1] : null;
  }

  /** Read the most recent capture as text, or null when nothing is archived. */
  async latestText(downloadId: string): Promise<string | null> {
    const path = await this.latest(downloadId);
    return path ? readFile(path, "utf8") : null;
  }

  /**
   * Store a fetched body.
   *
   * `previousPath`/`previousHash` let the caller short-circuit an unchanged body:
   * the file is renamed into place under a new timestamp only when the content
   * genuinely changed, so a stable endpoint produces one file a day rather than
   * one per poll.
   */
  async store(
    spec: DownloadSpec,
    body: Buffer,
    previous?: { sha256: string; path: string },
  ): Promise<CaptureResult> {
    const started = Date.now();
    const sha256 = createHash("sha256").update(body).digest("hex");

    if (previous && previous.sha256 === sha256 && existsSync(previous.path)) {
      return {
        ok: true,
        path: previous.path,
        bytes: body.length,
        sha256,
        unchanged: true,
        ms: Date.now() - started,
      };
    }

    const at = this.now();
    const day = at.toISOString().slice(0, 10);
    const clock = at.toISOString().slice(11, 19).replace(/:/g, "");
    const dir = join(this.dirFor(spec.id), day);
    await mkdir(dir, { recursive: true });

    const dest = join(dir, `${clock}-${sha256.slice(0, 12)}.${extensionOf(spec)}`);
    const tmp = `${dest}.part`;
    await writeFile(tmp, body);
    await rename(tmp, dest);

    return {
      ok: true,
      path: dest,
      bytes: body.length,
      sha256,
      unchanged: false,
      ms: Date.now() - started,
    };
  }

  /** Apply the retention policy to one endpoint. Returns the deleted paths. */
  async prune(downloadId: string, now = this.now()): Promise<string[]> {
    const all = await this.captures(downloadId);
    if (all.length <= 1) return [];
    const keep = new Set(selectRetained(all, now));
    const removed: string[] = [];
    for (const path of all) {
      if (keep.has(path)) continue;
      await rm(path, { force: true });
      removed.push(path);
    }
    // Drop day directories that the sweep emptied, so a long-lived archive does
    // not accumulate thousands of empty folders.
    const dir = this.dirFor(downloadId);
    for (const day of await readdir(dir).catch(() => [] as string[])) {
      const full = join(dir, day);
      const entries = await readdir(full).catch(() => null);
      if (entries && entries.length === 0) await rm(full, { recursive: true, force: true });
    }
    return removed;
  }

  /** Bytes currently held for one endpoint. */
  async usage(downloadId: string): Promise<{ files: number; bytes: number }> {
    const all = await this.captures(downloadId);
    let bytes = 0;
    for (const path of all) {
      const info = await stat(path).catch(() => null);
      if (info) bytes += info.size;
    }
    return { files: all.length, bytes };
  }
}

/**
 * Which captures survive retention.
 *
 * Pure and exported so the policy can be tested with fixed paths and a fixed
 * clock, without building a directory tree. `paths` must be sorted oldest first.
 */
export function selectRetained(paths: string[], now: Date): string[] {
  if (paths.length === 0) return [];
  const newest = paths[paths.length - 1];
  const dayMs = 86_400_000;
  const nowMs = now.getTime();

  const byDay = new Map<string, string[]>();
  for (const path of paths) {
    const day = /(\d{4}-\d{2}-\d{2})/.exec(path)?.[1];
    if (!day) continue;
    const list = byDay.get(day) ?? [];
    list.push(path);
    byDay.set(day, list);
  }

  const keep = new Set<string>([newest]);
  const firstOfMonth = new Set<string>();

  for (const [day, list] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    const ageDays = (nowMs - Date.parse(`${day}T12:00:00Z`)) / dayMs;
    const first = list[0];
    const last = list[list.length - 1];

    if (ageDays <= 7) {
      for (const p of list) keep.add(p);
      continue;
    }
    if (ageDays <= 90) {
      keep.add(first);
      keep.add(last);
      continue;
    }
    const month = day.slice(0, 7);
    if (!firstOfMonth.has(month)) {
      firstOfMonth.add(month);
      keep.add(first);
    }
  }

  return [...keep].sort();
}

function extensionOf(spec: DownloadSpec): string {
  switch (spec.format) {
    case "3le":
      return "tle";
    case "json":
      return "json";
    case "csv":
      return "csv";
    case "kvn":
      return "kvn";
    case "xml":
      return "xml";
    default:
      return "txt";
  }
}

/** Ensure the archive root exists; harmless to call repeatedly. */
export async function ensureArchiveRoot(root = "data/archive"): Promise<void> {
  await mkdir(dirname(join(root, "x")), { recursive: true });
}

/** Open a capture for streaming comparison, used by the differ. */
export async function captureLineCount(path: string): Promise<number> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(1 << 20);
    let count = 0;
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      for (let i = 0; i < bytesRead; i += 1) if (buffer[i] === 10) count += 1;
      position += bytesRead;
    }
    return count;
  } finally {
    await handle.close();
  }
}
