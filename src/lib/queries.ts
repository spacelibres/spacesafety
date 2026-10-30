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

/**
 * Collapse `space_track_cdm_public` from **messages** to **conjunctions**.
 *
 * ## Why the table cannot be read row-per-row
 *
 * 3 164 messages describe **509** conjunctions. The screening centre re-issues a
 * CDM for the same pair whenever its estimate moves, so one conjunction arrives
 * as a series. Measured on pair 16910 / 42643 (14 messages, one conjunction):
 *
 *   | created (UTC)      | TCA             | Pc        | miss |
 *   |--------------------|-----------------|-----------|------|
 *   | 2026-10-28 06:15   | 22:49:39.105    | 0.0004271 | 218 km |
 *   | 2026-10-28 12:46   | 22:49:39.104    | 0.0004271 | 218 km |
 *   | 2026-10-29 12:46   | 22:49:39.098    | 0.0026593 |  92 km |
 *   | 2026-10-30 00:23   | 22:49:39.096    | 0.0032998 |  71 km |
 *   | 2026-10-30 05:37   | 22:49:39.096    | 0.0032998 |  71 km |
 *
 * Two things in that table matter:
 *
 *   1. **TCA is not a stable key.** The same conjunction's TCA jitters by
 *      milliseconds between issues (`.094` → `.096` → `.105`). Grouping on the
 *      exact value split this one conjunction into five rows.
 *   2. **Pc moves by an order of magnitude.** Listing every message and sorting by
 *      Pc would put the *historical worst* estimate at the top and present it as
 *      the current risk. Only the newest message per conjunction is true now.
 *
 * So messages are clustered by object pair and by TCA **proximity**: rows of the
 * same pair whose TCA is within 60 s of the previous one join the same cluster
 * (a gaps-and-islands scan). The 60 s threshold is 7× the largest span actually
 * observed inside a cluster (8.5 s; the mean is 0.08 s), and two approaches of
 * one pair cannot fall inside a minute of each other.
 *
 * The pair is order-insensitive (\`MIN\`/\`MAX\` of the two NORAD ids): the same
 * conjunction also arrives with \`object1\`/\`object2\` swapped a few minutes later.
 */
const CDM_AS_CONJUNCTIONS = `
  WITH base AS (
    SELECT cdm_id, created, tca, min_range_km, pc,
           sat1_norad, sat1_name, sat1_object_type,
           sat2_norad, sat2_name, sat2_object_type,
           MIN(sat1_norad, sat2_norad) AS lo,
           MAX(sat1_norad, sat2_norad) AS hi,
           julianday(tca) AS jd
      FROM space_track_cdm_public
  ),
  starts AS (
    SELECT *,
           CASE
             WHEN LAG(jd) OVER (PARTITION BY lo, hi ORDER BY jd) IS NULL THEN 1
             WHEN jd - LAG(jd) OVER (PARTITION BY lo, hi ORDER BY jd) > 60.0 / 86400.0 THEN 1
             ELSE 0
           END AS is_start
      FROM base
  ),
  clustered AS (
    SELECT *,
           SUM(is_start) OVER (
             PARTITION BY lo, hi ORDER BY jd, cdm_id ROWS UNBOUNDED PRECEDING
           ) AS cluster
      FROM starts
  ),
  ranked AS (
    SELECT *,
           COUNT(*) OVER (PARTITION BY lo, hi, cluster) AS message_count,
           ROW_NUMBER() OVER (
             PARTITION BY lo, hi, cluster ORDER BY created DESC, cdm_id DESC
           ) AS rn
      FROM clustered
  )
`;

/**
 * One conjunction, described by its **newest** CDM message.
 *
 * Distinct from `ConjunctionRow` on purpose, and the two must not be merged into
 * one grid without a source column — they are different claims:
 *
 *   - `ConjunctionRow` is *our* screening output: it exists only when an operator
 *     uploaded an ephemeris, and it carries our covariance-derived Pc, our miss
 *     distance and the operator claim state.
 *   - A public CDM is the screening centre's message about two **catalogue**
 *     objects, computed from public elements. It has no covariance, no manoeuvre
 *     plan and no operator claim.
 *
 * This deployment has no uploaded ephemerides, so the second kind is the only
 * conjunction data that exists.
 *
 * `pc` is kept `null` where upstream omits it (~270 messages), never coerced to
 * 0 — a missing probability is not a zero probability, and 0 would sort a
 * possibly real threat below every measured one.
 */
export interface PublishedConjunctionRow {
  cdmId: string;
  /** When the newest message was published. */
  createdIso: string | null;
  tcaIso: string | null;
  /** True while the TCA has not yet passed, i.e. still a live warning. */
  tcaInFuture: boolean;
  minRangeKm: number | null;
  pc: number | null;
  band: RiskBand;
  /** How many CDM messages this conjunction received. */
  messageCount: number;
  object1Norad: number;
  object1Name: string;
  object1Type: string | null;
  object2Norad: number;
  object2Name: string;
  object2Type: string | null;
}

/**
 * Conjunctions the screening centre has published: live warnings first, then by
 * probability.
 *
 * The table is created by `PublicCdmLoader` with raw SQL rather than through
 * drizzle (it is loaded from an archive file, not written by the app), so this
 * reads it with raw SQL too.
 */
