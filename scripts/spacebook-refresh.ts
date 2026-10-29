/**
 * Refresh the Spacebook catalogue: download, verify, parse, store.
 *
 * This is the single entry point for the feed that gives the replica its NORAD
 * identity layer. Before it existed, only Starlink objects had a catalogue
 * number, so the `/objects` page could not name anything else.
 *
 * Steps, in order, each able to fail without leaving the database worse than it
 * was found:
 *
 *   1. download xp-tle, omm, satcat (and optionally the space-weather/EOP KVN)
 *   2. parse the TLE file — a parse that yields fewer than half the expected
 *      number of records is treated as a truncated download, not a shrinking
 *      catalogue
 *   3. import SATCAT (full replace, one transaction)
 *   4. ingest TLEs (merge into `objects`/`trajectories`, one transaction)
 *
 *   npm run spacebook:refresh
 *   npm run spacebook:refresh -- --feeds xp-tle,satcat
 *   npm run spacebook:refresh -- --no-download   # use today's snapshots on disk
 *   npm run spacebook:refresh -- --max-age 7     # drop element sets older than a week
 */

import { readFile } from "node:fs/promises";

async function main(): Promise<void> {
  const { loadEnvLocal } = await import("./env");
  loadEnvLocal();

  const { getDb } = await import("../src/db");
  const { SpacebookClient } = await import("../src/lib/sources/spacebook");
  const { parseTleFile } = await import("../src/lib/orbit/tle");
  const { importSatcat } = await import("../src/lib/sources/satcat-import");
  const { TleCatalogueIngest, loadSatcat } = await import("../src/lib/sources/spacebook-ingest");

  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const has = (name: string) => argv.includes(name);

  const download = !has("--no-download");
  const feedsArg = flag("--feeds");
  const feeds = (feedsArg ? feedsArg.split(",") : ["xp-tle", "omm", "satcat"]).map((s) =>
    s.trim(),
  ) as Array<"xp-tle" | "omm" | "satcat" | "spaceweather" | "eop">;
  const maxAge = Number(flag("--max-age") ?? 30);

  const client = new SpacebookClient({ log: (l) => console.log(l) });
  const date = SpacebookClient.dateStamp();

  console.log(`\nSpace Safety — Spacebook refresh (${date})\n`);

  // ---- 1. download -----------------------------------------------------------
  const snapshots = new Map<string, string>();
  for (const feed of feeds) {
    if (!download) {
      snapshots.set(feed, client.pathFor(feed, date));
      continue;
    }
    const snap = await client.fetch(feed, date);
    if (!snap.ok) {
      console.error(`  ${feed}: FAILED — ${snap.error}`);
      // xp-tle and satcat are both needed for identity; without either the ingest
      // would insert unnamed objects that a later run has to repair.
      if (feed === "xp-tle" || feed === "satcat") process.exit(1);
      continue;
    }
    snapshots.set(feed, snap.path);
    console.log(`  ${feed}: ok ${(snap.bytes / 1e6).toFixed(1)} MB`);
  }

  const { db, sqlite } = getDb();

  // ---- 2. parse --------------------------------------------------------------
  const tlePath = snapshots.get("xp-tle");
  const satcatPath = snapshots.get("satcat");

  const tleText = tlePath ? await readFile(tlePath, "utf8").catch(() => "") : "";
  if (!tleText) {
    console.error("  no xp-tle body available; nothing to ingest");
    process.exit(1);
  }
  const { tles, errors } = parseTleFile(tleText);
  console.log(`\n  xp-tle: ${tles.length} element set(s), ${errors.length} rejected`);

  // A body that produced a third of the usual catalogue is a truncated download
  // that still ended on a record boundary. The floor is the only defence left.
  const MIN_TLE = 20_000;
  if (tles.length < MIN_TLE) {
    console.error(
      `  refusing to ingest: ${tles.length} records is below the ${MIN_TLE} floor ` +
        `(truncated download?)`,
    );
    process.exit(1);
  }

  // ---- 3. SATCAT -------------------------------------------------------------
  if (satcatPath) {
    const raw = await readFile(satcatPath, "utf8").catch(() => "");
    if (raw) {
      // The file starts with `[` and is an array of objects; a bare JSON.parse is
      // exact and refuses a truncated body rather than silently importing part.
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.error(`  satcat: JSON parse failed — ${(err as Error).message}`);
        process.exit(1);
      }
      if (!Array.isArray(parsed)) {
        console.error("  satcat: snapshot is not an array");
        process.exit(1);
      }
      const summary = importSatcat(sqlite, parsed, `spacebook://satcat/${date}`);
      console.log(
        `  satcat: ${summary.inserted} imported, ${summary.skipped} skipped, ` +
          `${(summary.ms / 1000).toFixed(1)}s`,
      );
    }
  }

  // ---- 4. names + TLE ingest -------------------------------------------------
  const satcat = loadSatcat(sqlite);
  const names = new Map<number, string>();

  // SATCAT first, so an OMM entry overrides it where both exist.
  for (const [norad, meta] of satcat) names.set(norad, meta.name);

  const ommPath = snapshots.get("omm");
  if (ommPath) {
    const raw = await readFile(ommPath, "utf8").catch(() => "");
    if (raw) {
      try {
        const records = JSON.parse(raw) as Array<{ NORAD_CAT_ID?: number; OBJECT_NAME?: string }>;
        let merged = 0;
        for (const rec of records) {
          const norad = Number(rec.NORAD_CAT_ID);
          const name = rec.OBJECT_NAME?.trim();
          if (Number.isFinite(norad) && name) {
            names.set(norad, name);
            merged += 1;
          }
        }
        console.log(`  omm: ${merged} name(s) merged`);
      } catch (err) {
        console.log(`  omm: unusable (${(err as Error).message}); falling back to SATCAT names`);
      }
    }
  }

  const ingest = new TleCatalogueIngest({
    maxAgeDays: maxAge,
    log: (l) => console.log(l),
  });
  const summary = ingest.run(sqlite, tles, satcat, names);

  console.log(
    `\n  tle ingest: ${summary.inserted} new, ${summary.updated} refreshed, ` +
      `${summary.named} named, ${summary.skippedStale} stale-skipped ` +
      `in ${(summary.ms / 1000).toFixed(1)}s\n`,
  );

  void db;
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
