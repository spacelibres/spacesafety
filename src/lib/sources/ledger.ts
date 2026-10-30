/**
 * Bookkeeping for multi-source ingestion.
 *
 * Every ingest path now goes through this class so three questions always have an
 * answer:
 *
 *   * **When did we last pull this source, and did it work?** → `source_fetches`
 *   * **Is it due?**                          → `registry.isDue`
 *   * **What does this source say about object N?** → `object_sources`
 *
 * The third is the one that makes cross-checking possible. Storing both
 * Space-Track's and Spacebook's element set for NORAD 44714 lets the comparison
 * pass say "these differ by 0.0011° of inclination, 2.5 km at the joint epoch",
 * which is the evidence needed before either is allowed to drive a screening.
 *
 * ## Why raw SQL rather than the drizzle query builder
 *
 * These are bulk upserts inside a transaction — 29 000 rows per refresh. The
 * builder round-trips each statement through a query object; prepared statements
 * reused across the loop are measurably faster and the column list is written
 * once, next to the DDL it has to match.
 */

import type Database from "better-sqlite3";

import { SOURCES, type SourceDefinition } from "./registry";

export interface FetchRecord {
  sourceId: string;
  status: "running" | "ok" | "failed" | "unchanged";
  bytes?: number;
  records?: number;
  path?: string | null;
  sha256?: string | null;
  error?: string;
  /** HTTP validator from this response, kept for the next conditional request. */
  etag?: string | null;
  lastModified?: string | null;
}

/** One provider's view of one object. */
export interface ObjectSourceState {
  noradId: number;
  sourceId: string;
  epoch: string | null;
  inclination: number | null;
  raan: number | null;
  eccentricity: number | null;
  argPerigee: number | null;
  meanAnomaly: number | null;
  meanMotion: number | null;
  bstar: number | null;
}

export class SourceLedger {
  private readonly sqlite: Database.Database;
  private readonly now: () => string;

  constructor(sqlite: Database.Database, now: () => string = () => new Date().toISOString()) {
    this.sqlite = sqlite;
    this.now = now;
  }

  /** Insert the registry rows once, and refresh the mutable columns each time. */
  seedRegistry(sources: readonly SourceDefinition[] = SOURCES): number {
    const upsert = this.sqlite.prepare(
      `INSERT INTO data_sources
         (id, label, kind, format, credential_env, refresh_minutes, enabled, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         kind = excluded.kind,
         format = excluded.format,
         credential_env = excluded.credential_env,
         refresh_minutes = excluded.refresh_minutes,
         notes = excluded.notes,
         updated_at = excluded.updated_at`,
    );
    const ts = this.now();
    const tx = this.sqlite.transaction((list: readonly SourceDefinition[]) => {
      for (const s of list) {
        upsert.run(
          s.id,
          s.label,
          s.kind,
          s.format,
          s.credentialEnv ?? null,
          s.refreshMinutes,
          s.notes,
          ts,
          ts,
        );
      }
    });
    tx(sources);
    return sources.length;
  }

  /**
   * Rows of the registry keyed by id, including the last-success timestamp.
   *
   * Read back from the database rather than from the code, because the timestamps
   * are runtime state and the scheduler's decision must be based on what actually
   * happened, not on what the code expects to have happened.
   */
  lastSuccess(): Map<string, string | null> {
    const rows = this.sqlite
      .prepare("SELECT id, last_success_at FROM data_sources")
      .all() as Array<{ id: string; last_success_at: string | null }>;
    return new Map(rows.map((r) => [r.id, r.last_success_at]));
  }

  /** Open a fetch record; returns its id. */
  begin(sourceId: string, seq: number): string {
    const id = crypto.randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO source_fetches (id, source_id, started_at, status, seq)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(id, sourceId, this.now(), seq);
    this.sqlite
      .prepare("UPDATE data_sources SET last_attempt_at = ?, updated_at = ? WHERE id = ?")
      .run(this.now(), this.now(), sourceId);
    return id;
  }

