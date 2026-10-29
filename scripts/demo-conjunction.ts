/**
 * Conjunction fixture generator.
 *
 * Real Starlink satellites maintain kilometres to thousands of kilometres of
 * separation, so a random sample never produces a close approach — the screening
 * pipeline would have nothing to show. This script derives a synthetic
 * "partner" object from a real ephemeris by applying a small, physically
 * consistent offset, which produces genuine close approaches with real covariance.
 *
 * Two output modes:
 *   --emit <file>   write the derived trajectory to a file (ITC format)
 *   --seed          insert operator/object/trajectory rows and screen them
 *
 *   npm run demo:conjunction -- --seed
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getDb, nextSeq } from "../src/db";
import {
  catalog,
  objects,
  operators,
  screeningJobs,
  trajectoryFiles,
  trajectories,
} from "../src/db/schema";
import { ingestScreeningResult } from "../src/lib/api/screening-service";
import { normaliseTrajectory, type NormalisedTrajectory } from "../src/lib/api/validate-trajectory";
import { screen } from "../src/lib/core/screening";
import { formatDoyTimestamp, toLowerTriangle6x6 } from "../src/lib/orbit/itc";

const CACHE_DIR = process.env.SPACE_EYES_CACHE ?? "./data/ephemeris-cache";
const PARTNER_OPERATOR_ID = "33333333-3333-4333-8333-333333333333";
const PARTNER_OPERATOR_NAME = "Demo Partner";
const HBR_KM = 0.00883;

async function main() {
  const emitIndex = process.argv.indexOf("--emit");
  const doSeed = process.argv.includes("--seed");

  const primaryName =
    process.env.SPACE_EYES_PRIMARY ?? "STARLINK-38128";
  const cachePath = join(CACHE_DIR, `${primaryName}.txt`);
  if (!existsSync(cachePath)) {
    console.error(
      `no cached ephemeris for ${primaryName} at ${cachePath}\n` +
        `run \`npm run demo:seed\` first to download it.`,
    );
    process.exit(1);
  }

  const raw = readFileSync(cachePath, "utf8");
  const primary = normaliseTrajectory(raw);

  // Offset the partner along-track so its range sweeps through a minimum near
  // the middle of the shared window. A 40 km offset at ~7.6 km/s closes in
  // roughly 5 s; we ramp it instead so the approach happens over minutes and
  // stays inside the 44 km along-track half-width long enough to be sampled.
  const partner = derivePartner(primary, primaryName);

  if (emitIndex !== -1) {
    const out = process.argv[emitIndex + 1];
    writeFileSync(out, toItc(partner, `${primaryName}-PARTNER`));
    console.log(`wrote ${out}`);
    return;
  }

  if (!doSeed) {
    console.log(
      `derived partner for ${primaryName}: ${partner.states.length} states, ` +
        `span ${((partner.states.at(-1)!.ms - partner.states[0].ms) / 3.6e6).toFixed(1)} h\n` +
        `use --seed to insert it, or --emit <file> to write it out`,
    );
    return;
  }

  await seed(primaryName, primary, partner);
}

/**
 * Build a trajectory that crosses the primary's path.
 *
 * Rotating the whole trajectory about a body-fixed axis by a small angle gives
 * two orbits that intersect at two points per revolution. Because the nodes
 * precess slightly differently the intersection drifts, and because the orbits
 * are inclined relative to each other the relative speed at the crossing is
 * tens to hundreds of metres per second — the well-conditioned regime for the
 * 2D Alfano method.
 *
 * The rotation is expressed by transforming position *and* velocity, so
 * dynamical consistency (circular speed at the new radius) is preserved.
 */
