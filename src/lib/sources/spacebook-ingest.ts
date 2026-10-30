/**
 * Bulk ingest of the Spacebook XP-TLE feed.
 *
 * XP-TLE is the only public element set for the whole 29 000-object catalogue,
 * and it is the reason a NORAD number can be attached to anything that is not
 * Starlink. It carries two *lines* per object and no name, so ingest has to
 * resolve identity from two other feeds:
 *
 *   OMM  — named, with catalogue fields; the authority when both exist.
 *   SATCAT — the historical catalogue; covers objects the OMM set has dropped.
 *
 * ## Why this is a class and not a script
 *
 * The ingest touches three tables and has to stay consistent across them:
 * a TLE row, its `catalog` pointer, and the name it resolved. Keeping that in
 * one object means the lookup maps, the prepared statements and the transaction
 * are all in one scope, and a test can drive it against a temporary database
 * without spawning a process.
 *
 * ## Why one transaction
 *
 * 29 000 inserts as 29 000 autocommitted statements means 29 000 fsyncs. Inside
 * one transaction the same work takes about two seconds, and a failure rolls
 * back to the previous catalogue rather than leaving a half-replaced one.
 *
 * ## Why `objects` is reused rather than a new table
 *
 * Screening needs one row per physical object regardless of which feed its
 * states came from; a parallel `tle_objects` table would mean every downstream
 * join has to try both. Starlink objects therefore gain a second trajectory
 * (`state_source = 'tle'`) beside their operator ephemeris, which is exactly how
 * the two feeds were meant to coexist.
 */

import type Database from "better-sqlite3";

import type { Tle } from "../orbit/tle";

export interface SatcatMeta {
  noradId: number;
  name: string;
  intlId: string | null;
  objectType: string | null;
  owner: string | null;
  rcsSize: string | null;
  launchDate: string | null;
  decayDate: string | null;
  period: number | null;
  inclination: number | null;
  apogee: number | null;
  perigee: number | null;
  entityId: string | null;
}

export interface TleIngestOptions {
  /** Operator these catalogue objects are attributed to. Default `catalog`. */
  operatorId?: string;
  /** Skip objects whose element set is older than this many days. */
  maxAgeDays?: number;
  /** Reporting cadence: one line per N objects. */
  reportEvery?: number;
  log?: (line: string) => void;
}

export interface TleIngestSummary {
  parsed: number;
  named: number;
  inserted: number;
  updated: number;
  skippedStale: number;
  ms: number;
}

/**
 * Hard-body radius by RCS class, metres — a **fallback only**.
 *
 * Prefer `object_physics.hbr_mean_m`. Measured against that table, an RCS band is
 * not a usable estimate:
 *
 * | object | band | true `hbrMeanMeters` | error |
 * |---|---|---|---|
 * | STARLINK-1008 | LARGE → 5.0 m | 1.139 m | 4.4× too large |
 * | ISS (ZARYA) | LARGE → 5.0 m | 36.49 m | 14.6× too small |
 *
 * The band cannot be fixed by nudging the constants: it has one number for objects
 * whose radii differ by 32×. It survives because a row with no physical model must
 * still produce *a* number, and dropping the object entirely would be worse. The
 * collision model should read the real value whenever it exists, which is 99.98%
 * of the catalogue.
 */
const HBR_BY_RCS: Record<string, number> = {
  LARGE: 5.0,
  MEDIUM: 1.5,
  SMALL: 0.5,
  "VERY SMALL": 0.2,
};

export function hardBodyRadiusFor(rcsSize: string | null | undefined): number {
  return HBR_BY_RCS[(rcsSize ?? "").toUpperCase()] ?? 1.5;
}

/**
 * Does this object type have no propulsion by construction?
 *
 * Rocket bodies and debris cannot manoeuvre; marking them so matters because
 * the screening policy assigns manoeuvre responsibility to the party that can.
 */
export function isManeuverable(objectType: string | null | undefined): boolean {
  return (objectType ?? "").toUpperCase() === "PAYLOAD";
}

export class TleCatalogueIngest {
  private readonly options: Required<Omit<TleIngestOptions, "log">> & {
    log: (line: string) => void;
  };

  constructor(options: TleIngestOptions = {}) {
    this.options = {
      operatorId: options.operatorId ?? "catalog",
      maxAgeDays: options.maxAgeDays ?? 30,
      reportEvery: options.reportEvery ?? 2000,
      log: options.log ?? ((line) => console.log(line)),
    };
  }

