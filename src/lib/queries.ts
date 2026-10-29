import "server-only";

import { and, desc, eq, gt, or, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { normaliseTrajectory } from "@/lib/api/validate-trajectory";
import {
  cdms,
  catalog,
  events,
  objects,
  operators,
  screeningJobs,
  trajectoryFiles,
  trajectories,
} from "@/db/schema";
import { gpsNanosToDate } from "@/lib/space-safety/gps";

/** Risk bands, configurable so operators can match their own action thresholds. */
export function riskThresholds() {
  const raw = process.env.SPACE_SAFETY_RISK_THRESHOLDS ?? "1e-4,1e-5";
  const [high, medium] = raw.split(",").map(Number);
  return {
    high: Number.isFinite(high) ? high : 1e-4,
    medium: Number.isFinite(medium) ? medium : 1e-5,
  };
}

export type RiskBand = "high" | "medium" | "low" | "unknown";

export function riskBand(pc: number | null | undefined): RiskBand {
  if (pc === null || pc === undefined || Number.isNaN(pc)) return "unknown";
  const t = riskThresholds();
  if (pc >= t.high) return "high";
  if (pc >= t.medium) return "medium";
  return "low";
}

export interface Overview {
  operators: number;
  objects: number;
  trajectories: number;
  cdms: number;
  events: number;
  highRisk: number;
  mediumRisk: number;
  nextTcaIso: string | null;
  pendingJobs: number;
  myObjects: number;
}

export function getOverview(): Overview {
  const { db } = getDb();
  const n = (table: Parameters<typeof db.select>[0] | never) => table;

  void n;

  const count = (expr: ReturnType<typeof sql<number>>, from: "operators" | "objects" | "trajectories" | "cdms" | "events" | "screening_jobs") => {
    const table =
      from === "operators"
        ? operators
        : from === "objects"
          ? objects
          : from === "trajectories"
            ? trajectories
            : from === "cdms"
              ? cdms
              : from === "events"
                ? events
                : screeningJobs;
    const row = db.select({ n: expr }).from(table).get();
    return row?.n ?? 0;
  };

  const t = riskThresholds();

  const highRisk = db
    .select({ n: sql<number>`count(*)` })
    .from(cdms)
    .where(and(eq(cdms.isActive, true), sql`${cdms.probabilityOfCollision} >= ${t.high}`))
    .get()?.n ?? 0;

  const mediumRisk = db
    .select({ n: sql<number>`count(*)` })
    .from(cdms)
    .where(
      and(
        eq(cdms.isActive, true),
        sql`${cdms.probabilityOfCollision} >= ${t.medium}`,
        sql`${cdms.probabilityOfCollision} < ${t.high}`,
      ),
    )
    .get()?.n ?? 0;

  const next = db
    .select({ tca: cdms.tcaGpsNanos })
    .from(cdms)
    .where(and(eq(cdms.isActive, true), sql`${cdms.tcaGpsNanos} IS NOT NULL`))
    .orderBy(cdms.tcaGpsNanos)
    .get();

  return {
    operators: count(sql<number>`count(*)`, "operators"),
    objects: count(sql<number>`count(*)`, "objects"),
    trajectories: count(sql<number>`count(*)`, "trajectories"),
    cdms: count(sql<number>`count(*)`, "cdms"),
    events: count(sql<number>`count(*)`, "events"),
    highRisk,
    mediumRisk,
    nextTcaIso: next?.tca ? safeIso(next.tca) : null,
    pendingJobs: db
      .select({ n: sql<number>`count(*)` })
      .from(screeningJobs)
      .where(eq(screeningJobs.status, "pending"))
      .get()?.n ?? 0,
    myObjects: count(sql<number>`count(*)`, "objects"),
  };
}

export interface ConjunctionRow {
  id: string;
  object1Name: string;
  object2Name: string;
  operator1Name: string;
  operator2Name: string;
  pc: number | null;
  tcaGpsNanos: string;
  tcaIso: string | null;
  isActive: boolean;
  eventId: string | null;
  band: RiskBand;
}

/**
 * Active CDMs sorted by risk, then by time to closest approach.
 *
 * One row per conjunction *event* would hide the fact that a single event can
 * carry both an operator-vs-operator and an operator-vs-optical CDM, so we list
 * CDMs and let the UI group them.
 */
export function listConjunctions(limit = 100): ConjunctionRow[] {
  const { db } = getDb();
  const rows = db
    .select()
    .from(cdms)
    .where(eq(cdms.isActive, true))
    .orderBy(desc(cdms.probabilityOfCollision), cdms.tcaGpsNanos)
    .limit(limit)
    .all();

  return rows.map((r) => ({
    id: r.id,
    object1Name: r.object1Name,
    object2Name: r.object2Name,
    operator1Name: r.operator1Name,
    operator2Name: r.operator2Name,
    pc: r.probabilityOfCollision,
    tcaGpsNanos: r.tcaGpsNanos,
    tcaIso: safeIso(r.tcaGpsNanos),
    isActive: r.isActive,
    eventId: r.eventId,
    band: riskBand(r.probabilityOfCollision),
  }));
}

export interface EventDetail {
  event: typeof events.$inferSelect | null;
  history: {
    id: string;
    createdAt: string;
    pc: number | null;
    isActive: boolean;
    source1: string;
    source2: string;
  }[];
  latest: typeof cdms.$inferSelect | null;
}

export function getEventDetail(eventId: string): EventDetail {
  const { db } = getDb();
  const event = db.select().from(events).where(eq(events.id, eventId)).get() ?? null;

  const rows = db
    .select()
    .from(cdms)
    .where(eq(cdms.eventId, eventId))
    .orderBy(cdms.createdAt)
    .all();

  return {
    event,
    history: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      pc: r.probabilityOfCollision,
      isActive: r.isActive,
      source1: r.trajectory1Source,
      source2: r.trajectory2Source,
    })),
    latest: rows.filter((r) => r.isActive).at(-1) ?? rows.at(-1) ?? null,
  };
}