function derivePartner(
  primary: NormalisedTrajectory,
  primaryName: string,
): NormalisedTrajectory {
  const angleDeg = Number(process.env.SPACE_EYES_INC_DELTA_DEG ?? 0.02);
  const a = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);

  // A pure inclination difference makes the orbits intersect exactly at the
  // node, giving sub-metre misses (Pc = 1, which is correct but uninteresting).
  // Adding a constant cross-track bias moves the crossing into the 100 m to
  // 5 km band, which spans low, medium and high risk.
  const biasKm = Number(process.env.SPACE_EYES_CROSS_BIAS_KM ?? 0.04);

  // Image the first state's position to pick a rotation axis roughly along the
  // primary's velocity, so the defect is mostly cross-track at the crossing.
  const first = primary.states[0];
  const vr = first.velocity;
  const vn = Math.hypot(vr[0], vr[1], vr[2]) || 1;
  const k = [vr[0] / vn, vr[1] / vn, vr[2] / vn];

  // Rodrigues rotation about k.
  const rot = (p: number[]): [number, number, number] => {
    const dot = p[0] * k[0] + p[1] * k[1] + p[2] * k[2];
    const cross = [
      k[1] * p[2] - k[2] * p[1],
      k[2] * p[0] - k[0] * p[2],
      k[0] * p[1] - k[1] * p[0],
    ];
    return [
      p[0] * ca + cross[0] * sa + k[0] * dot * (1 - ca),
      p[1] * ca + cross[1] * sa + k[1] * dot * (1 - ca),
      p[2] * ca + cross[2] * sa + k[2] * dot * (1 - ca),
    ];
  };

  const states = primary.states.map((s) => {
    const r = rot(s.position);
    const rn = Math.hypot(r[0], r[1], r[2]) || 1;
    // Body-fixed +Z is a good stand-in for cross-track at LEO latitudes we use.
    const bias: [number, number, number] = [0, 0, biasKm];
    return {
      ms: s.ms,
      position: [r[0] + bias[0], r[1] + bias[1], r[2] + bias[2]] as [number, number, number],
      velocity: rot(s.velocity),
      covariance: s.covariance,
    };
    void rn;
  });

  return { ...primary, states, objectName: `${primaryName}-PARTNER` };
}

