/**
 * Build the global constellation snapshot used by the 3D view.
 *
 * ## TLE for display, OCM for analysis
 *
 * This is the important distinction: the *screening* pipeline must keep using
 * operator OCMs, because that is the only source carrying the covariance the
 * probability calculation needs. The **display** does not need that precision —
 * it needs 13 000 orbits on screen in one frame, updated as the globe rotates.
 *
 * So this builder propagates **TLEs with SGP4**. The whole catalogue costs a few
 * seconds instead of the ~27 minutes an OCM parse would take, the payload is
 * small, and any error in position is far below one pixel at the zoom levels where
 * a whole constellation is visible. Screening results are unaffected: they come
 * from the OCM path, not from this file.
 *
 *   npm run build:snapshot
 *   npm run build:snapshot -- --points 96 --step 60
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvLocal } from "./env";
import { encodeQuantised, quantise, type SnapshotFile } from "../src/lib/geo/snapshot";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "public", "data");

interface TleRecord {
  noradId: number;
  name: string;
  line1: string;
  line2: string;
  inclinationDeg: number;
  meanMotionRevPerDay: number;
}

/**
 * Orbit shell key, e.g. `53/550`.
 *
 * Colouring the constellation by shell is what makes 13 000 tracks readable: the
 * real structure of the constellation (inclination and altitude groups) becomes
 * visible instead of a uniform ball.
 */
function shellKey(record: TleRecord): string {
  // Semi-major axis from mean motion, in one line: a = (mu / n^2)^(1/3).
  const MU = 398_600.4418;
  const n = (record.meanMotionRevPerDay * 2 * Math.PI) / 86_400;
  const a = Math.cbrt(MU / (n * n));
  const altitude = Math.round((a - 6378.137) / 10) * 10;
  const inclination = Math.round(record.inclinationDeg);
  return `${inclination}/${altitude}`;
}

async function main(): Promise<void> {
  loadEnvLocal();

  const argv = process.argv.slice(2);
  const arg = (flag: string, fallback: number) => {
    const i = argv.indexOf(flag);
    const v = i === -1 ? NaN : Number(argv[i + 1]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  // 96 points per ~95-minute revolution is a sample every ~60 s: smooth at any
  // zoom that fits a whole constellation on screen.
  const points = arg("--points", 96);
  const stepSec = arg("--step", 60);
  const file = argv.includes("--file") ? argv[argv.indexOf("--file") + 1] : undefined;

  const { getDb } = await import("../src/db");
  const { sqlite } = getDb();

  // TLEs come from the catalogued Space-Track dump when present; otherwise the
  // few we already hold. Display only — screening never reads this.
  let records: TleRecord[];
  if (file) {
    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8"));
    records = raw as TleRecord[];
    console.log(`read ${records.length} TLE(s) from ${file}`);
  } else {
    records = sqlite
      .prepare(
        `SELECT object_name AS name, norad_id AS noradId, line1, line2
         FROM objects WHERE line1 IS NOT NULL AND line2 IS NOT NULL`,
      )
      .all() as TleRecord[];
    if (records.length === 0) {
      console.error(
        "no TLEs in the database. Fetch them first:\n" +
          "  npm run fetch:tle\n" +
          "or pass --file data/tle/starlink-gp.json",
      );
      process.exit(1);
    }
  }

  const { propagateTle } = await import("../src/lib/orbit/sgp4");
  const { parseTle } = await import("../src/lib/orbit/tle");

  const started = Date.now();
  const tracks: SnapshotFile["tracks"] = [];
  const shells = new Map<string, number>();
  let failed = 0;

  for (const record of records) {
    try {
      const parsed = parseTle(`${record.name}\n${record.line1}\n${record.line2}`);
      if ("error" in parsed) {
        failed += 1;
        continue;
      }
      const tle = parsed.tle;
      // One revolution at `stepSec`; SGP4 handles the epoch and refuses states
      // that drift past its age limit, which is why failures are counted rather
      // than propagated silently.
      const revolutionHours = 24 / Math.max(record.meanMotionRevPerDay || 15, 1);
      const spanHours = revolutionHours * 1.02;
      const result = propagateTle(tle, {
        startMs: tle.epochMs,
        spanHours,
        stepSeconds: stepSec,
      });
      if (result.states.length < 8) {
        failed += 1;
        continue;
      }

      const positions = result.states
        .slice(0, points)
        .map((state) => state.position as [number, number, number]);
      // Close the loop so the orbit reads as a ring rather than an arc.
      positions.push(positions[0]);

      const { min, size, q } = quantise(positions);
      const shell = shellKey(record);
      shells.set(shell, (shells.get(shell) ?? 0) + 1);

      tracks.push({
        id: String(record.noradId),
        name: record.name?.trim() || String(record.noradId),
        norad: String(record.noradId),
        shell,
        t0: result.states[0].ms,
        t1: result.states[Math.min(points, result.states.length) - 1].ms,
        min,
        size,
        q: encodeQuantised(q),
      });
    } catch {
      failed += 1;
    }
  }

  const seconds = (Date.now() - started) / 1000;
  const generation = new Date().toISOString().slice(0, 13).replace(/[-:]/g, "");
  const body: SnapshotFile = {
    meta: {
      builtAt: new Date().toISOString(),
      count: tracks.length,
      pointsPerTrack: points,
      generation,
    },
    tracks,
  };

  await mkdir(OUT_DIR, { recursive: true });
  const json = JSON.stringify(body);
  await writeFile(join(OUT_DIR, "constellation.json"), json, "utf8");

  const topShells = [...shells].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(
    `\n${tracks.length} tracks in ${seconds.toFixed(1)} s ` +
      `(${(tracks.length / seconds).toFixed(0)}/s), ${failed} failed`,
  );
  console.log("largest shells:");
  for (const [shell, count] of topShells) console.log(`  ${shell.padEnd(12)} ${count}`);
  console.log(`${(json.length / 1e6).toFixed(1)} MB -> public/data/constellation.json`);
}

void main();