export function listPublishedConjunctions(
  limit = 200,
  now: Date = new Date(),
): PublishedConjunctionRow[] {
  const { sqlite } = getDb();
  const nowIso = now.toISOString();
  const rows = sqlite
    .prepare(
      `${CDM_AS_CONJUNCTIONS}
       SELECT cdm_id            AS cdmId,
              created           AS createdIso,
              tca               AS tcaIso,
              min_range_km      AS minRangeKm,
              pc                AS pc,
              sat1_norad        AS object1Norad,
              sat1_name         AS object1Name,
              sat1_object_type  AS object1Type,
              sat2_norad        AS object2Norad,
              sat2_name         AS object2Name,
              sat2_object_type  AS object2Type,
              message_count     AS messageCount
         FROM ranked
        WHERE rn = 1
        ORDER BY (tca >= @now) DESC,
                 pc DESC NULLS LAST,
                 tca ASC
        LIMIT @limit`,
    )
    .all({ now: nowIso, limit }) as Array<Omit<PublishedConjunctionRow, "tcaInFuture" | "band">>;

  return rows.map((r) => ({
    ...r,
    tcaInFuture: r.tcaIso !== null && r.tcaIso >= nowIso,
    band: riskBand(r.pc),
  }));
}

/**
 * Header totals.
 *
 * `messages` and `conjunctions` are both reported on purpose: the difference is
 * the revision count, and quoting only the message count would overstate how much
 * is going on by 6× (3 164 messages, 509 conjunctions).
 */
export function publishedConjunctionCounts(now: Date = new Date()): {
  messages: number;
  conjunctions: number;
  upcoming: number;
  withProbability: number;
} {
  const { sqlite } = getDb();
  const row = sqlite
    .prepare(
      `${CDM_AS_CONJUNCTIONS}
       SELECT (SELECT COUNT(*) FROM space_track_cdm_public) AS messages,
              SUM(CASE WHEN rn = 1 THEN 1 ELSE 0 END) AS conjunctions,
              SUM(CASE WHEN rn = 1 AND tca >= @now THEN 1 ELSE 0 END) AS upcoming,
              SUM(CASE WHEN rn = 1 AND pc IS NOT NULL THEN 1 ELSE 0 END) AS withProbability
         FROM ranked`,
    )
    .get({ now: now.toISOString() }) as {
    messages: number;
    conjunctions: number | null;
    upcoming: number | null;
    withProbability: number | null;
  };
  return {
    messages: row.messages,
    conjunctions: row.conjunctions ?? 0,
    upcoming: row.upcoming ?? 0,
    withProbability: row.withProbability ?? 0,
  };
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
  /** Catalogue fields from `master_object`; null when the object is not merged. */
  cosparId: string | null;
  objectClass: string | null;
  country: string | null;
  massKg: number | null;
  crossSectionM2: number | null;
  manufacturer: string | null;
}

/**
 * The object list, with the merged catalogue fields.
 *
 * `objects` holds what an operator uploaded; `master_object` holds what the three
 * catalogues agree on. They join on NORAD — an object with no NORAD (a manually
 * added test body) simply has no catalogue row, which is why every field is
 * nullable rather than defaulted.
 */
/**
 * How many objects the deployment knows about.
 *
 * The list pages cap their result set (200 objects, 1000 trajectories), so the
 * header could only ever say "showing 200" — which reads like a total. The
 * vendor's UI shows "Showing 50 of >10000 objects", so the count is fetched
 * separately and the header reports both.
 */
export function countObjects(): number {
  const { sqlite } = getDb();
  const row = sqlite.prepare("SELECT COUNT(*) AS n FROM objects").get() as { n: number };
  return row.n;
}

export function listObjects(limit = 200): ObjectRow[] {
  const { sqlite } = getDb();
  const rows = sqlite
    .prepare(
      `SELECT o.id, o.operator_id AS operatorId, COALESCE(op.name, 'UNKNOWN') AS operatorName,
              o.object_name AS objectName, o.norad_id AS noradId,
              o.hard_body_radius AS hardBodyRadius, o.maneuverability, o.alive,
              m.cospar_id AS cosparId, m.object_class AS objectClass, m.country,
              m.mass_kg AS massKg, m.cross_section_avg_m2 AS crossSectionM2,
              m.manufacturer
         FROM objects o
         LEFT JOIN operators op ON op.id = o.operator_id
         LEFT JOIN master_object m ON m.norad_id = o.norad_id
        ORDER BY o.object_name
        LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    operatorId: String(r.operatorId),
    operatorName: String(r.operatorName),
    objectName: String(r.objectName),
    noradId: r.noradId === null ? null : Number(r.noradId),
    hardBodyRadius: Number(r.hardBodyRadius),
    maneuverability: Boolean(r.maneuverability),
    alive: Boolean(r.alive),
    cosparId: (r.cosparId as string | null) ?? null,
    objectClass: (r.objectClass as string | null) ?? null,
    country: (r.country as string | null) ?? null,
    massKg: r.massKg === null ? null : Number(r.massKg),
    crossSectionM2: r.crossSectionM2 === null ? null : Number(r.crossSectionM2),
    manufacturer: (r.manufacturer as string | null) ?? null,
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