  /** Close a fetch record and update the source's last-success/error. */
  finish(fetchId: string, record: FetchRecord): void {
    const ts = this.now();
    this.sqlite
      .prepare(
        `UPDATE source_fetches
            SET finished_at = ?, status = ?, bytes = ?, records = ?, path = ?, sha256 = ?,
                error = ?, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified)
          WHERE id = ?`,
      )
      .run(
        ts,
        record.status,
        record.bytes ?? null,
        record.records ?? null,
        record.path ?? null,
        record.sha256 ?? null,
        record.error ?? null,
        record.etag ?? null,
        record.lastModified ?? null,
        fetchId,
      );

    if (record.status === "failed") {
      this.sqlite
        .prepare("UPDATE data_sources SET last_error = ?, updated_at = ? WHERE id = ?")
        .run(record.error ?? "unknown error", ts, record.sourceId);
      return;
    }
    this.sqlite
      .prepare(
        "UPDATE data_sources SET last_success_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
      )
      .run(ts, ts, record.sourceId);
  }

  /**
   * Validators from the last successful capture, for a conditional request.
   *
   * Only successes count: a failed attempt recorded no body, so its validator
   * would be a promise about bytes we never saw. Reading the newest such row is
   * what lets the next poll ask "has this changed since then?" and get `304`
   * instead of 552 MB a day.
   */
  lastValidators(sourceId: string): { etag: string | null; lastModified: string | null } {
    const row = this.sqlite
      .prepare(
        `SELECT etag, last_modified AS lastModified
           FROM source_fetches
          WHERE source_id = ? AND status IN ('ok', 'unchanged')
            AND (etag IS NOT NULL OR last_modified IS NOT NULL)
          ORDER BY started_at DESC, seq DESC
          LIMIT 1`,
      )
      .get(sourceId) as { etag: string | null; lastModified: string | null } | undefined;
    return { etag: row?.etag ?? null, lastModified: row?.lastModified ?? null };
  }

  /**
   * Record what one source says about many objects, in one transaction.
   *
   * `ON CONFLICT` replaces the row: an element set is superseded wholesale, so
   * merging fields across refreshes would mix two epochs into one record.
   */
  upsertObjectStates(states: Iterable<ObjectSourceState>, fetchedAt = this.now()): number {
    const stmt = this.sqlite.prepare(
      `INSERT INTO object_sources
         (norad_id, source_id, epoch, inclination, raan, eccentricity, arg_perigee,
          mean_anomaly, mean_motion, bstar, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(norad_id, source_id) DO UPDATE SET
         epoch = excluded.epoch,
         inclination = excluded.inclination,
         raan = excluded.raan,
         eccentricity = excluded.eccentricity,
         arg_perigee = excluded.arg_perigee,
         mean_anomaly = excluded.mean_anomaly,
         mean_motion = excluded.mean_motion,
         bstar = excluded.bstar,
         fetched_at = excluded.fetched_at`,
    );

    let count = 0;
    const tx = this.sqlite.transaction((list: ObjectSourceState[]) => {
      for (const s of list) {
        stmt.run(
          s.noradId,
          s.sourceId,
          s.epoch,
          s.inclination,
          s.raan,
          s.eccentricity,
          s.argPerigee,
          s.meanAnomaly,
          s.meanMotion,
          s.bstar,
          fetchedAt,
        );
        count += 1;
      }
    });
    tx([...states]);
    return count;
  }

  /** How many sources currently hold a view of this object. */
  sourceCount(noradId: number): number {
    const row = this.sqlite
      .prepare("SELECT COUNT(*) AS n FROM object_sources WHERE norad_id = ?")
      .get(noradId) as { n: number };
    return row.n;
  }

  /** Per-source object counts, for the dashboard. */
  coverage(): Array<{ sourceId: string; objects: number; newestEpoch: string | null }> {
    return this.sqlite
      .prepare(
        `SELECT source_id AS sourceId, COUNT(*) AS objects, MAX(epoch) AS newestEpoch
           FROM object_sources GROUP BY source_id ORDER BY objects DESC`,
      )
      .all() as Array<{ sourceId: string; objects: number; newestEpoch: string | null }>;
  }
}