/** Serialize back to Modified ITC (EME2000 positions, RTN covariance). */
function toItc(traj: NormalisedTrajectory, name: string): string {
  const lines: string[] = [
    `created:${new Date().toISOString().replace("T", " ").replace(/\..*/, "")} UTC`,
    `ephemeris_start:${iso(traj.states[0].ms)} UTC ephemeris_stop:${iso(traj.states.at(-1)!.ms)} UTC step_size:60`,
    "ephemeris_source:derived",
    "RTN",
  ];

  for (const s of traj.states) {
    lines.push(
      `${formatDoyTimestamp(s.ms)} ${s.position[0].toPrecision(10)} ${s.position[1].toPrecision(10)} ${s.position[2].toPrecision(10)} ${s.velocity[0].toPrecision(10)} ${s.velocity[1].toPrecision(10)} ${s.velocity[2].toPrecision(10)}`,
    );
    const cov = s.covariance ? toLowerTriangle6x6(s.covariance) : new Array(21).fill(0);
    lines.push(cov.slice(0, 7).map((v) => v.toExponential(10)).join(" "));
    lines.push(cov.slice(7, 14).map((v) => v.toExponential(10)).join(" "));
    lines.push(cov.slice(14, 21).map((v) => v.toExponential(10)).join(" "));
  }

  void name;
  return lines.join("\n") + "\n";
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

async function seed(
  primaryName: string,
  primary: NormalisedTrajectory,
  partner: NormalisedTrajectory,
) {
  const { db, sqlite } = getDb();
  const now = new Date().toISOString();
  mkdirSync("./data", { recursive: true });

  db.insert(operators)
    .values({
      id: PARTNER_OPERATOR_ID,
      name: PARTNER_OPERATOR_NAME,
      email: "partner@example.test",
      phone: "+1 555 0100",
      maxObjects: 100,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();

  // Find the primary object created by demo:seed.
  const primaryObject = db
    .select()
    .from(objects)
    .all()
    .find((o) => o.objectName === primaryName);

  if (!primaryObject) {
    console.error(`no object named ${primaryName}; run \`npm run demo:seed\` first`);
    process.exit(1);
  }

  const primaryTrajectory = db
    .select()
    .from(trajectories)
    .all()
    .find((t) => t.objectId === primaryObject.id);
  if (!primaryTrajectory) {
    console.error(`no trajectory for ${primaryName}`);
    process.exit(1);
  }

  const partnerObjectId = crypto.randomUUID();
  const partnerTrajectoryId = crypto.randomUUID();
  const partnerRaw = toItc(partner, `${primaryName}-PARTNER`);
  const partnerNormalised = normaliseTrajectory(partnerRaw);

  db.insert(objects)
    .values({
      id: partnerObjectId,
      operatorId: PARTNER_OPERATOR_ID,
      objectName: `${primaryName}-PARTNER`,
      noradId: 99999,
      hardBodyRadius: 12,
      maneuverability: false,
      alive: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(trajectoryFiles).values({
    trajectoryId: partnerTrajectoryId,
    fileText: partnerRaw,
  }).run();

  db.insert(trajectories)
    .values({
      id: partnerTrajectoryId,
      objectId: partnerObjectId,
      operatorId: PARTNER_OPERATOR_ID,
      uploadType: "definitive",
      stateSource: "operator_ephemeris",
      screenedStatus: "not_screened",
      fileFormat: partnerNormalised.format,
      startAt: partnerNormalised.startAt,
      endAt: partnerNormalised.endAt,
      pointCount: partnerNormalised.states.length,
      uploadedAt: now,
      createdAt: now,
      seq: nextSeq(sqlite, "trajectories"),
    })
    .run();

  db.insert(catalog)
    .values({
      objectId: partnerObjectId,
      stateSource: "operator_ephemeris",
      trajectoryId: partnerTrajectoryId,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();

  const jobId = crypto.randomUUID();
  db.insert(screeningJobs)
    .values({
      id: jobId,
      trajectoryId: partnerTrajectoryId,
      againstTrajectoryId: primaryTrajectory.id,
      status: "dispatched",
      createdAt: now,
      seq: nextSeq(sqlite, "screening_jobs"),
    })
    .run();

  const sa = toSample(partnerNormalised);
  const sb = toSample(primary);

  // Cross-inclined orbits converge twice per revolution, so a 3-day arc yields
  // ~90 approaches. A demo is clearer with a handful of events, so trim both
  // trajectories to their first few hours before screening.
  const horizonHours = Number(process.env.SPACE_EYES_HORIZON_HOURS ?? 6);
  const horizonMs = horizonHours * 3_600_000;
  const trimmed = (s: ReturnType<typeof toSample>) => {
    const t0 = Number(s.states[0].epochMs);
    return {
      ...s,
      states: s.states.filter((st) => Number(st.epochMs) - t0 <= horizonMs),
    };
  };

  const out = screen({
    jobId,
    primary: {
      ...trimmed(sa),
      trajectoryId: partnerTrajectoryId,
      objectId: partnerObjectId,
      objectName: `${primaryName}-PARTNER`,
    },
    secondary: {
      ...trimmed(sb),
      trajectoryId: primaryTrajectory.id,
      objectId: primaryObject.id,
      objectName: primaryName,
    },
    maxSamplePoints: 4000,
  });

  const res = ingestScreeningResult({
    jobId,
    approaches: out.approaches,
    primaryTrajectoryId: partnerTrajectoryId,
    secondaryTrajectoryId: primaryTrajectory.id,
  });

  console.log(
    `\nseeded ${primaryName}-PARTNER (${partnerNormalised.states.length} states)`,
  );
  console.log(`  ${out.approaches.length} close approach(es)`);
  for (const a of out.approaches) {
    console.log(
      `    TCA ${new Date(Number(a.tcaEpochMs)).toISOString()}  miss ${a.missDistanceKm.toFixed(3)} km  vrel ${a.relativeSpeedKmS.toFixed(3)} km/s  Pc ${a.probabilityOfCollision?.toExponential(3) ?? "NULL"}`,
    );
  }
  console.log(`  ${res.cdmIds.length} CDM(s) written\n`);
}

function toSample(t: NormalisedTrajectory) {
  return {
    trajectoryId: "",
    objectId: "",
    objectName: t.objectName ?? "UNKNOWN",
    hardBodyRadiusKm: HBR_KM,
    stateSource: "operator_ephemeris",
    states: t.states.map((s) => ({
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
}

void writeFileSync;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Keep this file a module: without an export every `main` here lands in the
// global scope and collides with the other scripts' `main`.
export {};
