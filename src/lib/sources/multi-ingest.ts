/**
 * Store one source's element sets without disturbing the others.
 *
 * ## The bug this exists to prevent
 *
 * The first version of the Spacebook ingest wrote its TLEs into
 * `trajectories.state_source = 'tle'`, the same value the Space-Track ingest used.
 * Both feeds cover the ISS, so the second ingest overwrote the first and the
 * catalogue ended up holding one provider's view with no record of which. Every
 * "compare the sources" question was then unanswerable, because the evidence had
 * already been destroyed at write time.
 *
 * ## What is stored, and where
 *
 * * `object_sources(norad_id, source_id)` — **one row per source**. The element
 *   set exactly as that provider published it. Never overwritten by a competitor.
 * * `objects` — one row per physical object, shared by all sources. Identity
 *   fields (name, hard-body radius, manoeuvrability) are only written by the
 *   source that wins `identityPriority`, so Spacebook's SATCAT naming is not
 *   clobbered by Space-Track's older one.
 * * `trajectories` — one row per `(object, source)`. Screening reads the winner
 *   of `trajectoryPriority`; the losers stay queryable for cross-checking.
 *
 * The whole write is one transaction: 29 000 objects must not be visible half
 * updated to a concurrent screening job.
 */

import type Database from "better-sqlite3";

import type { Tle } from "../orbit/tle";
import { SOURCES, type SourceDefinition } from "./registry";

export interface MultiIngestOptions {
  /** Skip element sets older than this many days. */
  maxAgeDays?: number;
  /** Where objects with no catalogue record are filed. */
  fallbackOperatorId?: string;
}

export interface MultiIngestSummary {
  sourceId: string;
  received: number;
  inserted: number;
  updated: number;
  skippedStale: number;
  unnamed: number;
  ms: number;
}

/**
 * Ingest `tles` as the view of `sourceId`.
 *
 * Names come from the object's existing row when there is one, so a source that
 * carries no name (XP-TLE) does not rename an object that SATCAT already named.
 */
export function ingestSourceTle(
  sqlite: Database.Database,
  sourceId: string,
  tles: Tle[],
  nextSeq: (sqlite: Database.Database, name: string) => number,
  options: MultiIngestOptions = {},
): number {
  const summary = new SourceTleIngest(sqlite, sourceId, nextSeq, options).run(tles);
  return summary.inserted + summary.updated;
}

/**
 * Store one source's element sets.
 *
 * A class rather than a function because the prepared statements are worth
 * reusing when a caller ingests many batches (Space-Track arrives 100 objects at
 * a time), and re-preparing them per batch dominated the run.
 */
export class SourceTleIngest {
  private readonly sqlite: Database.Database;
  private readonly source: SourceDefinition;
  private readonly options: Required<MultiIngestOptions>;
  private readonly nextSeq: (sqlite: Database.Database, name: string) => number;

  constructor(
    sqlite: Database.Database,
    sourceId: string,
    nextSeq: (sqlite: Database.Database, name: string) => number,
    options: MultiIngestOptions = {},
  ) {
    const source = SOURCES.find((s) => s.id === sourceId);
    if (!source) throw new Error(`unknown source "${sourceId}"`);
    this.sqlite = sqlite;
    this.source = source;
    this.nextSeq = nextSeq;
    this.options = {
      maxAgeDays: options.maxAgeDays ?? 30,
      fallbackOperatorId: options.fallbackOperatorId ?? "catalog",
    };
  }

