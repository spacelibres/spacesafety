import "server-only";

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";
import { attachOrbits, defaultStorePaths } from "./store";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: AppDatabase;
  sqlite: Database.Database;
  /** True when the orbit store is attached and propagation can run. */
  orbitsAttached: boolean;
  /** Why it is not attached, when it is not. */
  orbitsReason?: string;
  /** True when the three-source wide catalogue is attached for per-source views. */
  wideAttached: boolean;
}

let instance: DbHandle | undefined;

export function databasePath(): string {
  return process.env.SPACE_SAFETY_DB ?? "./data/spacesafety.sqlite";
}

/**
 * Open the catalogue and attach the orbit store when it is available.
 *
 * Two layouts are supported, and which one is in use is decided by the
 * environment, not by a flag in code:
 *
 *   split (default)  `SPACE_SAFETY_BASE_DB` + `SPACE_SAFETY_ORBIT_DB`
 *                    the base is 102 MB, the orbit store is ~54 GB and optional
 *   single           `SPACE_SAFETY_DB`
 *                    one file, which is what a fresh checkout and the test
 *                    suite use
 *
 * The single-file layout is not deprecated: it is what makes `npm run dev` work
 * without a 54 GB download, and what the tests use so they do not depend on local
 * data.
 */
function useSplitLayout(): boolean {
  return Boolean(process.env.SPACE_SAFETY_BASE_DB || process.env.SPACE_SAFETY_DATA_DIR);
}

/**
 * Opens the database, creating the schema on first use.
 *
 * DDL lives inline (rather than in drizzle-kit migrations) so a fresh checkout
 * runs with `npm run dev` and no extra step. `schema.ts` stays the source of
 * truth for types; this file must be kept in sync and is covered by a test that
 * inserts into every table.
 */
export function getDb(): DbHandle {
  if (instance) return instance;

  const split = useSplitLayout();
  const paths = defaultStorePaths();
  const path = split ? paths.base : databasePath();
  mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");

  applySchema(sqlite);

  // Only the split layout has a separate orbit file. In the single-file layout the
  // ephemeris text lives in the same database, which is why `trajectory_files`
  // still exists in the DDL.
  let orbitsAttached = false;
  let orbitsReason: string | undefined;
  if (split) {
    const result = attachOrbits(sqlite, paths);
    orbitsAttached = result.attached;
    orbitsReason = result.reason;
    if (!orbitsAttached) {
      console.warn(`[db] ${result.reason}`);
    }
  } else {
    orbitsAttached = true;
  }

  const db = drizzle(sqlite, { schema });
  const wideAttached = attachWide(sqlite);
  instance = { db, sqlite, orbitsAttached, orbitsReason, wideAttached };
  return instance;
}

/**
 * Attach the three-source wide catalogue, when it has been built.
 *
 * The wide table is produced by `npx tsx tools/build-wide-catalogue.ts` and is a
 * separate file because it is rebuilt from the provider downloads, not written by
 * the application. Attaching it read-only keeps that separation: the web process
 * cannot corrupt a table that took a rebuild to produce.
 *
 * Absent is not an error. A checkout without the wide build still serves the
 * catalogue; the pages that need per-source comparison say so explicitly rather
 * than silently falling back to the merged value.
 */
function attachWide(sqlite: Database.Database): boolean {
  const already = sqlite
    .prepare("SELECT COUNT(*) AS n FROM pragma_database_list WHERE name = 'wide'")
    .get() as { n: number };
  if (already.n > 0) return true;

  const path = process.env.SPACE_SAFETY_WIDE_DB ?? "data/catalogue-wide.sqlite";
  if (!existsSync(path)) return false;

  sqlite.exec(`ATTACH DATABASE '${path.replace(/'/g, "''")}' AS wide`);
  return true;
}

/** Close the handle (tests / graceful shutdown). */
export function closeDb(): void {
  instance?.sqlite.close();
  instance = undefined;
}

function applySchema(sqlite: Database.Database) {
  sqlite.exec(DDL);
  migrate(sqlite);
}

/**
 * Column additions for databases created before the column existed.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so a new column in
 * `DDL` reaches a fresh checkout but never an existing database. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so each addition is guarded by a `PRAGMA table_info`
 * check. Kept as a flat list rather than a version table: the schema is small
 * enough that "does this column exist" is a cheaper question than "which migration
 * have we run", and it is idempotent by construction.
 */
