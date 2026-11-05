/**
 * Refresh every upstream source, each at its own cadence.
 *
 * This is the multi-source entry point. It replaces the ad-hoc per-feed scripts
 * and, crucially, keeps the feeds *apart*: each source's element sets are written
 * under its own id, so two providers describing the same object no longer
 * overwrite each other.
 *
 * ## What runs when
 *
 * | source | cadence | needs | cost |
 * |---|---|---|---|
 * | space-track | 2 h | login | ~2 s/object, batched |
 * | spacebook-xp-tle | 2 h | proxy | 4.2 MB |
 * | spacebook-omm | 2 h | proxy | 30 MB |
 * | starlink-ocm / itc | 8 h | — | 5 MB × 11 000 objects |
 * | spacebook-satcat | 24 h | proxy | 21 MB |
 *
 * `--force` ignores the cadence; `--only a,b` restricts the set.
 *
 * ## Why Space-Track is fetched differently
 *
 * Spacebook publishes everything in one body, so it is one request. Space-Track
 * has no bulk element-set endpoint worth using — `gp` returns thousands of rows
 * per call and the account is rate-limited per login — so it is fetched for the
 * objects we already know about, in batches, and its session cookie is reused
 * across the whole run.
 *
 *   npm run sources:refresh
 *   npm run sources:refresh -- --only spacebook-xp-tle,spacebook-omm
 *   npm run sources:refresh -- --force --no-spacecraft
 */

import { readFile } from "node:fs/promises";

/**
 * Newest `.tle` under `data/archive/<source>/<day>/`, or null when none exists.
 *
 * `sources:download` writes every Space-Track response body verbatim, so the archive
 * holds the same 3LE the API would return — 69 824 element sets, one file per
 * completed cycle. Reading it is free and cannot hit the per-account rate limit,
 * which the live `fetchGp` path does (measured: HTTP 429 after a few hundred calls,
 * and a 200 carrying `You've violated your query rate limit` that used to be
 * archived as data).
 */
async function newestTleArchive(source: string): Promise<string | null> {
  const { readdir, stat } = await import("node:fs/promises");
  const root = `data/archive/${source}`;
  let best: { path: string; mtime: number } | null = null;
  try {
    for (const day of await readdir(root)) {
      let names: string[];
      try {
        names = await readdir(`${root}/${day}`);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".tle")) continue;
        const path = `${root}/${day}/${name}`;
        const mtime = (await stat(path)).mtimeMs;
        if (!best || mtime > best.mtime) best = { path, mtime };
      }
    }
  } catch {
    return null;
  }
  return best?.path ?? null;
}