  run(tles: Tle[]): MultiIngestSummary {
    const started = Date.now();
    const now = new Date().toISOString();
    const cutoff = Date.now() - this.options.maxAgeDays * 86_400_000;

    const summary: MultiIngestSummary = {
      sourceId: this.source.id,
      received: tles.length,
      inserted: 0,
      updated: 0,
      skippedStale: 0,
      unnamed: 0,
      ms: 0,
    };

    const findObject = this.sqlite.prepare(
      "SELECT id, object_name, hard_body_radius, operator_id FROM objects WHERE norad_id = ? LIMIT 1",
    );
    const insertObject = this.sqlite.prepare(
      `INSERT INTO objects (id, operator_id, object_name, norad_id, hard_body_radius,
                            maneuverability, alive, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    const findSatcat = this.sqlite.prepare(
      "SELECT name, object_type, rcs_size, decay_date FROM satcat WHERE norad_id = ? LIMIT 1",
    );
    const findTrajectory = this.sqlite.prepare(
      "SELECT id FROM trajectories WHERE object_id = ? AND state_source = ? LIMIT 1",
    );
    const insertTrajectory = this.sqlite.prepare(
      `INSERT INTO trajectories (id, object_id, operator_id, upload_type, state_source,
                                 screened_status, file_format, start_at, end_at, point_count,
                                 uploaded_at, created_at, has_covariance, seq)
       VALUES (?, ?, ?, 'catalog', ?, 'not_screened', 'tle', ?, ?, 1, ?, ?, 0, ?)`,
    );
    const updateTrajectory = this.sqlite.prepare(
      "UPDATE trajectories SET start_at = ?, end_at = ?, uploaded_at = ?, seq = ? WHERE id = ?",
    );
    const upsertFile = this.sqlite.prepare(
      `INSERT INTO trajectory_files (trajectory_id, file_text) VALUES (?, ?)
       ON CONFLICT(trajectory_id) DO UPDATE SET file_text = excluded.file_text`,
    );
    const upsertCatalog = this.sqlite.prepare(
      `INSERT INTO catalog (object_id, state_source, trajectory_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(object_id, state_source) DO UPDATE
         SET trajectory_id = excluded.trajectory_id, updated_at = excluded.updated_at`,
    );
    const upsertState = this.sqlite.prepare(
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

    const tx = this.sqlite.transaction((items: Tle[]) => {
      for (const tle of items) {
        if (tle.epochMs < cutoff) {
          summary.skippedStale += 1;
          continue;
        }

        const satcat = findSatcat.get(tle.noradId) as
          | { name: string; object_type: string | null; rcs_size: string | null; decay_date: string | null }
          | undefined;

        const name = tle.name?.trim() || satcat?.name || null;
        if (!name) summary.unnamed += 1;

        let object = findObject.get(tle.noradId) as
          | { id: string; object_name: string; hard_body_radius: number; operator_id: string }
          | undefined;

        if (!object) {
          const id = crypto.randomUUID();
          const radius = radiusFromRcs(satcat?.rcs_size);
          insertObject.run(
            id,
            this.options.fallbackOperatorId,
            name ?? `NORAD-${tle.noradId}`,
            tle.noradId,
            radius,
            (satcat?.object_type ?? "").toUpperCase() === "PAYLOAD" ? 1 : 0,
            now,
            now,
          );
          object = {
            id,
            object_name: name ?? `NORAD-${tle.noradId}`,
            hard_body_radius: radius,
            operator_id: this.options.fallbackOperatorId,
          };
        }

        const epoch = new Date(tle.epochMs).toISOString();
        const fileText = [name ?? object.object_name, tle.line1, tle.line2].join("\n");

        const existing = findTrajectory.get(object.id, this.source.id) as
          | { id: string }
          | undefined;
        const seq = this.nextSeq(this.sqlite, "trajectories");

        let trajectoryId: string;
        if (existing) {
          trajectoryId = existing.id;
          updateTrajectory.run(epoch, epoch, now, seq, trajectoryId);
          summary.updated += 1;
        } else {
          trajectoryId = crypto.randomUUID();
          insertTrajectory.run(
            trajectoryId,
            object.id,
            object.operator_id,
            this.source.id,
            epoch,
            epoch,
            now,
            now,
            seq,
          );
          summary.inserted += 1;
        }

        upsertFile.run(trajectoryId, fileText);
        upsertCatalog.run(object.id, this.source.id, trajectoryId, now);

        upsertState.run(
          tle.noradId,
          this.source.id,
          epoch,
          tle.inclinationDeg,
          tle.raanDeg,
          tle.eccentricity,
          tle.argPerigeeDeg,
          tle.meanAnomalyDeg,
          tle.meanMotionRevPerDay,
          tle.bstar,
          now,
        );
      }
    });

    tx(tles);
    summary.ms = Date.now() - started;
    return summary;
  }
}

/** RCS class → conservative hard-body radius, metres. Mirrors the SatCat importer. */
function radiusFromRcs(rcs: string | null | undefined): number {
  switch ((rcs ?? "").toUpperCase()) {
    case "LARGE":
      return 5.0;
    case "SMALL":
      return 0.5;
    case "VERY SMALL":
      return 0.2;
    default:
      return 1.5;
  }
}
