/**
 * Screening orchestration on the API side.
 *
 * Responsibilities, in the order the vendor's architecture note describes:
 *
 *   1. **Queue** — a new trajectory is enqueued (`not_screened`).
 *   2. **Catalog** — the newest definitive trajectory per (object, state source)
 *      is what everything screens against.
 *   3. **Dispatch** — pending pairs are shipped to the compute node over gRPC.
 *   4. **Ingest** — results become CDMs, events, and trajectory status changes.
 *
 * The heavy maths lives in `src/lib/core`; this module only moves data and
 * maintains the invariants (event grouping window, CDM `is_active` rules).
 */

import { randomUUID } from "node:crypto";

import { and, eq, inArray, ne, or, sql } from "drizzle-orm";

import { closeDb, getDb, nextSeq } from "@/db";
import {
  catalog,
  cdms as cdmsTable,
  events as eventsTable,
  objects,
  operators,
  screeningJobs,
  trajectories,
} from "@/db/schema";

import { buildCdmJson, stringifyCdm } from "./cdm";
import type { CloseApproachMsg } from "../grpc/proto";
import { dateToGpsNanos, gpsNanosToDate } from "../space-safety/gps";

/** CDMs whose TCAs land within this window join the same conjunction event. */
export const EVENT_GROUPING_WINDOW_MS = 20 * 60 * 1000;

/**
 * Enqueue screening work for a freshly uploaded trajectory.
 *
 * Hypothetical uploads are screened once and never enter the catalog; definitive
 * and candidate uploads replace the object's catalog entry.
 */
export function enqueueScreening(params: {
  trajectoryId: string;
  objectId: string;
  uploadType: string;
  stateSource: string;
}): number {
  const { sqlite } = getDb();
  const db = getDb().db;
  const now = new Date().toISOString();

  return sqlite.transaction(() => {
    // Every other object's catalog entry is a potential partner.
    const partners = db
      .select({ objectId: catalog.objectId, trajectoryId: catalog.trajectoryId })
      .from(catalog)
      .where(ne(catalog.objectId, params.objectId))
      .all();

    let queued = 0;
    for (const partner of partners) {
      const seq = nextSeq(sqlite, "screening_jobs");
      db.insert(screeningJobs)
        .values({
          id: randomUUID(),
          trajectoryId: params.trajectoryId,
          againstTrajectoryId: partner.trajectoryId,
          status: "pending",
          attempts: 0,
          createdAt: now,
          seq,
        })
        .run();
      queued += 1;
    }

    // Only definitive/candidate uploads become the reference for others.
    if (params.uploadType !== "hypothetical") {
      const existing = db
        .select()
        .from(catalog)
        .where(
          and(
            eq(catalog.objectId, params.objectId),
            eq(catalog.stateSource, params.stateSource),
          ),
        )
        .get();

      if (existing) {
        db.update(catalog)
          .set({ trajectoryId: params.trajectoryId, updatedAt: now })
          .where(
            and(
              eq(catalog.objectId, params.objectId),
              eq(catalog.stateSource, params.stateSource),
            ),
          )
          .run();
      } else {
        db.insert(catalog)
          .values({
            objectId: params.objectId,
            stateSource: params.stateSource,
            trajectoryId: params.trajectoryId,
            updatedAt: now,
          })
          .run();
      }
    }

    return queued;
  })();
}

/**
 * Pull a batch of pending jobs and mark them dispatched.
 *
 * Called by the gRPC dispatcher. Returns rows the caller should ship to a
 * worker; if the worker dies, `requeueStale` puts them back.
 */
export function claimPendingJobs(limit: number, workerId: string): {
  id: string;
  trajectoryId: string;
  againstTrajectoryId: string | null;
}[] {
  const { db, sqlite } = getDb();
  const now = new Date().toISOString();

  return sqlite.transaction(() => {
    const rows = db
      .select()
      .from(screeningJobs)
      .where(eq(screeningJobs.status, "pending"))
      .orderBy(screeningJobs.seq)
      .limit(limit)
      .all();

    if (rows.length === 0) return [];

    db.update(screeningJobs)
      .set({ status: "dispatched", workerId, dispatchedAt: now })
      .where(inArray(screeningJobs.id, rows.map((r) => r.id)))
      .run();

    return rows.map((r) => ({
      id: r.id,
      trajectoryId: r.trajectoryId,
      againstTrajectoryId: r.againstTrajectoryId,
    }));
  })();
}

