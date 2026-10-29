/**
 * Download Starlink public ephemerides by name or in bulk.
 *
 * Thin CLI over `EphemerisDownloader`; the download logic — SOCKS node
 * rotation, whole-body completeness checks, no Range requests — lives in
 * `lib/downloader.ts` and is documented there.
 *
 * Node selection: `--nodes` takes explicit endpoints. When omitted, the
 * downloader goes direct, which is what starlink.com needs. Pass
 * `--nodes 127.0.0.1:20170,127.0.0.1:20171` to route through a local proxy.
 *
 *   npm run fetch:ephemeris -- --objects STARLINK-35000,STARLINK-38128
 *   npm run fetch:ephemeris -- --count 100 --concurrency 16
 *   npm run fetch:ephemeris -- --manifest
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EphemerisDownloader } from "./lib/downloader";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = "https://api.starlink.com/public-files/ephemerides";
const MANIFEST = `${BASE}/MANIFEST.txt`;

/**
 * MANIFEST columns, verified against 10 files:
 *   `<norad> <starlink-id> <delivery> <status> <epoch> <classification>`
 * The first field is the NORAD catalogue number, not the object name; the file
 * to fetch is named after the object (`STARLINK-35000`), which is the second
 * field's form.
 */
export interface ManifestEntry {
  noradId: string;
  objectName: string;
  deliverySeq: string;
  status: string;
}

export function parseManifest(text: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6) continue;
    const [noradId, objectName, deliverySeq, status] = fields;
    if (!objectName.startsWith("STARLINK-")) continue;
    entries.push({ noradId, objectName, deliverySeq, status });
  }
  return entries;
}

export class FetchCommand {
  private readonly outDir: string;

  constructor(outDir: string) {
    this.outDir = outDir;
  }

  private async manifest(concurrency: number, nodes: string[]): Promise<number> {
    const downloader = new EphemerisDownloader({ outDir: this.outDir, nodes, concurrency });
    const manifestPath = join(this.outDir, "MANIFEST.txt");
    const fetched = await downloader.download(MANIFEST, manifestPath, "ocm");
    if (!fetched.ok) {
      console.error(`manifest fetch failed: ${fetched.error}`);
      return 1;
    }
    const entries = parseManifest(await readFile(manifestPath, "utf8"));
    console.log(`${entries.length} object(s) in the manifest`);
    return 0;
  }

  async run(argv: string[]): Promise<number> {
    const flag = (name: string): string | undefined => {
      const i = argv.indexOf(name);
      return i === -1 ? undefined : argv[i + 1];
    };
    const nodes = (flag("--nodes") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const concurrency = Number(flag("--concurrency") ?? 16);

    if (argv.includes("--manifest")) {
      return this.manifest(concurrency, nodes);
    }

    const downloader = new EphemerisDownloader({
      outDir: this.outDir,
      nodes,
      concurrency,
      log: (line) => console.log(line),
    });

    let names: string[] = [];
    const objects = flag("--objects");
    if (objects) {
      names = objects.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      const count = Number(flag("--count") ?? 0);
      if (!(count > 0)) {
        console.error(
          "usage: --objects A,B | --count N | --manifest [--nodes host:port,…] [--concurrency N]",
        );
        return 2;
      }
      // Names come from the manifest; without it the caller must list objects.
      const manifestPath = join(this.outDir, "MANIFEST.txt");
      if (!existsSync(manifestPath)) {
        console.error(`no ${manifestPath}; run with --manifest first`);
        return 1;
      }
      names = parseManifest(await readFile(manifestPath, "utf8"))
        .slice(0, count)
        .map((e) => e.objectName);
    }

    console.log(
      `\n${names.length} file(s) via ${nodes.length ? nodes.join(", ") : "direct"}, ` +
        `concurrency ${concurrency}\n`,
    );

    const jobs = names.map((name) => ({
      url: `${BASE}/${name}.txt`,
      dest: downloader.pathFor(name),
    }));

    const results = await downloader.downloadAll(jobs);
    const ok = results.filter((r) => r.ok).length;
    const bytes = results.reduce((sum, r) => sum + r.bytes, 0);
    console.log(`\n${ok}/${results.length} complete, ${(bytes / 1e6).toFixed(1)} MB`);
    for (let i = 0; i < results.length; i += 1) {
      if (!results[i].ok) console.log(`  failed: ${names[i]} — ${results[i].error}`);
    }
    return ok === results.length ? 0 : 1;
  }
}

async function main(): Promise<void> {
  const code = await new FetchCommand(join(ROOT, "data", "ephemeris-cache")).run(
    process.argv.slice(2),
  );
  process.exit(code);
}

void main();
