/**
 * Demo seeder.
 *
 * Populates a fresh database with real Starlink ephemerides so the UI and API are
 * immediately meaningful:
 *
 *   1. fetch the public manifest and pick a handful of satellites,
 *   2. download and store each ephemeris as a `definitive` trajectory,
 *   3. run the real screening kernel pairwise and ingest the resulting CDMs.
 *
 * Everything goes through the same code paths the HTTP API uses, so seeded state
 * is indistinguishable from organically uploaded data. Files are cached, so
 * repeated runs are instant and offline-capable.
 *
 *   npm run demo:seed               # 6 satellites
 *   npm run demo:seed -- --count 12
 *   npm run demo:seed -- --offline  # reuse the cache only
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getDb, nextSeq } from "../src/db";
import { catalog, objects, operators, screeningJobs, trajectoryFiles, trajectories } from "../src/db/schema";
import { ingestScreeningResult } from "../src/lib/api/screening-service";
import { normaliseTrajectory } from "../src/lib/api/validate-trajectory";
import { screen } from "../src/lib/core/screening";
import {
  fetchEphemeris,
  fetchManifest,
  type ManifestEntry,
} from "../src/lib/sources/starlink-public";

const CACHE_DIR = process.env.SPACE_SAFETY_CACHE ?? "./data/ephemeris-cache";
/** Starlink hard-body radius: 17.66 m diameter. */
const HBR_KM = 0.00883;