/** Return jobs that were dispatched but never completed. */
export function requeueStale(staleAfterMs = 5 * 60 * 1000): number {
  const { db } = getDb();
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const res = db
    .update(screeningJobs)
    .set({ status: "pending", workerId: null, dispatchedAt: null })
    .where(
      and(
        eq(screeningJobs.status, "dispatched"),
        sql`${screeningJobs.dispatchedAt} < ${cutoff}`,
      ),
    )
    .run();
  return res.changes;
}

export interface IngestResult {
  cdmIds: string[];
  eventIds: string[];
}

/**
 * Persist the result of one screening job.
 *
 * Applies the vendor's documented `is_active` rules (`SPEC-BEHAVIOR.md` §4.6):
 * a new CDM supersedes older CDMs for the same event *and the same pair of
 * state sources*, and the event's timing metadata is refreshed.
 */
export function ingestScreeningResult(params: {
  jobId: string;
  approaches: CloseApproachMsg[];
  /** Both trajectories involved, in the order primary/secondary. */
  primaryTrajectoryId: string;
  secondaryTrajectoryId: string;
}): IngestResult {
  const { db, sqlite } = getDb();

  return sqlite.transaction(() => {
    const cdmIds: string[] = [];
    const eventIds: string[] = [];

    const t1 = db
      .select()
      .from(trajectories)
      .where(eq(trajectories.id, params.primaryTrajectoryId))
      .get();
    const t2 = db
      .select()
      .from(trajectories)
      .where(eq(trajectories.id, params.secondaryTrajectoryId))
      .get();

    if (!t1 || !t2) {
      db.update(screeningJobs)
        .set({
          status: "failed",
          lastError: "trajectory row missing",
          completedAt: new Date().toISOString(),
        })
        .where(eq(screeningJobs.id, params.jobId))
        .run();
      return { cdmIds, eventIds };
    }

    const o1 = db.select().from(objects).where(eq(objects.id, t1.objectId)).get();
    const o2 = db.select().from(objects).where(eq(objects.id, t2.objectId)).get();
    const op1 = o1
      ? db.select().from(operators).where(eq(operators.id, o1.operatorId)).get()
      : undefined;
    const op2 = o2
      ? db.select().from(operators).where(eq(operators.id, o2.operatorId)).get()
      : undefined;

    if (!o1 || !o2) {
      db.update(screeningJobs)
        .set({
          status: "failed",
          lastError: "object row missing",
          completedAt: new Date().toISOString(),
        })
        .where(eq(screeningJobs.id, params.jobId))
        .run();
      return { cdmIds, eventIds };
    }

    const now = new Date().toISOString();
    const hypothetical =
      t1.uploadType === "hypothetical" || t2.uploadType === "hypothetical";

    for (const approach of params.approaches) {
      const cdmId = randomUUID();
      const tcaMs = Number(approach.tcaEpochMs);
      const tcaGps = String(dateToGpsNanos(new Date(tcaMs)));

      // --- event grouping: 20 minutes around the TCA, same object pair.
      const eventId = hypothetical
        ? null
        : findOrCreateEvent({
            tcaGps,
            tcaMs,
            near: EVENT_GROUPING_WINDOW_MS,
            o1: {
              id: o1.id,
              name: o1.objectName,
              maneuverable: o1.maneuverability,
              operatorId: o1.operatorId,
              operatorName: op1?.name ?? "UNKNOWN",
            },
            o2: {
              id: o2.id,
              name: o2.objectName,
              maneuverable: o2.maneuverability,
              operatorId: o2.operatorId,
              operatorName: op2?.name ?? "UNKNOWN",
            },
            now,
          });

      const cdmJson = buildCdmJson({
        id: cdmId,
        createdAt: now,
        originator: "SPACESAFETY",
        approach,
        parties: {
          object1Id: o1.id,
          object1Name: o1.objectName,
          object1Maneuverable: o1.maneuverability,
          object1HardBodyRadiusKm: o1.hardBodyRadius / 1000,
          operator1Id: o1.operatorId,
          operator1Name: op1?.name ?? "UNKNOWN",
          object2Id: o2.id,
          object2Name: o2.objectName,
          object2Maneuverable: o2.maneuverability,
          object2HardBodyRadiusKm: o2.hardBodyRadius / 1000,
          operator2Id: o2.operatorId,
          operator2Name: op2?.name ?? "UNKNOWN",
        },
        trajectories: {
          trajectory1Id: t1.id,
          trajectory1Source: t1.stateSource,
          trajectory1CreatedAt: t1.createdAt,
          trajectory2Id: t2.id,
          trajectory2Source: t2.stateSource,
          trajectory2CreatedAt: t2.createdAt,
        },
      });

      // Supersede older predictions for the same event + state-source pair.
      if (eventId) {
        db.update(cdmsTable)
          .set({ isActive: false })
          .where(
            and(
              eq(cdmsTable.eventId, eventId),
              eq(cdmsTable.trajectory1Source, t1.stateSource),
              eq(cdmsTable.trajectory2Source, t2.stateSource),
            ),
          )
          .run();
      }

      const seq = nextSeq(sqlite, "cdms");
      db.insert(cdmsTable)
        .values({
          id: cdmId,
          eventId,
          createdAt: now,
          isActive: true,
          trajectory1Id: t1.id,
          trajectory1Source: t1.stateSource,
          trajectory1CreatedAt: t1.createdAt,
          object1Id: o1.id,
          object1Name: o1.objectName,
          object1Maneuverable: o1.maneuverability,
          operator1Id: o1.operatorId,
          operator1Name: op1?.name ?? "UNKNOWN",
          trajectory2Id: t2.id,
          trajectory2Source: t2.stateSource,
          trajectory2CreatedAt: t2.createdAt,
          object2Id: o2.id,
          object2Name: o2.objectName,
          object2Maneuverable: o2.maneuverability,
          operator2Id: o2.operatorId,
          operator2Name: op2?.name ?? "UNKNOWN",
          probabilityOfCollision: approach.probabilityOfCollision ?? null,
          tcaGpsNanos: tcaGps,
          missDistanceKm: approach.missDistanceKm,
          totalMissDistanceKm: approach.totalMissDistanceKm,
          relativeSpeedKmS: approach.relativeSpeedKmS,
          rtnR: approach.rtnR,
          rtnT: approach.rtnT,
          rtnN: approach.rtnN,
          covXx: approach.covXx,
          covXy: approach.covXy,
          covYy: approach.covYy,
          fileJson: stringifyCdm(cdmJson),
          isHypothetical: hypothetical,
          seq,
        })
        .run();

      cdmIds.push(cdmId);
      if (eventId) eventIds.push(eventId);
    }

    // The screened trajectory may still be `superseded` by a newer upload; the
    // caller decides. Mark it screened unless it already failed.
    for (const id of [t1.id, t2.id]) {
      db.update(trajectories)
        .set({ screenedStatus: "screened", screenedAt: now })
        .where(
          and(
            eq(trajectories.id, id),
            eq(trajectories.screenedStatus, "not_screened"),
          ),
        )
        .run();
    }

    db.update(screeningJobs)
      .set({ status: "completed", completedAt: now, lastError: null })
      .where(eq(screeningJobs.id, params.jobId))
      .run();

    return { cdmIds, eventIds };
  })();
}

