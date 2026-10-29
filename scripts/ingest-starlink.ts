/**
 * Ingest both vendor feeds for Starlink objects.
 *
 * Stores the OCM (identity + 7-day arc) and the Modified ITC (covariance) for each
 * object and links the pair. Idempotent: unchanged files are detected by content
 * hash and not rewritten.
 *
 *   npm run ingest:starlink -- --objects STARLINK-38128,STARLINK-37711
 *   npm run ingest:starlink -- --all-local     # every STARLINK-* object we hold
 *   npm run ingest:starlink -- --manifest 5    # first N from the public manifest
 *   npm run ingest:starlink -- --objects A,B --ocm-only   # skip the ITC fetch
 */

async function main() {
  const { loadEnvLocal } = await import("./env");
  loadEnvLocal();

  /** Where pre-downloaded ephemerides live; see `tools/download-starlink.py`. */
  const CACHE_DIR = process.env.SPACE_EYES_CACHE_DIR ?? "./data/ephemeris-cache";

  const { getDb } = await import("../src/db");
  const { objects } = await import("../src/db/schema");
  const { ingestStarlinkObject } = await import("../src/lib/sources/starlink-ingest");
  const { fetchManifest } = await import("../src/lib/sources/starlink-public");

  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };

  const explicit = flag("--objects");
  const allLocal = argv.includes("--all-local");
  const manifestCount = flag("--manifest");

  // Resolve the work list.
  interface Target {
    objectName: string;
    entry: Awaited<ReturnType<typeof fetchManifest>>[number] | null;
  }
  const targets: Target[] = [];

  if (explicit) {
    for (const name of explicit.split(",").map((s) => s.trim()).filter(Boolean)) {
      targets.push({ objectName: name, entry: null });
    }
  } else if (allLocal) {
    const { db } = getDb();
    const names = new Set(
      db
        .select()
        .from(objects)
        .all()
        .map((o) => o.objectName)
        .filter((n) => /^STARLINK-\d+$/.test(n)),
    );
    for (const name of names) targets.push({ objectName: name, entry: null });
  } else if (manifestCount) {
    const manifest = await fetchManifest();
    const n = Number.parseInt(manifestCount, 10) || 0;
    for (const entry of manifest.slice(0, n)) {
      targets.push({ objectName: entry.objectName, entry });
    }
  } else {
    console.error("usage: npm run ingest:starlink -- --objects A,B | --all-local | --manifest N");
    process.exit(2);
  }

  console.log(`\nSpace Eyes — Starlink dual-feed ingest (${targets.length} object(s))\n`);

  // The manifest is needed for the ITC side even when the object names came from
  // the database, because ITC files are only reachable through it.
  let manifest: Awaited<ReturnType<typeof fetchManifest>> | null = null;
  const ensureManifest = async () => {
    if (!manifest) {
      console.log("  fetching manifest…");
      manifest = await fetchManifest();
      console.log(`  manifest: ${manifest.length} entries\n`);
    }
    return manifest;
  };

  const summary: Array<{ name: string; feeds: string[]; norad: number | null; warnings: string[] }> = [];

  for (const target of targets) {
    const entry =
      target.entry ??
      (await ensureManifest()).find((e) => e.objectName === target.objectName) ??
      null;

    if (!entry) {
      console.log(`  ${target.objectName}: no manifest entry, OCM only`);
    }

    try {
      const result = await ingestStarlinkObject(target.objectName, entry, {
        onLog: (m) => console.log(m),
        // Files downloaded ahead of time by `tools/download-starlink.py` are used
        // directly, so an import does not re-fetch hundreds of megabytes.
        cacheDir: CACHE_DIR,
        // Screening needs one feed per object, and the OCM is the better one: a
        // 7-day arc with covariance, against the ITC's 3 days. Skipping the ITC
        // turns a bulk import from network-bound into pure parse-and-write.
        skipItc: argv.includes("--ocm-only"),
      });
      summary.push({
        name: result.objectName,
        feeds: result.feeds.map((f) => `${f.feed}(${f.pointCount})`),
        norad: result.noradId,
        warnings: result.warnings,
      });
    } catch (err) {
      console.log(`  ${target.objectName}: FAILED ${(err as Error).message}`);
      summary.push({ name: target.objectName, feeds: [], norad: null, warnings: [(err as Error).message] });
    }
  }

  console.log("\n— summary —");
  for (const s of summary) {
    console.log(
      `  ${s.name.padEnd(20)} norad=${String(s.norad ?? "-").padEnd(8)} feeds: ${s.feeds.join(", ") || "none"}`,
    );
    for (const w of s.warnings) console.log(`      ! ${w}`);
  }
  console.log();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Keep this file a module: without an export every `main` here lands in the
// global scope and collides with the other scripts' `main`.
export {};