function migrate(sqlite: Database.Database): void {
  const additions: Array<{ table: string; column: string; ddl: string }> = [
    {
      table: "trajectories",
      column: "has_covariance",
      ddl: "ALTER TABLE trajectories ADD COLUMN has_covariance INTEGER NOT NULL DEFAULT 0",
    },
    {
      table: "trajectories",
      column: "companion_id",
      ddl: "ALTER TABLE trajectories ADD COLUMN companion_id TEXT",
    },
    // The supplemental catalogue states each object's lifecycle status and its
    // covariance window. Without these columns the screening queue cannot tell
    // which objects can produce a Pc at all.
    { table: "satcat", column: "status", ddl: "ALTER TABLE satcat ADD COLUMN status TEXT" },
    {
      table: "satcat",
      column: "ops_status_code",
      ddl: "ALTER TABLE satcat ADD COLUMN ops_status_code TEXT",
    },
    {
      table: "satcat",
      column: "covariance_start",
      ddl: "ALTER TABLE satcat ADD COLUMN covariance_start TEXT",
    },
    {
      table: "satcat",
      column: "covariance_stop",
      ddl: "ALTER TABLE satcat ADD COLUMN covariance_stop TEXT",
    },
    {
      table: "satcat",
      column: "reference_ephemeris_start",
      ddl: "ALTER TABLE satcat ADD COLUMN reference_ephemeris_start TEXT",
    },
    {
      table: "satcat",
      column: "reference_ephemeris_stop",
      ddl: "ALTER TABLE satcat ADD COLUMN reference_ephemeris_stop TEXT",
    },
    // Catalogue completeness fields. Space-Track's satcat is the only source that
    // covers 100% of records for COSPAR, country and launch site, and the only one
    // with a catalogue orbit summary; these columns carry them into the master row.
    { table: "master_object", column: "country", ddl: "ALTER TABLE master_object ADD COLUMN country TEXT" },
    {
      table: "master_object",
      column: "launch_site",
      ddl: "ALTER TABLE master_object ADD COLUMN launch_site TEXT",
    },
    {
      table: "master_object",
      column: "catalog_period_min",
      ddl: "ALTER TABLE master_object ADD COLUMN catalog_period_min REAL",
    },
    {
      table: "master_object",
      column: "catalog_inclination_deg",
      ddl: "ALTER TABLE master_object ADD COLUMN catalog_inclination_deg REAL",
    },
    {
      table: "master_object",
      column: "catalog_apogee_km",
      ddl: "ALTER TABLE master_object ADD COLUMN catalog_apogee_km REAL",
    },
    {
      table: "master_object",
      column: "catalog_perigee_km",
      ddl: "ALTER TABLE master_object ADD COLUMN catalog_perigee_km REAL",
    },
    {
      table: "master_object",
      column: "rcs_size",
      ddl: "ALTER TABLE master_object ADD COLUMN rcs_size TEXT",
    },
    {
      table: "master_object",
      column: "current",
      ddl: "ALTER TABLE master_object ADD COLUMN current INTEGER",
    },
    // Physical model and launch record. These were present in `object_physics`
    // (71 074 rows) and `object_launch_info` (69 918 rows) but the merge never read
    // them, so 32 648 objects carried a mass in the source tables and none in the
    // master row — and no object carried a hard-body radius at all.
    {
      table: "master_object",
      column: "hard_body_radius_m",
      ddl: "ALTER TABLE master_object ADD COLUMN hard_body_radius_m REAL",
    },
    { table: "master_object", column: "span_m", ddl: "ALTER TABLE master_object ADD COLUMN span_m REAL" },
    {
      table: "master_object",
      column: "diameter_m",
      ddl: "ALTER TABLE master_object ADD COLUMN diameter_m REAL",
    },
    {
      table: "master_object",
      column: "dry_mass_kg",
      ddl: "ALTER TABLE master_object ADD COLUMN dry_mass_kg REAL",
    },
    {
      table: "master_object",
      column: "length_m",
      ddl: "ALTER TABLE master_object ADD COLUMN length_m REAL",
    },
    {
      table: "master_object",
      column: "ballistic_coefficient",
      ddl: "ALTER TABLE master_object ADD COLUMN ballistic_coefficient REAL",
    },
    {
      table: "master_object",
      column: "shape_number",
      ddl: "ALTER TABLE master_object ADD COLUMN shape_number INTEGER",
    },
    {
      table: "master_object",
      column: "manufacturer",
      ddl: "ALTER TABLE master_object ADD COLUMN manufacturer TEXT",
    },
    { table: "master_object", column: "bus", ddl: "ALTER TABLE master_object ADD COLUMN bus TEXT" },
    {
      table: "master_object",
      column: "orbit_type",
      ddl: "ALTER TABLE master_object ADD COLUMN orbit_type TEXT",
    },
    { table: "master_object", column: "motor", ddl: "ALTER TABLE master_object ADD COLUMN motor TEXT" },
    // Provenance of every merged value. Three catalogues disagree on 4 834
    // inclinations; keeping only the winner makes the merge impossible to defend.
    {
      table: "master_object",
      column: "value_sources",
      ddl: "ALTER TABLE master_object ADD COLUMN value_sources TEXT",
    },
  ];

  for (const { table, column, ddl } of additions) {
    const columns = sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!columns.some((c) => c.name === column)) {
      sqlite.exec(ddl);
    }
  }

  // Indexes on migrated columns must be created *after* the column exists. In the
  // inline DDL they would fail on an existing database, because
  // `CREATE TABLE IF NOT EXISTS` left the table without the column.
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS trajectories_companion_idx ON trajectories(companion_id)",
  );

  // The trajectory list orders by `uploaded_at` and limits; without this index
  // SQLite scanned the whole table and sorted it in a temp B-tree just to return
  // 200 metadata rows.
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS trajectories_uploaded_idx ON trajectories(uploaded_at)",
  );

  sqlite.exec("CREATE INDEX IF NOT EXISTS satcat_status_idx ON satcat(status)");
  // The supplemental feed has no NORAD number and is matched on `entity_id`.
  // Without this index the import is 72 000 full scans of a 72 000-row table:
  // it did not finish in three minutes and looked like a network hang.
  sqlite.exec("CREATE INDEX IF NOT EXISTS satcat_entity_idx ON satcat(entity_id)");

  migrateFileText(sqlite);
}

