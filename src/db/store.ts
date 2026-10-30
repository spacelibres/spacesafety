/**
 * Splitting the database in two: the base catalogue, and the heavy orbit store.
 *
 * ## The measurement that forced this
 *
 * One file was 56.7 GB, and 53.8 GB of it was a single table:
 *
 * | table | size |
 * |---|---|
 * | `trajectory_files` (raw ephemeris text) | **53.8 GB** |
 * | everything else, combined | 2.9 GB |
 *
 * The web application needs the catalogue — names, classes, masses, which orbit to
 * use — and touches the raw ephemeris text only when it propagates. So the two are
 * separated:
 *
 *   `spacesafety-base.sqlite`   ~102 MB   identity, physical model, derived values
 *   `spacesafety-orbits.sqlite` ~54 GB    raw ephemeris text, one row per trajectory
 *
 * The base file is what a deployment ships; the orbit file stays wherever the
 * compute runs. They are joined with SQLite's `ATTACH`, so a query can still reach
 * both in one statement when it genuinely needs to.
 *
 * ## Why ATTACH and not two connections
 *
 * A screening run needs the catalogued mass (base) and the ephemeris text
 * (orbits) for the same object in one pass. Two connections would mean joining in
 * application code, which turns every screening into an N+1 query and makes the
 * transaction boundary ambiguous. `ATTACH` keeps it one database, one transaction,
 * with the physical layout still split.
 *
 * ## What breaks if the orbit file is absent
 *
 * Everything that must keep working without 54 GB on disk:
 *
 *   * the `/objects` list, object detail, SATCAT search — base only
 *   * the coverage and mass statistics — base only
 *
 * And what needs the orbit file, reported as an explicit "not attached" rather
 * than a confusing empty result:
 *
 *   * propagation, screening, Pc
 */

import { existsSync, statSync } from "node:fs";

import type Database from "better-sqlite3";

export interface StorePaths {
  /** Identity, physical model and derived values. Always required. */
  base: string;
  /** Raw ephemeris text. Attached when present. */
  orbits: string;
}

/** The alias every query uses to reach the orbits file. */
export const ORBITS_SCHEMA = "orbits";

export function defaultStorePaths(env: NodeJS.ProcessEnv = process.env): StorePaths {
  const dir = env.SPACE_SAFETY_DATA_DIR ?? "./data";
  return {
    base: env.SPACE_SAFETY_BASE_DB ?? `${dir}/spacesafety-base.sqlite`,
    orbits: env.SPACE_SAFETY_ORBIT_DB ?? `${dir}/spacesafety-orbits.sqlite`,
  };
}

export interface AttachResult {
  attached: boolean;
  /** Why the orbits file is not attached, when it is not. */
  reason?: string;
  /** Size on disk of the orbits file, bytes, when attached. */
  bytes?: number;
}

/**
 * Attach the orbit store to an open connection, if it exists.
 *
 * Idempotent: attaching an already-attached alias throws in SQLite, so the alias is
 * checked first. A missing file is not an error here — a deployment that only
 * serves the catalogue legitimately has no orbit store, and the callers that need
 * it check `isOrbitsAttached` before querying.
 */
export function attachOrbits(sqlite: Database.Database, paths: StorePaths): AttachResult {
  const already = sqlite
    .prepare("SELECT COUNT(*) AS n FROM pragma_database_list WHERE name = ?")
    .get(ORBITS_SCHEMA) as { n: number };

  if (already.n > 0) {
    return { attached: true };
  }

  if (!existsSync(paths.orbits)) {
    return {
      attached: false,
      reason: `orbit store not found at ${paths.orbits}; propagation and screening are unavailable`,
    };
  }

  // Read-only: the web process never writes ephemeris text, and opening it
  // read-only avoids taking a write lock against the compute process.
  sqlite.exec(`ATTACH DATABASE '${paths.orbits.replace(/'/g, "''")}' AS ${ORBITS_SCHEMA}`);

  return { attached: true, bytes: statSync(paths.orbits).size };
}

/** Whether the orbits file is attached, so callers can fail with a reason. */
export function isOrbitsAttached(sqlite: Database.Database): boolean {
  const row = sqlite
    .prepare("SELECT COUNT(*) AS n FROM pragma_database_list WHERE name = ?")
    .get(ORBITS_SCHEMA) as { n: number };
  return row.n > 0;
}

/**
 * The fully-qualified name of a table that may live in either file.
 *
 * `trajectory_files` moved to the orbit store; everything else stayed. Rather than
 * sprinkle `orbits.` through the codebase, this returns the qualified name and
 * throws with a readable message when the file is not there — a bare
 * "no such table" from SQLite does not explain why.
 */
export function orbitsTable(sqlite: Database.Database, table: string): string {
  if (!isOrbitsAttached(sqlite)) {
    throw new Error(
      `${table} lives in the orbits database, but ${ORBITS_SCHEMA} is not attached; ` +
        "set SPACE_SAFETY_ORBIT_DB or run `npm run master:split` first",
    );
  }
  return `${ORBITS_SCHEMA}.${table}`;
}
