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
 */

import { eq } from "drizzle-orm";

async function main() {
  const { loadEnvLocal } = await import("./env");
  loadEnvLocal();

  const { getDb, nextSeq } = await import("../src/db");
  const { objects, trajectories } = await import("../src/db/schema");
  const { fetchGp, fetchOmm } = await import("../src/lib/sources/space-track");
  const { toStoredTrajectory } = await import("../src/lib/sources/tle-store");
  const { toStoredOmm } = await import("../src/lib/sources/omm-store");

  const argv = process.argv.slice(2);
  const limitArg = argv.indexOf("--limit");
  const limit = limitArg === -1 ? Infinity : Number(argv[limitArg + 1]) || Infinity;

  const { db, sqlite } = getDb();
  const targets = db
    .select()
    .from(objects)
    .all()
    .filter((o) => o.noradId !== null)
    .slice(0, limit);

  console.log(`\nSpace Eyes — TLE ingest (${targets.length} object(s))\n`);

  let ok = 0;
  let failed = 0;

  // Query in batches. One request per object trips Space-Track's rate limit after
  // roughly twenty calls (the response degrades to a non-TLE page), and the
  // documented predicate already accepts a comma-separated id list.
  const BATCH = 20;
  for (let start = 0; start < targets.length; start += BATCH) {
    const batch = targets.slice(start, start + BATCH);
    const norads = batch.map((o) => o.noradId!);

    const res = await fetchGp({ noradIds: norads, limit: norads.length * 2 });
    if (res.error) {
      failed += batch.length;
      console.log(`  batch ${start + 1}-${start + batch.length} FAILED: ${res.error}`);
      continue;
    }

    // The OMM is the same orbit in named fields, and carries catalogue metadata the
    // TLE cannot (designator, mass class, apogee/perigee, launch date). Fetched in
    // the same batch so the rate limit is paid once.
    const ommRes = await fetchOmm({ noradIds: norads, limit: norads.length * 2 });
    const ommByNorad = new Map(ommRes.records.map((r) => [r.noradId, r]));
    if (ommRes.error) console.log(`  OMM batch failed: ${ommRes.error}`);

    const byNorad = new Map(res.tles.map((t) => [t.noradId, t]));

    for (const object of batch) {
      const tle = byNorad.get(object.noradId!);
      if (!tle) {
        failed += 1;
        console.log(`  ${object.objectName.padEnd(18)} FAILED no TLE in response`);
        continue;
      }

      const existing = db
        .select()
        .from(trajectories)
        .all()
        .find((t) => t.objectId === object.id && t.stateSource === "tle");

      const stored = toStoredTrajectory(
        object.id,
        object.operatorId,
        nextSeq(sqlite, "trajectories"),
        tle,
      );

      if (existing) {
        db.update(trajectories)
          .set(stored)
          .where(eq(trajectories.id, existing.id))
          .run();
      } else {
        db.insert(trajectories).values({ id: crypto.randomUUID(), ...stored }).run();
      }

      ok += 1;
      const epoch = new Date(tle.epochMs).toISOString().slice(0, 19);

      // Store the OMM beside the TLE under its own `state_source`, so the two are
      // never confused: the TLE drives SGP4, the OMM carries catalogue metadata.
      const omm = ommByNorad.get(object.noradId!);
      if (omm) {
        const ommExisting = db
          .select()
          .from(trajectories)
          .all()
          .find((t) => t.objectId === object.id && t.stateSource === "omm");
        const ommRow = toStoredOmm(
          object.id,
          object.operatorId,
          nextSeq(sqlite, "trajectories"),
          omm,
        );
        if (ommExisting) {
          db.update(trajectories).set(ommRow).where(eq(trajectories.id, ommExisting.id)).run();
        } else {
          db.insert(trajectories).values({ id: crypto.randomUUID(), ...ommRow }).run();
        }
      }

      console.log(
        `  ${object.objectName.padEnd(18)} norad=${String(object.noradId).padEnd(7)} ` +
          `epoch=${epoch}  inc=${tle.inclinationDeg.toFixed(3)}°` +
          (omm ? `  omm=${omm.objectId} ${omm.objectType ?? ""}` : "  omm=missing"),
      );
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