export function listOperators() {
  const { db } = getDb();
  return db.select().from(operators).orderBy(operators.name).all();
}

export interface ObjectRow {
  id: string;
  operatorId: string;
  operatorName: string;
  objectName: string;
  noradId: number | null;
  hardBodyRadius: number;
  maneuverability: boolean;
  alive: boolean;
}

export function listObjects(limit = 200): ObjectRow[] {
  const { db } = getDb();
  const rows = db
    .select({ o: objects, opName: operators.name })
    .from(objects)
    .leftJoin(operators, eq(operators.id, objects.operatorId))
    .orderBy(objects.objectName)
    .limit(limit)
    .all();

  return rows.map((r) => ({
    id: r.o.id,
    operatorId: r.o.operatorId,
    operatorName: r.opName ?? "UNKNOWN",
    objectName: r.o.objectName,
    noradId: r.o.noradId,
    hardBodyRadius: r.o.hardBodyRadius,
    maneuverability: r.o.maneuverability,
    alive: r.o.alive,
  }));
}

export interface TrajectoryRow {
  id: string;
  objectId: string;
  objectName: string;
  operatorName: string;
  uploadType: string;
  stateSource: string;
  screenedStatus: string;
  uploadedAt: string;
  startAt: string | null;
  endAt: string | null;
  pointCount: number;
  format: string;
}

export function listTrajectories(limit = 200): TrajectoryRow[] {
  const { db } = getDb();
  // Select columns explicitly. `select({ t: trajectories })` pulls every column,
  // including `file_text` — the raw ephemeris, 674 MB across this table — and the
  // page only needs metadata. Reading it cost ~6 s per request.
  const rows = db
    .select({
      id: trajectories.id,
      objectId: trajectories.objectId,
      uploadType: trajectories.uploadType,
      stateSource: trajectories.stateSource,
      screenedStatus: trajectories.screenedStatus,
      uploadedAt: trajectories.uploadedAt,
      startAt: trajectories.startAt,
      endAt: trajectories.endAt,
      pointCount: trajectories.pointCount,
      format: trajectories.fileFormat,
      name: objects.objectName,
      opName: operators.name,
    })
    .from(trajectories)
    .leftJoin(objects, eq(objects.id, trajectories.objectId))
    .leftJoin(operators, eq(operators.id, trajectories.operatorId))
    .orderBy(desc(trajectories.uploadedAt))
    .limit(limit)
    .all();

  return rows.map((r) => ({
    id: r.id,
    objectId: r.objectId,
    objectName: r.name ?? r.objectId,
    operatorName: r.opName ?? "UNKNOWN",
    uploadType: r.uploadType,
    stateSource: r.stateSource,
    screenedStatus: r.screenedStatus,
    uploadedAt: r.uploadedAt,
    startAt: r.startAt,
    endAt: r.endAt,
    pointCount: r.pointCount,
    format: r.format,
  }));
}