function findOrCreateEvent(params: {
  tcaGps: string;
  tcaMs: number;
  near: number;
  o1: { id: string; name: string; maneuverable: boolean; operatorId: string; operatorName: string };
  o2: { id: string; name: string; maneuverable: boolean; operatorId: string; operatorName: string };
  now: string;
}): string {
  const { db } = getDb();
  const { o1, o2, tcaMs, near, now } = params;

  // Look for an existing event on the same pair whose TCA is within the window.
  const candidates = db
    .select()
    .from(eventsTable)
    .where(
      or(
        and(eq(eventsTable.object1Id, o1.id), eq(eventsTable.object2Id, o2.id)),
        and(eq(eventsTable.object1Id, o2.id), eq(eventsTable.object2Id, o1.id)),
      ),
    )
    .all();

  for (const ev of candidates) {
    if (!ev.firstCdmTcaGpsNanos) continue;
    let evTcaMs: number;
    try {
      evTcaMs = gpsNanosToDate(ev.firstCdmTcaGpsNanos).getTime();
    } catch {
      continue;
    }
    if (Math.abs(evTcaMs - tcaMs) <= near) {
      db.update(eventsTable)
        .set({ updatedTime: now })
        .where(eq(eventsTable.id, ev.id))
        .run();
      return ev.id;
    }
  }

  const id = randomUUID();
  db.insert(eventsTable)
    .values({
      id,
      object1Id: o1.id,
      object1Name: o1.name,
      object1Maneuverable: o1.maneuverable,
      operator1Id: o1.operatorId,
      operator1Name: o1.operatorName,
      object2Id: o2.id,
      object2Name: o2.name,
      object2Maneuverable: o2.maneuverable,
      operator2Id: o2.operatorId,
      operator2Name: o2.operatorName,
      claimStatusOperator1: "none",
      claimStatusOperator2: "none",
      firstCdmTcaGpsNanos: params.tcaGps,
      creationTime: now,
      updatedTime: now,
    })
    .run();
  return id;
}