async function main() {
  const countArg = process.argv.indexOf("--count");
  const count = countArg !== -1 ? Number(process.argv[countArg + 1]) || 6 : 6;
  const offline = process.argv.includes("--offline");

  console.log(`\nSpace Safety — demo seed (${count} satellites)\n`);

  const { db, sqlite } = getDb();
  const now = new Date().toISOString();

  const selfId = "11111111-1111-4111-8111-111111111111";
  const starlinkId = "22222222-2222-4222-8222-222222222222";

  for (const op of [
    { id: selfId, name: "Space Safety", email: "ops@spacesafety.example", phone: "+86 10 0000 0000" },
    { id: starlinkId, name: "Starlink", email: "satellite-operators@starlink.com", phone: "+1 310 363 6000" },
  ]) {
    db.insert(operators)
      .values({
        id: op.id,
        name: op.name,
        email: op.email,
        phone: op.phone,
        maxObjects: 20000,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  }

  mkdirSync(CACHE_DIR, { recursive: true });

  let entries: ManifestEntry[];
  if (offline) {
    const cached = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".txt"));
    entries = cached.slice(0, count).map((fileName, i) => ({
      fileName,
      sequence: 100000 + i,
      objectName: fileName.replace(/\.txt$/, ""),
      // Offline seeds have no manifest, so no catalogue number is known here.
      noradId: 0,
      deliverySequence: 0,
      status: "Operational",
      epoch: 0,
      url: "",
    }));
    console.log(`  offline mode: ${entries.length} cached file(s)`);
  } else {
    console.log("  fetching manifest…");
    const manifest = await fetchManifest();
    console.log(`  manifest: ${manifest.length} satellites`);
    entries = manifest.slice(0, count);
  }

  interface Prepared {
    objectId: string;
    trajectoryId: string;
    name: string;
    fileText: string;
  }
  const prepared: Prepared[] = [];

  for (const entry of entries) {
    const objectId = crypto.randomUUID();
    const trajectoryId = crypto.randomUUID();
    const cachePath = join(CACHE_DIR, `${sanitise(entry.objectName)}.txt`);

    let raw: string | null = null;
    if (existsSync(cachePath)) {
      raw = readFileSync(cachePath, "utf8");
      console.log(`  ${entry.objectName}: cached (${(raw.length / 1e6).toFixed(1)} MB)`);
    } else if (!offline) {
      process.stdout.write(`  ${entry.objectName}: downloading…`);
      try {
        const eph = await fetchEphemeris(entry, {
          timeoutMs: 180_000,
          retries: 2,
        });
        raw = eph.raw;
        writeFileSync(cachePath, raw);
        process.stdout.write(` ${(raw.length / 1e6).toFixed(1)} MB\n`);
      } catch (err) {
        process.stdout.write(` failed (${(err as Error).message.slice(0, 40)})\n`);
      }
    }

    if (!raw) {
      console.log(`  ${entry.objectName}: skipped`);
      continue;
    }

    let normalised;
    try {
      normalised = normaliseTrajectory(raw);
    } catch (err) {
      console.log(`  ${entry.objectName}: rejected — ${(err as Error).message}`);
      continue;
    }

    db.insert(objects)
      .values({
        id: objectId,
        operatorId: starlinkId,
        objectName: entry.objectName,
        noradId: null,
        hardBodyRadius: HBR_KM * 1000,
        maneuverability: true,
        alive: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.insert(trajectories)
      .values({
        id: trajectoryId,
        objectId,
        operatorId: starlinkId,
        uploadType: "definitive",
        stateSource: "operator_ephemeris",
        screenedStatus: "not_screened",
        fileFormat: normalised.format,
        startAt: normalised.startAt,
        endAt: normalised.endAt,
        pointCount: normalised.states.length,
        uploadedAt: now,
        createdAt: now,
        seq: nextSeq(sqlite, "trajectories"),
      })
      .run();

    prepared.push({ objectId, trajectoryId, name: entry.objectName, fileText: raw });
  }

  if (prepared.length === 0) {
    console.error("\nno trajectories available; run once without --offline\n");
    process.exit(1);
  }

  console.log(`\n  screening ${prepared.length} trajectories pairwise…`);
  for (const item of prepared) {
    db.insert(catalog)
      .values({
        objectId: item.objectId,
        stateSource: "operator_ephemeris",
        trajectoryId: item.trajectoryId,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  }

  const started = Date.now();
  let totalCdms = 0;
  let totalHits = 0;

  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const a = prepared[i];
      const b = prepared[j];

      const jobId = crypto.randomUUID();
      db.insert(screeningJobs)
        .values({
          id: jobId,
          trajectoryId: a.trajectoryId,
          againstTrajectoryId: b.trajectoryId,
          status: "dispatched",
          createdAt: now,
          seq: nextSeq(sqlite, "screening_jobs"),
        })
        .run();

      const sa = sampleForScreening(a.fileText);
      const sb = sampleForScreening(b.fileText);
      if (!sa || !sb) continue;

      const out = screen({
        jobId,
        primary: { ...sa, trajectoryId: a.trajectoryId, objectId: a.objectId, objectName: a.name },
        secondary: { ...sb, trajectoryId: b.trajectoryId, objectId: b.objectId, objectName: b.name },
        maxSamplePoints: 3000,
      });

      ingestScreeningResult({
        jobId,
        approaches: out.approaches,
        primaryTrajectoryId: a.trajectoryId,
        secondaryTrajectoryId: b.trajectoryId,
      });

      totalHits += out.approaches.length;
      totalCdms += out.approaches.length;
      console.log(
        `    ${a.name} × ${b.name}: ${out.approaches.length} approach(es), min range ${out.stats.minRangeKm.toFixed(0)} km`,
      );
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n  ${totalHits} close approach(es) → ${totalCdms} CDM(s) in ${elapsed}s`);
  console.log(
    `  database: ${prepared.length} objects, ${prepared.length} trajectories`,
  );
  console.log("\ndone. start the app with `npm run dev`.\n");
}

function sanitise(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

function sampleForScreening(text: string) {
  try {
    const n = normaliseTrajectory(text);
    return {
      trajectoryId: "",
      objectId: "",
      objectName: n.objectName ?? "UNKNOWN",
      hardBodyRadiusKm: HBR_KM,
      stateSource: "operator_ephemeris",
      states: n.states.map((s) => ({
        epochMs: String(s.ms),
        px: s.position[0],
        py: s.position[1],
        pz: s.position[2],
        vx: s.velocity[0],
        vy: s.velocity[1],
        vz: s.velocity[2],
        covariance: s.covariance ?? [],
      })),
    };
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Keep this file a module: without an export every `main` here lands in the
// global scope and collides with the other scripts' `main`.
export {};
