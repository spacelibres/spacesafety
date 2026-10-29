/**
 * Ingest every downloaded OCM, in batches.
 *
 * `npm run ingest:starlink -- --objects A,B,…` takes the object list on the
 * command line, which is fine for a handful and hopeless for 11 000: the
 * argument list alone is 164 KB and the shell rejects it. This driver walks the
 * cache directory and invokes that script in batches, so the ingestion code
 * stays in one place (TypeScript) and only the batching lives here.
 *
 * The ingest is idempotent — unchanged files are recognised by content hash —
 * so an interrupted run can be resumed with `--after <name>`.
 *
 *   npm run ingest:all
 *   npm run ingest:all -- --after STARLINK-12345 --batch 200
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CACHE = join(ROOT, "data", "ephemeris-cache");

export interface IngestOptions {
  cacheDir: string;
  batchSize: number;
  /** Resume after this object name, alphabetically. */
  after?: string;
  log?: (line: string) => void;
}

interface BatchOutcome {
  ok: boolean;
  output: string;
}

/** Runs the per-object ingest script in batches. */
export class BatchIngest {
  private readonly options: Required<Omit<IngestOptions, "log" | "after">> & {
    after?: string;
    log: (line: string) => void;
  };

  constructor(options: IngestOptions) {
    this.options = {
      cacheDir: options.cacheDir,
      batchSize: options.batchSize,
      after: options.after,
      log: options.log ?? ((line) => console.log(line)),
    };
  }

  /** Object names present in the cache, sorted. */
  async names(): Promise<string[]> {
    if (!existsSync(this.options.cacheDir)) return [];
    const entries = await readdir(this.options.cacheDir);
    return entries
      .filter((n) => n.endsWith(".txt"))
      .map((n) => n.slice(0, -4))
      .sort();
  }

  private runBatch(objects: string[]): Promise<BatchOutcome> {
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          "--conditions=react-server",
          "--import",
          "tsx",
          "scripts/ingest-starlink.ts",
          "--objects",
          objects.join(","),
          "--ocm-only",
        ],
        { cwd: ROOT, env: process.env },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        process.stderr.write(chunk);
      });
      child.on("close", (code) => resolve({ ok: code === 0, output }));
      child.on("error", (err) => resolve({ ok: false, output: `${err.message}\n` }));
    });
  }

  async run(): Promise<number> {
    let names = await this.names();
    if (names.length === 0) {
      this.options.log(`no OCM files in ${this.options.cacheDir}`);
      return 1;
    }

    if (this.options.after) {
      const index = names.indexOf(this.options.after);
      if (index === -1) {
        this.options.log(`"${this.options.after}" is not in the cache; starting from the beginning`);
      } else {
        names = names.slice(index + 1);
        this.options.log(`resuming after ${this.options.after}: ${names.length} remaining`);
      }
    }

    const started = Date.now();
    let done = 0;
    let failed = 0;

    for (let i = 0; i < names.length; i += this.options.batchSize) {
      const batch = names.slice(i, i + this.options.batchSize);
      const outcome = await this.runBatch(batch);
      done += batch.length;
      if (!outcome.ok) failed += batch.length;
      const elapsed = (Date.now() - started) / 1000;
      const rate = done / Math.max(1, elapsed);
      const eta = (names.length - done) / Math.max(rate, 1e-6);
      this.options.log(
        `\n[${done}/${names.length}] ${outcome.ok ? "ok" : "FAILED"} ` +
          `${rate.toFixed(1)} obj/s, eta ${(eta / 60).toFixed(1)} min` +
          (failed ? `, ${failed} failed so far` : ""),
      );
      if (!outcome.ok) {
        this.options.log(outcome.output.split("\n").slice(-15).join("\n"));
        return 1;
      }
    }

    this.options.log(`\nall ${names.length} object(s) ingested`);
    return 0;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const code = await new BatchIngest({
    cacheDir: CACHE,
    batchSize: Number(flag("--batch") ?? 150),
    after: flag("--after"),
  }).run();
  process.exit(code);
}

void main();
