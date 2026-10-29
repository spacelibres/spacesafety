import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Persistence for the Space Safety replica.
 *
 * Shapes mirror the vendor's data model (`docs/SPEC-BEHAVIOR.md` §2) with two
 * deliberate additions that are invisible to API clients:
 *
 *   - `screened_status` history is kept, not overwritten, so the trajectory page
 *     can show why a given upload never produced a CDM.
 *   - every stream endpoint carries a monotonic `seq` so we can implement the
 *     vendor's opaque pagination tokens without relying on timestamps (two CDMs
 *     can share a creation millisecond).
 */

/** Monotonic counter used to build opaque pagination tokens. */
export const streamSeq = sqliteTable("stream_seq", {
  name: text("name").primaryKey(),
  value: integer("value").notNull().default(0),
});

export const operators = sqliteTable("operators", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  maxObjects: integer("max_objects").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** mTLS client certificates signed by our CA. */
export const credentials = sqliteTable(
  "credentials",
  {
    id: text("id").primaryKey(),
    operatorId: text("operator_id").notNull(),
    /** Certificate common name; unique per environment credential. */
    commonName: text("common_name").notNull(),
    /** SHA-256 of the DER certificate, for fast lookup at request time. */
    fingerprint: text("fingerprint").notNull(),
    /** PEM body, for revocation checks and display. */
    pem: text("pem").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at"),
  },
  (t) => [
    index("credentials_fingerprint_idx").on(t.fingerprint),
    index("credentials_operator_idx").on(t.operatorId),
  ],
);

export const objects = sqliteTable(
  "objects",
  {
    id: text("id").primaryKey(),
    operatorId: text("operator_id").notNull(),
    objectName: text("object_name").notNull(),
    noradId: integer("norad_id"),
    /** Metres; API caps at 512. */
    hardBodyRadius: real("hard_body_radius").notNull(),
    maneuverability: integer("maneuverability", { mode: "boolean" }).notNull(),
    alive: integer("alive", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("objects_operator_idx").on(t.operatorId),
    index("objects_norad_idx").on(t.noradId),
    index("objects_name_idx").on(t.objectName),
  ],
);

export const trajectories = sqliteTable(
  "trajectories",
  {
    id: text("id").primaryKey(),
    objectId: text("object_id").notNull(),
    operatorId: text("operator_id").notNull(),
    uploadType: text("upload_type").notNull(),
    stateSource: text("state_source").notNull(),
    screenedStatus: text("screened_status").notNull().default("not_screened"),
    // `fileText` used to live here. It now lives in `trajectoryFiles`, because a
    // row that carries the ephemeris text is a row every metadata query has to
    // drag through the page cache: 674 MB across 400 rows, which made the list
    // page read the whole table to show ten columns. Reads that need the text go
    // through `getTrajectoryFile` (one primary-key lookup).
    fileFormat: text("file_format").notNull(),
    /** Coverage window, ISO-8601. */
    startAt: text("start_at"),
    endAt: text("end_at"),
    pointCount: integer("point_count").notNull().default(0),
    screenedAt: text("screened_at"),
    uploadedAt: text("uploaded_at").notNull(),
    createdAt: text("created_at").notNull(),
    /** Only meaningful for `candidate` uploads. */
    autoRelinquishPcThreshold: real("auto_relinquish_pc_threshold"),
    /**
     * True when every state carries a 6x6 covariance.
     *
     * Denormalised because it decides whether a CDM can report a Pc at all, and
     * that question is asked on every screening job. Deriving it would mean
     * parsing the stored file each time.
     */
    hasCovariance: integer("has_covariance", { mode: "boolean" }).notNull().default(false),
    /**
     * Id of the companion trajectory holding the same orbit in the other vendor
     * format.
     *
     * Starlink publishes an OCM (with the catalogue number, 7-day span, no
     * covariance) and a Modified ITC (with covariance, 3 days, no catalogue
     * number). Neither is sufficient alone: screening needs the covariance for a
     * Pc, and identity needs the OCM. Linking them lets a screening job pick the
     * states from one and the covariance from the other without guessing.
     *
     * Null when there is no companion, which is the normal case for every
     * non-Starlink object.
     */
    companionId: text("companion_id"),
    /** Bumped on every insert, so streams can page deterministically. */
    seq: integer("seq").notNull(),
  },
  (t) => [
    index("trajectories_object_idx").on(t.objectId),
    index("trajectories_operator_idx").on(t.operatorId),
    index("trajectories_status_idx").on(t.screenedStatus),
    index("trajectories_seq_idx").on(t.seq),
    index("trajectories_companion_idx").on(t.companionId),
  ],
);

/**
 * Raw ephemeris text, one row per trajectory.
 *
 * Split from `trajectories` because SQLite stores rows in a B-tree keyed by the
 * rowid: a wide `file_text` column makes every row ~2 MB on average, so a list
 * query that needs only metadata still pages through the whole table. Keeping
 * text here means `trajectories` rows stay small and metadata queries are
 * index-only, while the one place that needs the file (rendering, gRPC dispatch)
 * does a single primary-key lookup.
 *
 * `trajectory_id` is both the primary key and the foreign key: one file per
 * trajectory, and the 1:1 shape stops a second row from appearing by accident.
 */
export const trajectoryFiles = sqliteTable("trajectory_files", {
  trajectoryId: text("trajectory_id").primaryKey(),
  /** Raw file text exactly as uploaded (OEM/OCM/ITC/JSpOC/UTC/NASA). */
  fileText: text("file_text").notNull(),
});

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    object1Id: text("object1_id").notNull(),
    object1Name: text("object1_name").notNull(),
    object1Maneuverable: integer("object1_maneuverable", { mode: "boolean" }).notNull(),
    operator1Id: text("operator1_id").notNull(),
    operator1Name: text("operator1_name").notNull(),

    object2Id: text("object2_id").notNull(),
    object2Name: text("object2_name").notNull(),
    object2Maneuverable: integer("object2_maneuverable", { mode: "boolean" }).notNull(),
    operator2Id: text("operator2_id").notNull(),
    operator2Name: text("operator2_name").notNull(),

    claimStatusOperator1: text("claim_status_operator1").notNull().default("none"),
    claimStatusOperator2: text("claim_status_operator2").notNull().default("none"),
    lastStatusUpdateOperator1: text("last_status_update_operator1"),
    lastStatusUpdateOperator2: text("last_status_update_operator2"),

    /** GPS nanos as TEXT: int64 does not survive a JS number. */
    firstCdmTcaGpsNanos: text("first_cdm_tca_gps_nanos"),
    creationTime: text("creation_time").notNull(),
    updatedTime: text("updated_time").notNull(),
  },
  (t) => [
    index("events_obj1_idx").on(t.object1Id),
    index("events_obj2_idx").on(t.object2Id),
    index("events_op1_idx").on(t.operator1Id),
    index("events_op2_idx").on(t.operator2Id),
  ],
);

