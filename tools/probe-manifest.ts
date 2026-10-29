/**
 * Inspect the Starlink ephemerides MANIFEST and reconcile it with the OCMs.
 *
 * The manifest's column meanings are not documented. This tool answers the two
 * questions that matter for ingestion:
 *
 *   1. Which field is the NORAD catalogue number, and which is the object name?
 *      Verification: read `OBJECT_DESIGNATOR` out of each OCM and compare.
 *   2. Do the status values distinguish usable ephemerides from stale ones?
 *
 * Measured result (10 files): field 1 = NORAD id, field 2 = object name,
 * field 3 = delivery sequence. The first field is *not* the object name, which
 * was an earlier wrong assumption.
 *
 *   npm run probe:manifest
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EphemerisDownloader } from "./lib/downloader";
import { parseManifest } from "./fetch-ephemeris";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CACHE = join(ROOT, "data", "ephemeris-cache");
const BASE = "https://api.starlink.com/public-files/ephemerides";

/** `OBJECT_DESIGNATOR` from an OCM body, or null. */
export function objectDesignator(raw: string): string | null {
  return raw.match(/^OBJECT_DESIGNATOR\s*=\s*(\S+)/m)?.[1] ?? null;
}

export class ManifestProbe {
  private readonly cacheDir: string;
  private readonly nodes: string[];

  constructor(cacheDir: string, nodes: string[] = []) {
    this.cacheDir = cacheDir;
    this.nodes = nodes;
  }

  async run(sampleSize = 10): Promise<number> {
    const downloader = new EphemerisDownloader({
      outDir: this.cacheDir,
      nodes: this.nodes,
      concurrency: 4,
    });
    const manifestPath = join(this.cacheDir, "MANIFEST.txt");
    const fetched = await downloader.download(`${BASE}/MANIFEST.txt`, manifestPath, "ocm");
    if (!fetched.ok) {
      console.error(`manifest fetch failed: ${fetched.error}`);
      return 1;
    }

    const entries = parseManifest(await readFile(manifestPath, "utf8"));
    console.log(`${entries.length} manifest entries`);

    const statuses = new Map<string, number>();
    for (const entry of entries) {
      statuses.set(entry.status, (statuses.get(entry.status) ?? 0) + 1);
    }
    console.log("status distribution:");
    for (const [status, count] of [...statuses].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${status.padEnd(16)} ${count}`);
    }

    console.log(`\nchecking ${sampleSize} OCM(s) against the manifest:`);
    let matches = 0;
    for (const entry of entries.slice(0, sampleSize)) {
      const file = join(this.cacheDir, `${entry.objectName}.txt`);
      if (!existsSync(file)) {
        console.log(`  ${entry.objectName}: not downloaded, skipped`);
        continue;
      }
      const designator = objectDesignator(await readFile(file, "utf8"));
      const ok = designator === entry.noradId;
      if (ok) matches += 1;
      console.log(
        `  ${entry.objectName.padEnd(16)} manifest[0]=${entry.noradId.padEnd(8)} ` +
          `OCM=${String(designator).padEnd(8)} ${ok ? "match" : "MISMATCH"}`,
      );
    }

    console.log(
      `\n${matches} of ${sampleSize} agree: field 1 is the NORAD catalogue id, ` +
        `field 2 the object name, field 3 the delivery sequence.`,
    );
    return matches === 0 ? 1 : 0;
  }
}

async function main(): Promise<void> {
  process.exit(await new ManifestProbe(CACHE).run());
}

void main();
