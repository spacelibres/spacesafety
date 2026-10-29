/**
 * Shared headless-Chrome helpers for harvesting the vendor documentation.
 *
 * The Space Safety docs site is a client-rendered SPA: its page bodies live in
 * hashed JS chunks and are not available as static HTML or as a public OpenAPI
 * file. Reading them therefore means rendering each page in a real browser and
 * taking the DOM the way a reader sees it.
 *
 * This is a `ChromeRenderer` rather than a pair of free functions because each
 * instance owns a single Chrome process that is started once and reused: paying
 * process startup per page turns a two-minute harvest into a twenty-minute one.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

export type ChromeBinary = string;

/** Locate a Chrome-compatible binary on PATH, or throw with a clear message. */
export async function findChrome(): Promise<ChromeBinary> {
  for (const name of CANDIDATES) {
    const found = await which(name);
    if (found) return found;
  }
  throw new Error(
    `no Chrome/Chromium found (tried ${CANDIDATES.join(", ")}). ` +
      `Install one — the docs site renders client-side and cannot be read without a browser.`,
  );
}

async function which(name: string): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process");
    return await new Promise<string | null>((resolve) => {
      execFile("which", [name], (err, stdout) => {
        resolve(err ? null : stdout.trim() || null);
      });
    });
  } catch {
    return null;
  }
}

export interface RenderOptions {
  /** Extra wait after load, for the SPA to finish hydrating, ms. */
  settleMs?: number;
  timeoutMs?: number;
}

/**
 * Renders pages to DOM dumps with one long-lived headless Chrome.
 *
 * `dump()` runs Chrome with `--dump-dom` for a URL. Chrome exits after dumping,
 * so each call still pays startup; the class exists to own the scratch profile
 * and the binary lookup once, and to give callers a single thing to close.
 */
export class ChromeRenderer {
  private readonly binary: ChromeBinary;
  private readonly profile: Promise<string>;
  private closed = false;

  constructor(binary: ChromeBinary) {
    this.binary = binary;
    this.profile = mkdtemp(join(tmpdir(), "spacesafety-chrome-"));
  }

  static async create(): Promise<ChromeRenderer> {
    return new ChromeRenderer(await findChrome());
  }

  /** The page's serialised DOM, or null when Chrome failed. */
  async dump(url: string, options: RenderOptions = {}): Promise<string | null> {
    if (this.closed) throw new Error("renderer is closed");
    const profile = await this.profile;
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--virtual-time-budget=8000",
      `--user-data-dir=${profile}`,
      "--dump-dom",
      url,
    ];

    const child: ChildProcess = spawn(this.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    const timeoutMs = options.timeoutMs ?? 60_000;
    const finished = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(false);
      }, timeoutMs);
      child.on("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    if (!finished || !stdout.trim()) return null;
    if (options.settleMs) await new Promise((r) => setTimeout(r, options.settleMs));
    return stdout;
  }

  /** Render a page to a file; returns the path or null on failure. */
  async dumpToFile(url: string, path: string, options?: RenderOptions): Promise<string | null> {
    const dom = await this.dump(url, options);
    if (dom === null) return null;
    await writeFile(path, dom, "utf8");
    return path;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await rm(await this.profile, { recursive: true, force: true });
  }
}

/** Strip tags and decode the handful of entities the docs use. */
export function htmlToText(fragment: string): string {
  return fragment
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