  /**
   * Ingest `tles` into the database behind `sqlite`.
   *
   * `names` maps NORAD id to the best name available. Both callers pass the OMM
   * names first and SATCAT names underneath, because the OMM entry is the one the
   * operator publishes while SATCAT can be a launch-designation placeholder.
   */
  run(
    sqlite: Database.Database,
    tles: Tle[],
    satcat: Map<number, SatcatMeta>,
    names: Map<number, string>,
  ): TleIngestSummary {
    const started = Date.now();
    const now = new Date().toISOString();
    const cutoff = Date.now() - this.options.maxAgeDays * 86_400_000;

    const findObject = sqlite.prepare(
      "SELECT id FROM objects WHERE norad_id = ? AND operator_id = ? LIMIT 1",
    );
    const insertObject = sqlite.prepare(
      `INSERT INTO objects (id, operator_id, object_name, norad_id, hard_body_radius,
                            maneuverability, alive, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateObject = sqlite.prepare(
      "UPDATE objects SET object_name = ?, hard_body_radius = ?, maneuverability = ?, alive = ?, updated_at = ? WHERE id = ?",
    );
    const findTrajectory = sqlite.prepare(
      "SELECT id FROM trajectories WHERE object_id = ? AND state_source = 'tle' LIMIT 1",
    );
    const insertTrajectory = sqlite.prepare(
      `INSERT INTO trajectories (id, object_id, operator_id, upload_type, state_source,
                                 screened_status, file_format, start_at, end_at, point_count,
                                 uploaded_at, created_at, has_covariance, seq)
       VALUES (?, ?, ?, 'catalog', 'tle', 'not_screened', 'tle', ?, ?, 1, ?, ?, 0, ?)`,
    );
    const updateTrajectory = sqlite.prepare(
      "UPDATE trajectories SET start_at = ?, end_at = ?, uploaded_at = ?, seq = ? WHERE id = ?",
    );
    const upsertFile = sqlite.prepare(
      `INSERT INTO trajectory_files (trajectory_id, file_text) VALUES (?, ?)
       ON CONFLICT(trajectory_id) DO UPDATE SET file_text = excluded.file_text`,
    );
    const upsertCatalog = sqlite.prepare(
      `INSERT INTO catalog (object_id, state_source, trajectory_id, updated_at)
       VALUES (?, 'tle', ?, ?)
       ON CONFLICT(object_id, state_source) DO UPDATE
         SET trajectory_id = excluded.trajectory_id, updated_at = excluded.updated_at`,
    );
    const bumpSeq = sqlite.prepare(
      `INSERT INTO stream_seq (name, value) VALUES ('trajectories', ?)
       ON CONFLICT(name) DO UPDATE SET value = value + excluded.value
       RETURNING value`,
    );

    const summary: TleIngestSummary = {
      parsed: tles.length,
      named: 0,
      inserted: 0,
      updated: 0,
      skippedStale: 0,
      ms: 0,
    };

    const runTx = sqlite.transaction((items: Tle[]) => {
      for (const tle of items) {
        if (tle.epochMs < cutoff) {
          summary.skippedStale += 1;
          continue;
        }

        const meta = satcat.get(tle.noradId);
        const objectName =
          names.get(tle.noradId) ?? meta?.name ?? `NORAD-${tle.noradId}`;
        if (names.has(tle.noradId) || meta) summary.named += 1;

        const hbr = hardBodyRadiusFor(meta?.rcsSize);
        const maneuverable = isManeuverable(meta?.objectType) ? 1 : 0;
        const alive = meta?.decayDate ? 0 : 1;

        const existing = findObject.get(tle.noradId, this.options.operatorId) as
          | { id: string }
          | undefined;
        let objectId: string;
        if (existing) {
          objectId = existing.id;
          updateObject.run(objectName, hbr, maneuverable, alive, now, objectId);
        } else {
          objectId = crypto.randomUUID();
          insertObject.run(
            objectId,
            this.options.operatorId,
            objectName,
            tle.noradId,
            hbr,
            maneuverable,
            alive,
            now,
            now,
          );
        }

        const epoch = new Date(tle.epochMs).toISOString();
        const fileText = [objectName, tle.line1, tle.line2].join("\n");
        const seq = (bumpSeq.get(1) as { value: number }).value;

        const traj = findTrajectory.get(objectId) as { id: string } | undefined;
        let trajectoryId: string;
        if (traj) {
          trajectoryId = traj.id;
          updateTrajectory.run(epoch, epoch, now, seq, trajectoryId);
          summary.updated += 1;
        } else {
          trajectoryId = crypto.randomUUID();
          insertTrajectory.run(
            trajectoryId,
            objectId,
            this.options.operatorId,
            epoch,
            epoch,
            now,
            now,
            seq,
          );
          summary.inserted += 1;
        }

        upsertFile.run(trajectoryId, fileText);
        upsertCatalog.run(objectId, trajectoryId, now);

        if ((summary.inserted + summary.updated) % this.options.reportEvery === 0) {
          this.options.log(
            `  ${summary.inserted + summary.updated}/${tles.length} ` +
              `(${summary.inserted} new, ${summary.updated} refreshed)`,
          );
        }
      }
    });

    runTx(tles);
    summary.ms = Date.now() - started;
    return summary;
  }
}

/**
 * Load SATCAT rows into a lookup keyed by NORAD id.
 *
 * Read from the database rather than the JSON snapshot so the ingest does not
 * depend on which snapshot files happen to be on disk — the importer for those
 * files is a separate step with its own verification.
 */
export function loadSatcat(sqlite: Database.Database): Map<number, SatcatMeta> {
  const rows = sqlite
    .prepare(
      `SELECT norad_id, name, intl_id, object_type, owner, rcs_size, launch_date,
              decay_date, period, inclination, apogee, perigee, entity_id
         FROM satcat`,
    )
    .all() as Array<{
    norad_id: number;
    name: string;
    intl_id: string | null;
    object_type: string | null;
    owner: string | null;
    rcs_size: string | null;
    launch_date: string | null;
    decay_date: string | null;
    period: number | null;
    inclination: number | null;
    apogee: number | null;
    perigee: number | null;
    entity_id: string | null;
  }>;

  const out = new Map<number, SatcatMeta>();
  for (const r of rows) {
    out.set(r.norad_id, {
      noradId: r.norad_id,
      name: r.name,
      intlId: r.intl_id,
      objectType: r.object_type,
      owner: r.owner,
      rcsSize: r.rcs_size,
      launchDate: r.launch_date,
      decayDate: r.decay_date,
      period: r.period,
      inclination: r.inclination,
      apogee: r.apogee,
      perigee: r.perigee,
      entityId: r.entity_id,
    });
  }
  return out;
}
