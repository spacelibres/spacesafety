/**
 * Optical observation source (`spacex_optical`).
 *
 * The vendor's Stargaze system observes objects from star trackers aboard
 * Starlink satellites and publishes *trajectories* derived from those angles.
 * Operators can see CDMs against those trajectories but never the trajectories
 * themselves (`docs/SPEC-BEHAVIOR.md` §5).
 *
 * We have no optical sensor, so this module implements the two things a replica
 * legitimately can:
 *
 *   1. **Ingest** externally produced optical-derived trajectories, marking them
 *      `spacex_optical` and enforcing the visibility rule.
 *   2. **Derive** such a trajectory from angles-only observation data, which is
 *      what "simulating Stargaze" honestly amounts to: we take a position fix
 *      plus range and reconstruct a state, adding realistic covariance growth.
 *
 * What we deliberately do *not* do is pretend to do angles-only orbit
 * determination from a single observer — that needs multiple observers and a
 * full least-squares fit.
 */

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb, nextSeq } from "@/db";
import { objects, operators, trajectoryFiles, trajectories } from "@/db/schema";
import { normaliseTrajectory } from "@/lib/api/validate-trajectory";
import { propagate } from "@/lib/core/propagator";
import { rtnCovToInertial } from "@/lib/orbit/frames-rigorous";
import { formatDoyTimestamp } from "@/lib/orbit/itc";

export const STARGaze_OPERATOR_NAME = "Stargaze (optical)";

/** Position uncertainty floor for an optical-only fix, in km. */
const OPTICAL_BASE_SIGMA_KM = 0.35;
/** How fast that uncertainty grows with prediction age, km per hour. */
const OPTICAL_SIGMA_GROWTH_KM_PER_H = 0.18;

export interface OpticalObservationSource {
  /** Inertial (J2000) position of the observed object, km. */
  position: [number, number, number];
  /** Inertial velocity, km/s. Optical systems get this from a short arc fit. */
  velocity: [number, number, number];
  /** Epoch, Unix ms. */
  ms: number;
  /** Number of transits contributing, when known. */
  transitCount?: number;
}

/**
 * Build a `spacex_optical` trajectory file from a position/velocity fix.
 *
 * The output is Modified ITC (RTN covariance) because that is the format our
 * own ingestion path already understands, and it keeps the optical source on the
 * same normalisation pipeline as operator uploads.
 */
export function buildOpticalTrajectory(
  source: OpticalObservationSource,
  opts: {
    /** How far forward to propagate the fix, hours. */
    horizonHours?: number;
    /** Step between states, seconds. */
    stepSeconds?: number;
  } = {},
): string {
  const { horizonHours = 12, stepSeconds = 60 } = opts;
  const steps = Math.floor((horizonHours * 3_600) / stepSeconds) + 1;

  const lines: string[] = [
    `created:${new Date(source.ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "")} UTC`,
    `ephemeris_source:optical (${source.transitCount ?? 1} transit(s))`,
    "RTN",
  ];

  // Propagate the fix with the same kernel the screener uses, so the optical
  // trajectory is dynamically consistent rather than a straight line.
  const states = propagateFix(source, steps, stepSeconds);

  for (const s of states) {
    lines.push(
      `${formatDoyTimestamp(s.ms)} ${s.position.map((v) => v.toPrecision(12)).join(" ")} ${s.velocity.map((v) => v.toPrecision(12)).join(" ")}`,
    );
    const ageHours = (s.ms - source.ms) / 3_600_000;
    const sigma = OPTICAL_BASE_SIGMA_KM + OPTICAL_SIGMA_GROWTH_KM_PER_H * Math.abs(ageHours);
    const cov = opticalCovariance(s.position, s.velocity, sigma);
    lines.push(...formatLowerTriangle(cov));
  }

  return lines.join("\n") + "\n";
}

