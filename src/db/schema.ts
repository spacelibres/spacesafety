import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

/**
 * Full space object catalogue, as published by COMSPOC's Spacebook SATCAT.
 *
 * Kept apart from `objects` on purpose. `objects` holds the small set we track an
 * ephemeris for (11 000 Starlink plus whatever an operator uploads); SATCAT holds
 * the complete historical catalogue (72 000 entries, most long decayed) and is
 * used for three things only:
 *
 *   - turning a NORAD number into a name. XP-TLE carries no name line, so
 *     `noradId -> name` is the only way an object from that feed gets a label.
 *   - object type / RCS class / owner, which drive the hard-body radius used by
 *     the collision model.
 *   - launch and decay dates, so a stale element set can be explained rather
 *     than looking like a propagation bug.
 *
 * Not foreign-keyed to `objects`: a new launch appears in XP-TLE before the
 * SATCAT refresh catches up, and a rejected FK would drop the orbit.
 */
export const satcat = sqliteTable(
  "satcat",
  {
    noradId: integer("norad_id").primaryKey(),
    /** COMSPOC internal id (UUID). */
    entityId: text("entity_id"),
    /** International designator, e.g. `1998-067A`. */
    intlId: text("intl_id"),
    name: text("name").notNull(),
    objectType: text("object_type"),
    owner: text("owner"),
    launchSite: text("launch_site"),
    /** ISO-8601 date, or null when unlaunched/unknown. */
    launchDate: text("launch_date"),
    /** Non-null once the object has re-entered. */
    decayDate: text("decay_date"),
    period: real("period"),
    inclination: real("inclination"),
    apogee: real("apogee"),
    perigee: real("perigee"),
    rcsSize: text("rcs_size"),
    /**
     * Lifecycle state from the supplemental feed: `Active`, `Dead`, `Debris`,
     * `RocketBody`, `Unknown`.
     *
     * Distinct from `objectType`, which is the launch classification. `Dead`
     * means the object no longer manoeuvres, which is a *ranging* fact the
     * screening policy needs and the launch class does not imply.
     */
    status: text("status"),
    /** Operational status code from the provider, `+`/`-`/`D`/... */
    opsStatusCode: text("ops_status_code"),
    /**
     * Start of the published covariance arc, ISO-8601. Null when none is offered.
     *
     * This column is what decides whether a screening can produce a Pc: with no
     * covariance there is no probability, only a miss distance. Storing it on the
     * catalogue row lets the screening queue skip objects that cannot possibly
     * yield one, instead of attempting and failing 40 000 times.
     */
    covarianceStart: text("covariance_start"),
    covarianceStop: text("covariance_stop"),
    /** Start of the provider's reference ephemeris window, ISO-8601. */
    referenceEphemerisStart: text("reference_ephemeris_start"),
    referenceEphemerisStop: text("reference_ephemeris_stop"),
    /** Which snapshot this row came from; lets a partial refresh be detected. */
    sourceSnapshot: text("source_snapshot"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("satcat_name_idx").on(t.name),
    index("satcat_type_idx").on(t.objectType),
    index("satcat_status_idx").on(t.status),
  ],
);

/**
 * Registered upstream data sources.
 *
 * The replica merges several feeds that disagree, so "which source said this"
 * has to be stored rather than inferred. Before this table, Space-Track and
 * Spacebook TLEs were both written as `state_source = 'tle'` and silently
 * overwrote each other — 20 000 rows became 29 000 with no record of which
 * provider was lost.
 *
 * `refresh_minutes` encodes the provider's own publication cadence, so the
 * scheduler can ask "is this due?" instead of polling every feed hourly. The
 * values come from observed behaviour (below), not from a promise the provider
 * makes:
 *
 *   space-track   ~2 h   GP catalogue is rebuilt a few times a day
 *   spacebook     ~2 h   OMM `CREATION_DATE` moves on the same order
 *   starlink-ocm  ~8 h   7-day arcs, refreshed about three times a day
 *   starlink-itc  ~8 h   same cadence, 3-day arcs
 */
export const dataSources = sqliteTable("data_sources", {
  id: text("id").primaryKey(),
  /** Human label for the UI. */
  label: text("label").notNull(),
  /** `custom` | `public` — whether the fetch needs credentials. */
  kind: text("kind").notNull(),
  /** `tle` | `omm` | `ocm` | `itc` | `satcat` | `spaceweather` | `eop`. */
  format: text("format").notNull(),
  /** Environment variable prefix holding the credentials, or null. */
  credentialEnv: text("credential_env"),
  /** Expected publication interval, minutes. Drives the refresh scheduler. */
  refreshMinutes: integer("refresh_minutes").notNull().default(120),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Measured quality, set by a comparison run rather than hard-coded. */
  notes: text("notes"),
  lastSuccessAt: text("last_success_at"),
  lastAttemptAt: text("last_attempt_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * One attempt to pull one source. Append-only history.
 *
 * Kept so a gap can be explained later: "the catalogue is two days old" has to
 * distinguish a provider outage from a scheduler that never ran.
 */
export const sourceFetches = sqliteTable(
  "source_fetches",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    /** `running` | `ok` | `failed` | `unchanged`. */
    status: text("status").notNull().default("running"),
    bytes: integer("bytes"),
    records: integer("records"),
    /** Where the raw body landed, relative to the data root. */
    path: text("path"),
    /** SHA-256 of the body; identical to the previous pull means `unchanged`. */
    sha256: text("sha256"),
    error: text("error"),
    seq: integer("seq").notNull(),
  },
  (t) => [
    index("source_fetches_source_idx").on(t.sourceId, t.startedAt),
    index("source_fetches_seq_idx").on(t.seq),
  ],
);

/**
 * What each source currently claims about each object.
 *
 * This is the cross-check table. One row per `(norad_id, source_id)` rather than
 * one per object: the whole point is that two providers describe the same object
 * differently, and a single-row-per-object design destroys that evidence on
 * write. The screening path still reads the *resolved* trajectory; this table is
 * what lets the UI say "these two disagree by 0.003° of inclination".
 */
export const objectSources = sqliteTable(
  "object_sources",
  {
    noradId: integer("norad_id").notNull(),
    sourceId: text("source_id").notNull(),
    /** Element-set epoch as the provider stated it, ISO-8601. */
    epoch: text("epoch"),
    inclination: real("inclination"),
    raan: real("raan"),
    eccentricity: real("eccentricity"),
    argPerigee: real("arg_perigee"),
    meanAnomaly: real("mean_anomaly"),
    meanMotion: real("mean_motion"),
    bstar: real("bstar"),
    /**
     * Position at the common comparison epoch, km (ECI).
     *
     * Filled by the comparison pass, not by ingest: it needs both sources' arcs
     * propagated to one instant, which is the only meaningful way to say "these
     * agree". Null until then.
     */
    posX: real("pos_x"),
    posY: real("pos_y"),
    posZ: real("pos_z"),
    /** |Δr| against the reference source, km. */
    deltaKm: real("delta_km"),
    fetchedAt: text("fetched_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.noradId, t.sourceId] }),
    index("object_sources_source_idx").on(t.sourceId, t.noradId),
    index("object_sources_norad_idx").on(t.noradId),
  ],
);
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
export type SatcatRow = typeof satcat.$inferSelect;
export type DataSourceRow = typeof dataSources.$inferSelect;
export type SourceFetchRow = typeof sourceFetches.$inferSelect;
export type ObjectSourceRow = typeof objectSources.$inferSelect;

export const nowIso = () => new Date().toISOString();
export const sqlNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