/**
 * Move `trajectories.file_text` into `trajectory_files`, then drop the column.
 *
 * SQLite cannot drop a column before 3.35 and never rewrites the table, so this
 * copies rows in batches (a single `INSERT ... SELECT` over 674 MB would hold the
 * whole set in memory), then rebuilds `trajectories` without the column so the
 * pages it occupied are actually released rather than merely marked free.
 *
 * Idempotent: a database already migrated has no `file_text` column and returns
 * immediately.
 */
function migrateFileText(sqlite: Database.Database): void {
  const columns = sqlite.pragma("table_info(trajectories)") as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "file_text")) return;

  const already = sqlite
    .prepare("SELECT COUNT(*) AS n FROM trajectory_files")
    .get() as { n: number };
  const pending = sqlite
    .prepare(
      "SELECT COUNT(*) AS n FROM trajectories t WHERE t.file_text <> '' " +
        "AND NOT EXISTS (SELECT 1 FROM trajectory_files f WHERE f.trajectory_id = t.id)",
    )
    .get() as { n: number };

  if (already.n === 0 || pending.n > 0) {
    // Copy in batches by rowid so memory stays bounded.
    const ids = sqlite
      .prepare("SELECT id FROM trajectories WHERE file_text IS NOT NULL AND file_text <> ''")
      .all() as Array<{ id: string }>;
    const insert = sqlite.prepare(
      "INSERT OR REPLACE INTO trajectory_files (trajectory_id, file_text) VALUES (?, ?)",
    );
    const read = sqlite.prepare("SELECT file_text FROM trajectories WHERE id = ?");

    // One transaction, one prepared statement pair. Reading and writing row by row
    // keeps peak memory at a single file rather than the whole 674 MB table.
    sqlite.transaction(() => {
      for (const { id } of ids) {
        const row = read.get(id) as { file_text: string } | undefined;
        if (row && row.file_text) insert.run(id, row.file_text);
      }
    })();
  }

  // Rebuild the table without the column. `PRAGMA legacy_alter_table` keeps the
  // rename from rewriting index definitions mid-way.
  const ddl = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='trajectories'")
    .get() as { sql: string } | undefined;
  if (!ddl) return;

  const newDdl = ddl.sql
    .replace(/CREATE TABLE\s+"?trajectories"?/i, "CREATE TABLE trajectories_new")
    .replace(/\n\s*file_text TEXT NOT NULL,?/i, "");

  sqlite.exec("BEGIN");
  try {
    sqlite.exec("PRAGMA legacy_alter_table = ON");
    sqlite.exec(newDdl);
    sqlite.exec(
      "INSERT INTO trajectories_new SELECT " +
        "id, object_id, operator_id, upload_type, state_source, screened_status, " +
        "file_format, start_at, end_at, point_count, screened_at, uploaded_at, " +
        "created_at, auto_relinquish_pc_threshold, seq, has_covariance, companion_id " +
        "FROM trajectories",
    );
    sqlite.exec("DROP TABLE trajectories");
    // The old index names die with the old table, except the ones the rebuild
    // inherited; drop both the suffixed and unsuffixed spellings so a rerun cannot
    // accumulate duplicates.
    for (const stale of [
      "trajectories_object_id_idx",
      "trajectories_operator_id_idx",
      "trajectories_screened_status_idx",
      "trajectories_object_idx",
      "trajectories_operator_idx",
      "trajectories_status_idx",
      "trajectories_seq_idx",
      "trajectories_companion_idx",
      "trajectories_uploaded_idx",
    ]) {
      sqlite.exec(`DROP INDEX IF EXISTS ${stale}`);
    }
    sqlite.exec("ALTER TABLE trajectories_new RENAME TO trajectories");
    // Index names match the originals so a later `CREATE INDEX IF NOT EXISTS` in
    // the inline DDL does not add a second, duplicate index on the same column.
    const indexColumns: Array<[string, string]> = [
      ["object", "object_id"],
      ["operator", "operator_id"],
      ["status", "screened_status"],
      ["seq", "seq"],
      ["companion", "companion_id"],
      ["uploaded", "uploaded_at"],
    ];
    for (const [name, column] of indexColumns) {
      sqlite.exec(
        `CREATE INDEX IF NOT EXISTS trajectories_${name}_idx ON trajectories(${column})`,
      );
    }
    sqlite.exec("COMMIT");
  } catch (err) {
    sqlite.exec("ROLLBACK");
    throw err;
  } finally {
    sqlite.exec("PRAGMA legacy_alter_table = OFF");
  }

  // Reclaim the pages the old rows left behind; VACUUM is the only way SQLite
  // returns them to the filesystem.
  sqlite.exec("VACUUM");
}

