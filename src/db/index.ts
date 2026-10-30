import "server-only";

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { SCHEMA_DDL } from "./ddl";
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
  sqlite.exec(SCHEMA_DDL);
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
      table: "source_fetches",
      column: "etag",
      ddl: "ALTER TABLE source_fetches ADD COLUMN etag TEXT",
    },
    {
      table: "source_fetches",
      column: "last_modified",
      ddl: "ALTER TABLE source_fetches ADD COLUMN last_modified TEXT",
    },
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
