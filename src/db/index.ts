import "server-only";

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: AppDatabase;
  sqlite: Database.Database;
}

let instance: DbHandle | undefined;

export function databasePath(): string {
  return process.env.SPACE_EYES_DB ?? "./data/spaceeyes.sqlite";
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

  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");

  applySchema(sqlite);
  const db = drizzle(sqlite, { schema });
  instance = { db, sqlite };
  return instance;
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