export const cdms = sqliteTable(
  "cdms",
  {
    id: text("id").primaryKey(),
    /** NULL when the CDM has no event (hypothetical uploads never create one). */
    eventId: text("event_id"),
    createdAt: text("created_at").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),

    trajectory1Id: text("trajectory1_id").notNull(),
    trajectory1Source: text("trajectory1_source").notNull(),
    trajectory1CreatedAt: text("trajectory1_created_at"),
    object1Id: text("object1_id").notNull(),
    object1Name: text("object1_name").notNull(),
    object1Maneuverable: integer("object1_maneuverable", { mode: "boolean" }),
    operator1Id: text("operator1_id").notNull(),
    operator1Name: text("operator1_name").notNull(),

    trajectory2Id: text("trajectory2_id").notNull(),
    trajectory2Source: text("trajectory2_source").notNull(),
    trajectory2CreatedAt: text("trajectory2_created_at"),
    object2Id: text("object2_id").notNull(),
    object2Name: text("object2_name").notNull(),
    object2Maneuverable: integer("object2_maneuverable", { mode: "boolean" }),
    operator2Id: text("operator2_id").notNull(),
    operator2Name: text("operator2_name").notNull(),

    /** NULL when either side lacked covariance (documented CDM behaviour). */
    probabilityOfCollision: real("probability_of_collision"),
    /** GPS nanos since 1980-06-01, stored as TEXT. */
    tcaGpsNanos: text("tca_gps_nanos").notNull(),

    /** Encounter-plane geometry, needed to render the CDM and its KVN. */
    missDistanceKm: real("miss_distance_km"),
    totalMissDistanceKm: real("total_miss_distance_km"),
    relativeSpeedKmS: real("relative_speed_km_s"),
    rtnR: real("rtn_r"),
    rtnT: real("rtn_t"),
    rtnN: real("rtn_n"),
    covXx: real("cov_xx"),
    covXy: real("cov_xy"),
    covYy: real("cov_yy"),

    /** The full serialized CDM (JSON), rendered on demand in KVN. */
    fileJson: text("file_json").notNull(),
    /** True for CDMs produced by hypothetical trajectories (never streamed). */
    isHypothetical: integer("is_hypothetical", { mode: "boolean" })
      .notNull()
      .default(false),
    seq: integer("seq").notNull(),
  },
  (t) => [
    index("cdms_event_idx").on(t.eventId),
    index("cdms_traj1_idx").on(t.trajectory1Id),
    index("cdms_traj2_idx").on(t.trajectory2Id),
    index("cdms_obj1_idx").on(t.object1Id),
    index("cdms_obj2_idx").on(t.object2Id),
    index("cdms_op1_idx").on(t.operator1Id),
    index("cdms_op2_idx").on(t.operator2Id),
    index("cdms_tca_idx").on(t.tcaGpsNanos),
    index("cdms_seq_idx").on(t.seq),
  ],
);