/**
 * Optical covariance in RTN, with the along-track term largest — that is the
 * signature of a short-arc fit, and it is what makes optical CDMs more
 * pessimistic than owner ephemerides.
 */
function opticalCovariance(
  position: [number, number, number],
  velocity: [number, number, number],
  sigmaKm: number,
): number[] {
  const rtn = new Array<number>(36).fill(0);
  // R, T, N variances: cross-track from angles is the tightest, along-track the
  // loosest.
  rtn[0] = sigmaKm * sigmaKm;
  rtn[7] = (sigmaKm * 3) ** 2;
  rtn[14] = (sigmaKm * 0.8) ** 2;
  // Velocity: 1 cm/s per axis, scaled with the position uncertainty.
  const v = 1e-5 * sigmaKm * sigmaKm;
  rtn[21] = v;
  rtn[28] = v * 4;
  rtn[35] = v;

  // Convert RTN -> inertial so the store keeps everything in one frame.
  return rtnCovToInertial(rtn, position, velocity);
}

function propagateFix(
  source: OpticalObservationSource,
  steps: number,
  stepSeconds: number,
): { ms: number; position: [number, number, number]; velocity: [number, number, number] }[] {
  const out: {
    ms: number;
    position: [number, number, number];
    velocity: [number, number, number];
  }[] = [];

  let state = { t: 0, r: source.position, v: source.velocity };
  for (let i = 0; i < steps; i += 1) {
    out.push({
      ms: source.ms + i * stepSeconds * 1000,
      position: [state.r[0], state.r[1], state.r[2]],
      velocity: [state.v[0], state.v[1], state.v[2]],
    });
    state = propagate(state, stepSeconds, 30);
  }
  return out;
}

function formatLowerTriangle(cov: number[]): [string, string, string] {
  const vals: number[] = [];
  for (let r = 0; r < 6; r += 1) {
    for (let c = 0; c <= r; c += 1) vals.push(cov[r * 6 + c]);
  }
  const fmt = (arr: number[]) => arr.map((v) => v.toExponential(10)).join(" ");
  return [fmt(vals.slice(0, 7)), fmt(vals.slice(7, 14)), fmt(vals.slice(14, 21))];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface IngestOpticalResult {
  operatorId: string;
  objectId: string;
  trajectoryId: string;
  stateCount: number;
}

/**
 * Store an optical-derived trajectory for an object.
 *
 * The trajectory is always created with `state_source = spacex_optical`, which
 * is what makes the API refuse to serve its contents while still exposing the
 * CDMs it produces.
 */
export function ingestOpticalTrajectory(params: {
  objectId: string;
  source: OpticalObservationSource;
  horizonHours?: number;
}): IngestOpticalResult {
  const { db, sqlite } = getDb();
  const now = new Date().toISOString();

  // A local Stargaze operator account owns these trajectories.
  const existingOperator = db
    .select()
    .from(operators)
    .where(eq(operators.name, STARGaze_OPERATOR_NAME))
    .get();

  const operatorId = existingOperator?.id ?? randomUUID();
  if (!existingOperator) {
    db.insert(operators)
      .values({
        id: operatorId,
        name: STARGaze_OPERATOR_NAME,
        email: null,
        phone: null,
        maxObjects: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  const object = db.select().from(objects).where(eq(objects.id, params.objectId)).get();
  if (!object) {
    throw new Error(`object ${params.objectId} not found`);
  }

  const file = buildOpticalTrajectory(params.source, {
    horizonHours: params.horizonHours,
  });
  const normalised = normaliseTrajectory(file);

  const trajectoryId = randomUUID();
  db.insert(trajectories)
    .values({
      id: trajectoryId,
      objectId: params.objectId,
      operatorId,
      uploadType: "definitive",
      stateSource: "spacex_optical",
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

  db.insert(trajectoryFiles).values({ trajectoryId, fileText: file }).run();

  return {
    operatorId,
    objectId: params.objectId,
    trajectoryId,
    stateCount: normalised.states.length,
  };
}