/**
 * Promote `candidate` trajectories whose CDMs all fall below the relinquish
 * threshold, per the documented upload semantics.
 */
export function promoteCandidates(): number {
  const { db } = getDb();
  const candidates = db
    .select()
    .from(trajectories)
    .where(eq(trajectories.uploadType, "candidate"))
    .all();

  let promoted = 0;
  for (const t of candidates) {
    if (t.autoRelinquishPcThreshold === null) continue;

    const rows = db
      .select({ pc: cdmsTable.probabilityOfCollision })
      .from(cdmsTable)
      .where(eq(cdmsTable.trajectory1Id, t.id))
      .all();

    const worst = rows.reduce(
      (m, r) => Math.max(m, r.pc ?? 0),
      0,
    );
    if (worst <= t.autoRelinquishPcThreshold) {
      db.update(trajectories)
        .set({ uploadType: "definitive", screenedStatus: "candidate_to_definitive" })
        .where(eq(trajectories.id, t.id))
        .run();
      db.insert(catalog)
        .values({
          objectId: t.objectId,
          stateSource: t.stateSource,
          trajectoryId: t.id,
          updatedAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: [catalog.objectId, catalog.stateSource],
          set: { trajectoryId: t.id, updatedAt: new Date().toISOString() },
        })
        .run();
      promoted += 1;
    }
  }
  return promoted;
}

/**
 * Every value the vendor documents for `screened_status`.
 *
 * `docs/starlink-space-safety/api__get-all-trajectories.md` lists six:
 *
 *   screened · not_screened · candidate_to_definitive ·
 *   unknown_trajectory_fetching_error · superseded · failed_interpolation
 *
 * The last two were missing here, which meant a trajectory the compute node
 * could not fetch, or could not sample, sat at `not_screened` forever and looked
 * like a queue that had simply not run yet. They are terminal and are set from
 * the failure classification in `src/lib/grpc/server.ts`.
 */
export const SCREENED_STATUSES = [
  "not_screened",
  "screened",
  "superseded",
  "candidate_to_definitive",
  "unknown_trajectory_fetching_error",
  "failed_interpolation",
] as const;

export type ScreenedStatus = (typeof SCREENED_STATUSES)[number];

/**
 * Translate a compute-node failure into the documented trajectory status.
 *
 * The worker reports a free-text error, so classification is by intent rather
 * than by an error code: a trajectory it never received is a *fetching* error,
 * and one it received but could not sample is an *interpolation* failure.
 * Anything else stays `null` — an unrecognised failure must not invent a status
 * that claims to know what went wrong.
 */
export function statusForFailure(error: string | undefined | null): ScreenedStatus | null {
  const text = (error ?? "").toLowerCase();
  if (!text) return null;
  if (/not available|fetch|download|missing file|no such trajectory/.test(text)) {
    return "unknown_trajectory_fetching_error";
  }
  if (/interpolat|sample point|sampling|outside .*span|state at /.test(text)) {
    return "failed_interpolation";
  }
  return null;
}

/**
 * Record a terminal screening outcome on a trajectory.
 *
 * Only `not_screened` trajectories move: a trajectory that already produced its
 * result must not be relabelled by a later job that happened to involve it.
 */
export function markTrajectoryStatus(
  trajectoryId: string,
  status: ScreenedStatus,
  at = new Date().toISOString(),
): boolean {
  const { db } = getDb();
  const res = db
    .update(trajectories)
    .set({ screenedStatus: status, screenedAt: at })
    .where(
      and(eq(trajectories.id, trajectoryId), eq(trajectories.screenedStatus, "not_screened")),
    )
    .run();
  return res.changes > 0;
}

export { closeDb };