/**
 * Catalog of the newest definitive trajectory per (object, state source).
 * Screening compares against this, per the vendor's architecture note.
 */
export const catalog = sqliteTable(
  "catalog",
  {
    objectId: text("object_id").notNull(),
    stateSource: text("state_source").notNull(),
    trajectoryId: text("trajectory_id").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("catalog_pk_idx").on(t.objectId, t.stateSource)],
);

/** Screening queue: rows move through pending -> dispatched -> done. */
export const screeningJobs = sqliteTable(
  "screening_jobs",
  {
    id: text("id").primaryKey(),
    trajectoryId: text("trajectory_id").notNull(),
    /** Candidate partner trajectory (the catalog entry being compared). */
    againstTrajectoryId: text("against_trajectory_id"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    workerId: text("worker_id"),
    dispatchedAt: text("dispatched_at"),
    completedAt: text("completed_at"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    seq: integer("seq").notNull(),
  },
  (t) => [
    index("jobs_status_idx").on(t.status),
    index("jobs_traj_idx").on(t.trajectoryId),
  ],
);

/** Opaque pagination tokens, so a token cannot be forged or reused across streams. */
export const paginationTokens = sqliteTable(
  "pagination_tokens",
  {
    token: text("token").primaryKey(),
    stream: text("stream").notNull(),
    /** Last consumed seq. */
    cursor: integer("cursor").notNull(),
    /** Filters the token was minted with, serialized. */
    filterHash: text("filter_hash").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (t) => [index("tokens_stream_idx").on(t.stream)],
);

export type OperatorRow = typeof operators.$inferSelect;
export type ObjectRow = typeof objects.$inferSelect;
export type TrajectoryRow = typeof trajectories.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type CdmRow = typeof cdms.$inferSelect;
export type ScreeningJobRow = typeof screeningJobs.$inferSelect;

export const nowIso = () => new Date().toISOString();
export const sqlNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