const DDL = `
CREATE TABLE IF NOT EXISTS stream_seq (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  max_objects INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  common_name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  pem TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS credentials_fingerprint_idx ON credentials(fingerprint);
CREATE INDEX IF NOT EXISTS credentials_operator_idx ON credentials(operator_id);

CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  object_name TEXT NOT NULL,
  norad_id INTEGER,
  hard_body_radius REAL NOT NULL,
  maneuverability INTEGER NOT NULL,
  alive INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS objects_operator_idx ON objects(operator_id);
CREATE INDEX IF NOT EXISTS objects_norad_idx ON objects(norad_id);
CREATE INDEX IF NOT EXISTS objects_name_idx ON objects(object_name);

CREATE TABLE IF NOT EXISTS trajectories (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  upload_type TEXT NOT NULL,
  state_source TEXT NOT NULL,
  screened_status TEXT NOT NULL DEFAULT 'not_screened',
  file_format TEXT NOT NULL,
  start_at TEXT,
  end_at TEXT,
  point_count INTEGER NOT NULL DEFAULT 0,
  screened_at TEXT,
  uploaded_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  auto_relinquish_pc_threshold REAL,
  seq INTEGER NOT NULL,
  has_covariance INTEGER NOT NULL DEFAULT 0,
  companion_id TEXT
);
CREATE TABLE IF NOT EXISTS trajectory_files (
  trajectory_id TEXT PRIMARY KEY,
  file_text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trajectories_object_idx ON trajectories(object_id);
CREATE INDEX IF NOT EXISTS trajectories_operator_idx ON trajectories(operator_id);
CREATE INDEX IF NOT EXISTS trajectories_status_idx ON trajectories(screened_status);
CREATE INDEX IF NOT EXISTS trajectories_seq_idx ON trajectories(seq);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  object1_id TEXT NOT NULL,
  object1_name TEXT NOT NULL,
  object1_maneuverable INTEGER NOT NULL,
  operator1_id TEXT NOT NULL,
  operator1_name TEXT NOT NULL,
  object2_id TEXT NOT NULL,
  object2_name TEXT NOT NULL,
  object2_maneuverable INTEGER NOT NULL,
  operator2_id TEXT NOT NULL,
  operator2_name TEXT NOT NULL,
  claim_status_operator1 TEXT NOT NULL DEFAULT 'none',
  claim_status_operator2 TEXT NOT NULL DEFAULT 'none',
  last_status_update_operator1 TEXT,
  last_status_update_operator2 TEXT,
  first_cdm_tca_gps_nanos TEXT,
  creation_time TEXT NOT NULL,
  updated_time TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_obj1_idx ON events(object1_id);
CREATE INDEX IF NOT EXISTS events_obj2_idx ON events(object2_id);
CREATE INDEX IF NOT EXISTS events_op1_idx ON events(operator1_id);
CREATE INDEX IF NOT EXISTS events_op2_idx ON events(operator2_id);

CREATE TABLE IF NOT EXISTS cdms (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  created_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  trajectory1_id TEXT NOT NULL,
  trajectory1_source TEXT NOT NULL,
  trajectory1_created_at TEXT,
  object1_id TEXT NOT NULL,
  object1_name TEXT NOT NULL,
  object1_maneuverable INTEGER,
  operator1_id TEXT NOT NULL,
  operator1_name TEXT NOT NULL,
  trajectory2_id TEXT NOT NULL,
  trajectory2_source TEXT NOT NULL,
  trajectory2_created_at TEXT,
  object2_id TEXT NOT NULL,
  object2_name TEXT NOT NULL,
  object2_maneuverable INTEGER,
  operator2_id TEXT NOT NULL,
  operator2_name TEXT NOT NULL,
  probability_of_collision REAL,
  tca_gps_nanos TEXT NOT NULL,
  miss_distance_km REAL,
  total_miss_distance_km REAL,
  relative_speed_km_s REAL,
  rtn_r REAL,
  rtn_t REAL,
  rtn_n REAL,
  cov_xx REAL,
  cov_xy REAL,
  cov_yy REAL,
  file_json TEXT NOT NULL,
  is_hypothetical INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cdms_event_idx ON cdms(event_id);
CREATE INDEX IF NOT EXISTS cdms_traj1_idx ON cdms(trajectory1_id);
CREATE INDEX IF NOT EXISTS cdms_traj2_idx ON cdms(trajectory2_id);
CREATE INDEX IF NOT EXISTS cdms_obj1_idx ON cdms(object1_id);
CREATE INDEX IF NOT EXISTS cdms_obj2_idx ON cdms(object2_id);
CREATE INDEX IF NOT EXISTS cdms_op1_idx ON cdms(operator1_id);
CREATE INDEX IF NOT EXISTS cdms_op2_idx ON cdms(operator2_id);
CREATE INDEX IF NOT EXISTS cdms_tca_idx ON cdms(tca_gps_nanos);
CREATE INDEX IF NOT EXISTS cdms_seq_idx ON cdms(seq);

CREATE TABLE IF NOT EXISTS catalog (
  object_id TEXT NOT NULL,
  state_source TEXT NOT NULL,
  trajectory_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (object_id, state_source)
);

CREATE TABLE IF NOT EXISTS screening_jobs (
  id TEXT PRIMARY KEY,
  trajectory_id TEXT NOT NULL,
  against_trajectory_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  dispatched_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON screening_jobs(status);
CREATE INDEX IF NOT EXISTS jobs_traj_idx ON screening_jobs(trajectory_id);

CREATE TABLE IF NOT EXISTS pagination_tokens (
  token TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  filter_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_stream_idx ON pagination_tokens(stream);

CREATE TABLE IF NOT EXISTS satcat (
  norad_id INTEGER PRIMARY KEY,
  entity_id TEXT,
  intl_id TEXT,
  name TEXT NOT NULL,
  object_type TEXT,
  owner TEXT,
  launch_site TEXT,
  launch_date TEXT,
  decay_date TEXT,
  period REAL,
  inclination REAL,
  apogee REAL,
  perigee REAL,
  rcs_size TEXT,
  source_snapshot TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS satcat_name_idx ON satcat(name);
CREATE INDEX IF NOT EXISTS satcat_type_idx ON satcat(object_type);

CREATE TABLE IF NOT EXISTS data_sources (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  format TEXT NOT NULL,
  credential_env TEXT,
  refresh_minutes INTEGER NOT NULL DEFAULT 120,
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_fetches (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  bytes INTEGER,
  records INTEGER,
  path TEXT,
  sha256 TEXT,
  error TEXT,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS source_fetches_source_idx ON source_fetches(source_id, started_at);
CREATE INDEX IF NOT EXISTS source_fetches_seq_idx ON source_fetches(seq);

CREATE TABLE IF NOT EXISTS object_sources (
  norad_id INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  epoch TEXT,
  inclination REAL,
  raan REAL,
  eccentricity REAL,
  arg_perigee REAL,
  mean_anomaly REAL,
  mean_motion REAL,
  bstar REAL,
  pos_x REAL,
  pos_y REAL,
  pos_z REAL,
  delta_km REAL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (norad_id, source_id)
);
CREATE INDEX IF NOT EXISTS object_sources_source_idx ON object_sources(source_id, norad_id);
CREATE INDEX IF NOT EXISTS object_sources_norad_idx ON object_sources(norad_id);

CREATE TABLE IF NOT EXISTS discos_objects (
  discos_id TEXT PRIMARY KEY,
  norad_id INTEGER,
  cospar_id TEXT,
  name TEXT,
  object_class TEXT,
  mission TEXT,
  mass REAL,
  shape TEXT,
  width REAL,
  height REAL,
  depth REAL,
  diameter REAL,
  span REAL,
  x_sect_max REAL,
  x_sect_min REAL,
  x_sect_avg REAL,
  first_epoch TEXT,
  pred_decay_date TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS discos_objects_norad_idx ON discos_objects(norad_id);
CREATE INDEX IF NOT EXISTS discos_objects_name_idx ON discos_objects(name);

-- L1: observed, merged. One row per physical object.
CREATE TABLE IF NOT EXISTS master_object (
  norad_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  alias_names TEXT,
  cospar_id TEXT,
  object_class TEXT,
  satcat_type TEXT,
  owner TEXT,
  launch_date TEXT,
  decay_date TEXT,
  mass_kg REAL,
  cross_section_avg_m2 REAL,
  cross_section_max_m2 REAL,
  cross_section_min_m2 REAL,
  shape TEXT,
  status TEXT,
  maneuverable INTEGER NOT NULL DEFAULT 0,
  sources TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  covariance_start TEXT,
  covariance_stop TEXT,
  /* Physical model. mass_kg and cross_section_avg_m2 above are the merged
     best values; these keep the parts that only one source provides. */
  hard_body_radius_m REAL,
  span_m REAL,
  diameter_m REAL,
  dry_mass_kg REAL,
  length_m REAL,
  ballistic_coefficient REAL,
  shape_number INTEGER,
  /* Launch record (McDowell): who built it and what bus it flies on. */
  manufacturer TEXT,
  bus TEXT,
  orbit_type TEXT,
  motor TEXT,
  /* Which source each contested value came from, as JSON: {"mass_kg":"discos",...}.
     A merged value without its provenance cannot be defended against an operator
     who says otherwise. */
  value_sources TEXT,
  merged_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS master_object_name_idx ON master_object(name);
CREATE INDEX IF NOT EXISTS master_object_class_idx ON master_object(object_class);
CREATE INDEX IF NOT EXISTS master_object_status_idx ON master_object(status);

-- L1: which source's element set is canonical for each object.
CREATE TABLE IF NOT EXISTS master_element_set (
  norad_id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  trajectory_id TEXT NOT NULL,
  epoch TEXT,
  arc_hours REAL,
  sigma_km REAL,
  alternatives TEXT,
  selected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS master_element_source_idx ON master_element_set(source_id);

-- L2: computed numbers. Never an input.
CREATE TABLE IF NOT EXISTS derived_state (
  norad_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source_id TEXT,
  field TEXT NOT NULL,
  value_num REAL,
  value_text TEXT,
  unit TEXT,
  method TEXT NOT NULL,
  input_hash TEXT,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (norad_id, kind, source_id, field)
);
CREATE INDEX IF NOT EXISTS derived_norad_idx ON derived_state(norad_id, kind);

-- L3: unresolved disagreements.
CREATE TABLE IF NOT EXISTS master_conflict (
  id TEXT PRIMARY KEY,
  norad_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  claims_json TEXT NOT NULL,
  chosen_value TEXT,
  resolution TEXT NOT NULL,
  reason TEXT,
  detected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conflict_norad_idx ON master_conflict(norad_id);
CREATE INDEX IF NOT EXISTS conflict_field_idx ON master_conflict(field);

-- L0: every value every source gave, whether we chose it or not.
-- Unconditional, unlike master_conflict which records only disagreements we
-- happened to notice. This is what lets a merged value name its origin.
CREATE TABLE IF NOT EXISTS object_field_claim (
  norad_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  source_id TEXT NOT NULL,
  value_num REAL,
  value_text TEXT,
  unit TEXT,
  source_field TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (norad_id, field, source_id)
);
CREATE INDEX IF NOT EXISTS claim_field_source_idx ON object_field_claim(field, source_id);
CREATE INDEX IF NOT EXISTS claim_source_idx ON object_field_claim(source_id);

-- Physical model from Spacebook's satcat/details feed. 99.98% coverage.
CREATE TABLE IF NOT EXISTS object_physics (
  norad_id INTEGER PRIMARY KEY,
  adopted_mass_kg REAL,
  adopted_span_m REAL,
  adopted_diameter_m REAL,
  ballistic_coefficient REAL,
  hbr_mean_m REAL,
  hbr_median_m REAL,
  hbr_lo_m REAL,
  hbr_hi_m REAL,
  hbr_encap_m REAL,
  cross_section_median_m2 REAL,
  solar_radiation_pressure REAL,
  shape_number INTEGER,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS object_physics_hbr_idx ON object_physics(hbr_mean_m);

-- Launch and identity metadata (McDowell).
CREATE TABLE IF NOT EXISTS object_launch_info (
  norad_id INTEGER PRIMARY KEY,
  jcat TEXT,
  launch_tag TEXT,
  piece TEXT,
  object_type TEXT,
  payload_name TEXT,
  launch_date TEXT,
  separation_date TEXT,
  decay_date TEXT,
  owner TEXT,
  state TEXT,
  manufacturer TEXT,
  bus TEXT,
  mass_kg REAL,
  dry_mass_kg REAL,
  length_m REAL,
  diameter_m REAL,
  span_m REAL,
  shape TEXT,
  perigee_km REAL,
  apogee_km REAL,
  inclination_deg REAL,
  orbit_type TEXT,
  motor TEXT,
  alt_names TEXT,
  updated_at TEXT NOT NULL
);

-- Space-Track satellite catalogue: the only 100%-complete identity source, and
-- the source of the catalogue orbit summary and launch country.
CREATE TABLE IF NOT EXISTS space_track_satcat (
  norad_id INTEGER PRIMARY KEY,
  intl_des TEXT,
  object_type TEXT,
  sat_name TEXT,
  country TEXT,
  launch TEXT,
  site TEXT,
  decay TEXT,
  period_min REAL,
  inclination_deg REAL,
  apogee_km REAL,
  perigee_km REAL,
  rcs_value REAL,
  rcs_size TEXT,
  current TEXT,
  comment TEXT,
  comment_code TEXT,
  file_ref TEXT,
  launch_year INTEGER,
  launch_num INTEGER,
  launch_piece TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS st_satcat_country_idx ON space_track_satcat(country);
CREATE INDEX IF NOT EXISTS st_satcat_type_idx ON space_track_satcat(object_type);
`;

/**
 * Allocate the next value of a named sequence, inside a transaction.
 *
 * SQLite's `RETURNING` makes this a single atomic statement, which matters
 * because the API can insert CDMs from several worker connections at once.
 */
export function nextSeq(sqlite: Database.Database, name: string): number {
  const row = sqlite
    .prepare(
      `INSERT INTO stream_seq (name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get(name) as { value: number };
  return row.value;
}
