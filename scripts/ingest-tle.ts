/**
 * Store Space-Track TLEs for the objects already in the database.
 *
 * TLEs serve two jobs here, neither of which is replacing the operator ephemeris:
 *
 *   - **Initial screening** of objects with no vendor ephemeris (everything that
 *     is not Starlink), and
 *   - **Cross-check** — the SGP4 state at the OCM's first epoch should agree with
 *     it; a large disagreement means one of the two is stale.
 *
 * Both feeds are kept: the OCM/ITC under `operator_ephemeris`, the TLE under
 * `tle`. They are separate trajectory rows so nothing downstream has to guess
 * which precision it is looking at.
 *
 *   npm run ingest:tle
 *   npm run ingest:tle -- --limit 20
 *   npm run ingest:tle -- --online       (ignore the archive, query the API)
 *
 * ## Why the archive is the default source
 *
 * This used to page the Space-Track API in batches of 20 objects, which is two
 * requests per batch (GP and OMM) — about 8 400 calls for the 42 000 objects here.
 * Space-Track answered HTTP 429 after a few hundred, so the run stored 280 objects
 * and failed 42 147.
 *
 * The same data is already on disk. `sources:download` writes the complete GP file
 * (69 824 element sets, 11 MB) and Spacebook's complete OMM dump (30 MB) under
 * `data/archive/` on every cycle. Reading those is one pass over local files: no
 * rate limit, no network, and it cannot disagree with the rest of the pipeline,
 * because it *is* the file the pipeline loads.
 *
 * `--online` still exists for the case where the archive is missing.
 */

import { eq } from "drizzle-orm";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Newest file with `ext` under `data/archive/<source>/<day>/`. */
function newestArchive(source: string, ext: string): string | null {
  const root = join("data", "archive", source);
  let best: { path: string; mtime: number } | null = null;
  try {
    for (const day of readdirSync(root)) {
      const dir = join(root, day);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(ext)) continue;
        const path = join(dir, name);
        let mtime: number;
        try {
          mtime = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        if (!best || mtime > best.mtime) best = { path, mtime };
      }
    }
  } catch {
    return null;
  }
  return best?.path ?? null;
}