async function main(): Promise<void> {
  const { loadEnvLocal } = await import("./env");
  loadEnvLocal();

  const { getDb, nextSeq } = await import("../src/db");
  const { SOURCES, isDue, hasCredentials, sourceById } = await import("../src/lib/sources/registry");
  const { SourceLedger } = await import("../src/lib/sources/ledger");
  const { SpacebookClient } = await import("../src/lib/sources/spacebook");
  const { parseTleFile } = await import("../src/lib/orbit/tle");
  const { importSatcat } = await import("../src/lib/sources/satcat-import");
  const { ingestSourceTle } = await import("../src/lib/sources/multi-ingest");

  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const force = argv.includes("--force");
  const only = flag("--only")?.split(",").map((s) => s.trim());
  const skipSpacecraft = argv.includes("--no-spacecraft");

  const { sqlite } = getDb();
  const ledger = new SourceLedger(sqlite);
  ledger.seedRegistry();

  const lastSuccess = ledger.lastSuccess();
  const selected = SOURCES.filter((s) => (only ? only.includes(s.id) : true)).filter(
    (s) => !skipSpacecraft || !["space-track", "spacebook-xp-tle", "spacebook-omm"].includes(s.id),
  );

  const due = selected.filter((s) => force || isDue(s, lastSuccess.get(s.id) ?? null));
  if (due.length === 0) {
    console.log("\n  nothing due; every source is inside its refresh window");
    console.log("  use --force to refresh anyway\n");
    return;
  }

  console.log(`\nSpace Safety — multi-source refresh (${due.length}/${selected.length} due)\n`);

  const client = new SpacebookClient({ log: (l) => console.log(l) });
  const date = SpacebookClient.dateStamp();
  const started = Date.now();

  for (const source of due) {
    if (!hasCredentials(source)) {
      console.log(`  ${source.id}: SKIPPED — credentials for ${source.credentialEnv} not set`);
      continue;
    }

    const fetchId = ledger.begin(source.id, nextSeq(sqlite, "source_fetches"));
    const t0 = Date.now();

    try {
      if (source.id === "spacebook-satcat" || source.id === "spacebook-satcat-supplemental") {
        const supplemental = source.id === "spacebook-satcat-supplemental";
        // The detail feed carries NORAD numbers and names; the supplemental feed
        // carries status and covariance windows but no NORAD number. Detail must
        // land first, because supplemental updates rows by `entityId` and has
        // nothing to update before the detail import has created them.
        const feed = supplemental ? "satcat-supplemental" : "satcat";
        const snap = await client.fetch(feed, date);
        if (!snap.ok) throw new Error(snap.error ?? "download failed");
        const raw = await readFile(snap.path, "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("snapshot is not an array");

        const { importSatcatSupplemental } = await import("../src/lib/sources/satcat-import");
        const summary = supplemental
          ? importSatcatSupplemental(sqlite, parsed, `spacebook://satcat-supplemental/${date}`)
          : importSatcat(sqlite, parsed, `spacebook://satcat/${date}`);

        ledger.finish(fetchId, {
          sourceId: source.id,
          status: "ok",
          bytes: snap.bytes,
          records: summary.inserted,
          path: snap.path,
        });
        console.log(
          `  ${source.id}: ${summary.inserted} row(s)` +
            (supplemental ? `, ${summary.skipped} unmatched` : "") +
            ` in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        );
        continue;
      }

      if (
        source.id === "spacebook-xp-tle" ||
        source.id === "spacebook-entity-tle" ||
        source.id === "spacebook-omm"
      ) {
        const feed =
          source.id === "spacebook-omm"
            ? "omm"
            : source.id === "spacebook-entity-tle"
              ? "entity-tle"
              : "xp-tle";
        const snap = await client.fetch(feed, date);
        if (!snap.ok) throw new Error(snap.error ?? "download failed");
        const raw = await readFile(snap.path, "utf8");

        // The OMM body carries TLE lines, so it can seed the same per-object
        // table as XP-TLE. That is what makes the cross-check possible at all.
        const text = feed === "omm" ? tleTextFromOmm(raw) : raw;
        const { tles, errors } = parseTleFile(text);
        const written = ingestSourceTle(sqlite, source.id, tles, nextSeq);

        ledger.finish(fetchId, {
          sourceId: source.id,
          status: "ok",
          bytes: snap.bytes,
          records: written,
          path: snap.path,
        });
        console.log(
          `  ${source.id}: ${written} element sets, ${errors.length} rejected ` +
            `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        );
        continue;
      }

      if (source.id === "space-track") {
        const { fetchGp } = await import("../src/lib/sources/space-track");

        // Prefer the archive the scheduled download already produced: same bytes,
        // no login session, no rate limit. `--online` forces the API path.
        const archived = await newestTleArchive("space-track-gp");
        if (archived && !argv.includes("--online")) {
          const parsed = parseTleFile(await readFile(archived, "utf8"));
          const sinceMs = Date.now() - Number(flag("--space-track-days") ?? 3) * 86_400_000;
          const fresh = parsed.tles.filter((t) => t.epochMs >= sinceMs);
          const written = ingestSourceTle(sqlite, source.id, fresh, nextSeq);
          ledger.finish(fetchId, {
            sourceId: source.id,
            status: written > 0 ? "ok" : "failed",
            records: written,
            error: written === 0 ? "no element sets newer than the cutoff" : undefined,
          });
          console.log(
            `  ${source.id}: ${written} element sets from archive ` +
              `(${parsed.tles.length} in file, ${parsed.errors.length} unparsable)`,
          );
          continue;
        }
        // The `gp` class holds every current element set. Filtering by epoch is
        // what makes bulk retrieval work: unfiltered, Space-Track returns the
        // catalogue from NORAD 1 upward, so the first 1 000 rows are 1966-era
        // objects. `minEpochMs` selects what is actually current.
        //
        // There is **no cursor and no offset**. Verified: two identical calls
        // return the same five ids, and asking for 5 000 or 20 000 returns that
        // many in one response ordered by NORAD id. So the correct shape is a
        // single request with a limit above the expected count — paging would
        // re-fetch page 1 every time and store the same objects repeatedly while
        // reporting an inflated "records" count.
        const sinceDays = Number(flag("--space-track-days") ?? 3);
        const limit = Number(flag("--space-track-limit") ?? 40_000);
        const minEpochMs = Date.now() - sinceDays * 86_400_000;

        const started = Date.now();
        const res = await fetchGp({ minEpochMs, limit });
        const written = res.error ? 0 : ingestSourceTle(sqlite, source.id, res.tles, nextSeq);

        // Hitting the limit exactly means there may be more, and the API gives no
        // way to fetch the remainder. Say so rather than implying completeness.
        const truncated = !res.error && res.tles.length >= limit;

        ledger.finish(fetchId, {
          sourceId: source.id,
          status: written > 0 ? "ok" : "failed",
          records: written,
          error: res.error ?? (written === 0 ? "no element sets returned" : undefined),
        });
        console.log(
          `  ${source.id}: ${written} element sets (epoch > ${sinceDays}d) in ` +
            `${((Date.now() - started) / 1000).toFixed(1)}s` +
            (truncated ? ` — HIT LIMIT ${limit}, raise --space-track-limit` : "") +
            (res.error ? ` — ${res.error}` : ""),
        );
        continue;
      }

      if (source.id === "spaceweather" || source.id === "eop") {
        const feed = source.id === "spaceweather" ? "spaceweather" : "eop";
        const snap = await client.fetch(feed, date);
        if (!snap.ok) throw new Error(snap.error ?? "download failed");
        ledger.finish(fetchId, {
          sourceId: source.id,
          status: "ok",
          bytes: snap.bytes,
          path: snap.path,
        });
        console.log(`  ${source.id}: ${(snap.bytes / 1e6).toFixed(1)} MB`);
        continue;
      }

      console.log(`  ${source.id}: no handler; skipped`);
      ledger.finish(fetchId, { sourceId: source.id, status: "unchanged" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ledger.finish(fetchId, { sourceId: source.id, status: "failed", error: message });
      console.log(`  ${source.id}: FAILED — ${message}`);
    }
  }

  console.log(`\n  done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  console.log("  coverage:");
  for (const row of ledger.coverage()) {
    const label = sourceById(row.sourceId)?.label ?? row.sourceId;
    console.log(
      `    ${label.padEnd(28)} ${String(row.objects).padStart(7)} objects, ` +
        `newest epoch ${row.newestEpoch ?? "—"}`,
    );
  }
  console.log();
}

/**
 * Pull the `TLE_LINE1` / `TLE_LINE2` pairs out of a Spacebook OMM array.
 *
 * Spacebook embeds a TLE for every OMM record. Reusing it means one parser and
 * one comparison basis for both feeds; the mean-element fields are still stored
 * separately by the ingest for the field-level diff.
 */
function tleTextFromOmm(raw: string): string {
  const records = JSON.parse(raw) as Array<{
    OBJECT_NAME?: string;
    TLE_LINE1?: string;
    TLE_LINE2?: string;
  }>;
  const out: string[] = [];
  for (const r of records) {
    if (r.TLE_LINE1 && r.TLE_LINE2) {
      out.push(r.OBJECT_NAME ?? "", r.TLE_LINE1, r.TLE_LINE2);
    }
  }
  return out.join("\n");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