export function getTrajectory(id: string) {
  const { db } = getDb();
  // Detail view: metadata plus the file text, which it actually renders. Kept as
  // one row rather than a second query so the read is a single index lookup.
  const row = db
    .select({ t: trajectories, name: objects.objectName, opName: operators.name })
    .from(trajectories)
    .leftJoin(objects, eq(objects.id, trajectories.objectId))
    .leftJoin(operators, eq(operators.id, trajectories.operatorId))
    .where(eq(trajectories.id, id))
    .get();
  if (!row) return null;
  return { ...row.t, objectName: row.name ?? row.t.objectId, operatorName: row.opName ?? "UNKNOWN" };
}

/** Trajectory file text, for rendering. */
export function getTrajectoryFile(id: string): { text: string; format: string } | null {
  const { db } = getDb();
  const row = db
    .select({ fileText: trajectoryFiles.fileText, format: trajectories.fileFormat })
    .from(trajectoryFiles)
    .innerJoin(trajectories, eq(trajectories.id, trajectoryFiles.trajectoryId))
    .where(eq(trajectoryFiles.trajectoryId, id))
    .get();
  return row ? { text: row.fileText, format: row.format } : null;
}

/**
 * Store a trajectory's file text.
 *
 * Every writer must call this: the text lives in its own table now, so writing
 * only the metadata row leaves the trajectory readable but empty — a failure that
 * surfaces much later, when screening finds nothing to propagate.
 */
export function writeTrajectoryFile(
  db: ReturnType<typeof getDb>["db"],
  trajectoryId: string,
  fileText: string,
): void {
  db.insert(trajectoryFiles)
    .values({ trajectoryId, fileText })
    .onConflictDoUpdate({
      target: trajectoryFiles.trajectoryId,
      set: { fileText },
    })
    .run();
}

/**
 * Parsed states of an object's most recent trajectory.
 *
 * Used by NORAD resolution, which needs the orbit — inclination and mean altitude
 * — to tell a genuine catalogue match from a reused name. Returns null when the
 * object has no trajectory or the stored file no longer parses.
 */
export function latestTrajectoryStates(objectId: string) {
  const { db } = getDb();
  const row = db
    .select({ text: trajectoryFiles.fileText })
    .from(trajectories)
    .innerJoin(trajectoryFiles, eq(trajectoryFiles.trajectoryId, trajectories.id))
    .where(eq(trajectories.objectId, objectId))
    .orderBy(desc(trajectories.uploadedAt))
    .limit(1)
    .get();
  if (!row) return null;
  try {
    return normaliseTrajectory(row.text).states;
  } catch {
    return null;
  }
}

/** Catalog size and freshest entries, shown on the home page. */
export function getCatalogSummary(limit = 10) {
  const { db } = getDb();
  return db
    .select({ c: catalog, name: objects.objectName })
    .from(catalog)
    .leftJoin(objects, eq(objects.id, catalog.objectId))
    .orderBy(desc(catalog.updatedAt))
    .limit(limit)
    .all()
    .map((r) => ({
      objectId: r.c.objectId,
      objectName: r.name ?? r.c.objectId,
      trajectoryId: r.c.trajectoryId,
      stateSource: r.c.stateSource,
      updatedAt: r.c.updatedAt,
    }));
}

export function getSystemHealth() {
  const { db } = getDb();
  const pending = db
    .select({ n: sql<number>`count(*)` })
    .from(screeningJobs)
    .where(eq(screeningJobs.status, "pending"))
    .get()?.n ?? 0;
  const failed = db
    .select({ n: sql<number>`count(*)` })
    .from(screeningJobs)
    .where(eq(screeningJobs.status, "failed"))
    .get()?.n ?? 0;
  const unscreened = db
    .select({ n: sql<number>`count(*)` })
    .from(trajectories)
    .where(eq(trajectories.screenedStatus, "not_screened"))
    .get()?.n ?? 0;

  return { pending, failed, unscreened };
}

/** CDM history for a trajectory, for the detail page. */
export function listTrajectoryCdms(trajectoryId: string) {
  const { db } = getDb();
  return db
    .select()
    .from(cdms)
    .where(
      or(eq(cdms.trajectory1Id, trajectoryId), eq(cdms.trajectory2Id, trajectoryId)),
    )
    .orderBy(desc(cdms.createdAt))
    .all();
}

/** Recent entries from one stream, used by the docs page. */
export function recentEvents(limit = 20) {
  const { db } = getDb();
  return db.select().from(events).orderBy(desc(events.updatedTime)).limit(limit).all();
}

export { gt };

function safeIso(gpsNanos: string): string | null {
  try {
    return gpsNanosToDate(gpsNanos).toISOString();
  } catch {
    return null;
  }
}