async function main() {
  const { loadEnvLocal } = await import("./env");
  loadEnvLocal();

  const { getDb, nextSeq } = await import("../src/db");
  const { objects, trajectories } = await import("../src/db/schema");
  const { fetchGp, fetchOmm, parseOmmRows } = await import("../src/lib/sources/space-track");
  const { toStoredTrajectory } = await import("../src/lib/sources/tle-store");
  const { toStoredOmm } = await import("../src/lib/sources/omm-store");
  const { parseTleFile } = await import("../src/lib/orbit/tle");

  const argv = process.argv.slice(2);
  const limitArg = argv.indexOf("--limit");
  const limit = limitArg === -1 ? Infinity : Number(argv[limitArg + 1]) || Infinity;
  const online = argv.includes("--online");

  const { db, sqlite } = getDb();
  const targets = db
    .select()
    .from(objects)
    .all()
    .filter((o) => o.noradId !== null)
    .slice(0, limit);

  console.log(`\nSpace Safety — TLE ingest (${targets.length} object(s))\n`);

  // ------------------------------------------------------------ load element sets
  const tleByNorad = new Map<number, ReturnType<typeof parseTleFile>["tles"][number]>();
  const ommByNorad = new Map<number, Awaited<ReturnType<typeof fetchOmm>>["records"][number]>();

  if (!online) {
    const gpFile = newestArchive("space-track-gp", ".tle");
    if (gpFile) {
      const parsed = parseTleFile(readFileSync(gpFile, "utf8"));
      for (const t of parsed.tles) tleByNorad.set(t.noradId, t);
      console.log(`  GP 归档      ${gpFile}`);
      console.log(`               ${tleByNorad.size} 套根数，${parsed.errors.length} 行无法解析`);
    } else {
      console.log("  GP 归档      未找到，回落到 API");
    }

    const ommFile = newestArchive("spacebook-omm-json", ".json");
    if (ommFile) {
      const raw = JSON.parse(readFileSync(ommFile, "utf8")) as unknown;
      const rows: Array<Record<string, unknown>> = Array.isArray(raw)
        ? (raw as Array<Record<string, unknown>>)
        : (((raw as Record<string, unknown>).data ??
            (raw as Record<string, unknown>).value ??
            []) as Array<Record<string, unknown>>);
      // The archive is the API's body verbatim, so it goes through the same mapping
      // the live path uses — including its handling of Space-Track's zone-less EPOCH.
      for (const rec of parseOmmRows(rows)) ommByNorad.set(rec.noradId, rec);
      console.log(`  OMM 归档     ${ommFile}`);
      console.log(`               ${ommByNorad.size} 条`);
    } else {
      console.log("  OMM 归档     未找到，回落到 API");
    }
  }

  // Anything the archive did not cover: ask the API, in batches. One request per
  // object trips the rate limit after roughly twenty calls, and the documented
  // predicate already accepts a comma-separated id list.
  const missing = targets.filter((o) => !tleByNorad.has(o.noradId!));
  if (missing.length > 0 && (online || tleByNorad.size === 0)) {
    const BATCH = 20;
    console.log(`\n  API 补齐      ${missing.length} 个对象，每批 ${BATCH}\n`);
    for (let start = 0; start < missing.length; start += BATCH) {
      const batch = missing.slice(start, start + BATCH);
      const norads = batch.map((o) => o.noradId!);
      const res = await fetchGp({ noradIds: norads, limit: norads.length * 2 });
      if (res.error) {
        console.log(`  batch ${start + 1}-${start + batch.length} FAILED: ${res.error}`);
        continue;
      }
      for (const t of res.tles) tleByNorad.set(t.noradId, t);

      const ommRes = await fetchOmm({ noradIds: norads, limit: norads.length * 2 });
      if (ommRes.error) console.log(`  OMM batch failed: ${ommRes.error}`);
      for (const r of ommRes.records) ommByNorad.set(r.noradId, r);
    }
  }

  // ------------------------------------------------------------------ write rows
  let ok = 0;
  let failed = 0;
  const verbose = targets.length <= 50;

  // Existing trajectory ids per object, read once. The old loop called `.all()` on
  // the whole table twice per object — O(n²) over 42 000 rows — which is why the
  // run spent its time in SQLite rather than writing.
  const existing = new Map<string, { tle?: string; omm?: string }>();
  for (const t of db.select().from(trajectories).all()) {
    if (t.stateSource !== "tle" && t.stateSource !== "omm") continue;
    const entry = existing.get(t.objectId) ?? {};
    if (t.stateSource === "tle") entry.tle = t.id;
    else entry.omm = t.id;
    existing.set(t.objectId, entry);
  }

  for (const object of targets) {
    const tle = tleByNorad.get(object.noradId!);
    if (!tle) {
      failed += 1;
      if (verbose) console.log(`  ${object.objectName.padEnd(18)} FAILED no TLE`);
      continue;
    }

    const prior = existing.get(object.id) ?? {};
    const stored = toStoredTrajectory(
      object.id,
      object.operatorId,
      nextSeq(sqlite, "trajectories"),
      tle,
    );
    if (prior.tle) {
      db.update(trajectories).set(stored).where(eq(trajectories.id, prior.tle)).run();
    } else {
      const id = crypto.randomUUID();
      db.insert(trajectories).values({ id, ...stored }).run();
      prior.tle = id;
      existing.set(object.id, prior);
    }

    // Store the OMM beside the TLE under its own `state_source`, so the two are
    // never confused: the TLE drives SGP4, the OMM carries catalogue metadata.
    const omm = ommByNorad.get(object.noradId!);
    if (omm) {
      const ommRow = toStoredOmm(
        object.id,
        object.operatorId,
        nextSeq(sqlite, "trajectories"),
        omm,
      );
      if (prior.omm) {
        db.update(trajectories).set(ommRow).where(eq(trajectories.id, prior.omm)).run();
      } else {
        const id = crypto.randomUUID();
        db.insert(trajectories).values({ id, ...ommRow }).run();
        prior.omm = id;
        existing.set(object.id, prior);
      }
    }

    ok += 1;
    if (verbose) {
      const epoch = new Date(tle.epochMs).toISOString().slice(0, 19);
      console.log(
        `  ${object.objectName.padEnd(18)} norad=${String(object.noradId).padEnd(7)} ` +
          `epoch=${epoch}  inc=${tle.inclinationDeg.toFixed(3)}°` +
          (omm ? "  omm=yes" : "  omm=missing"),
      );
    } else if (ok % 5000 === 0) {
      console.log(`  ${ok} / ${targets.length}`);
    }
  }

  console.log(`\n${ok} stored, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Keep this file a module: without an export every `main` here lands in the
// global scope and collides with the other scripts' `main`.
export {};
