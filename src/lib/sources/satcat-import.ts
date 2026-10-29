/**
 * Import a Spacebook SATCAT snapshot into the `satcat` table.
 *
 * The snapshot is a single JSON array of ~72 000 objects (21 MB). It is read in
 * one go rather than streamed: 72 000 small records are about 60 MB as live
 * objects, which is affordable on the ingest machine, and a streaming JSON
 * parser would be a dependency for no measurable gain on a file this shape.
 *
 * The import is a full replace, not a merge. SATCAT is a *snapshot* — an entry
 * removed upstream means the object was reclassified, not that it vanished — and
 * a merge would keep stale rows forever. The whole load runs in one transaction
 * so readers never see a partial catalogue.
 */

import type Database from "better-sqlite3";

export interface SatcatRecord {
  id?: string | null;
  intlId?: string | null;
  name?: string | null;
  noradId?: number | string | null;
  launchDate?: string | null;
  decayDate?: string | null;
  objectType?: string | null;
  owner?: string | null;
  launchSite?: string | null;
  period?: number | null;
  inclination?: number | null;
  apogee?: number | null;
  perigee?: number | null;
  rcsSize?: string | null;
  /** From the supplemental feed: `Active` | `Dead` | `Debris` | `RocketBody` | `Unknown`. */
  status?: string | null;
  opsStatusCode?: string | null;
  /** Covariance window, when the provider publishes one for this object. */
  covarianceStartTime?: string | null;
  covarianceStopTime?: string | null;
  referenceEphemerisStartTime?: string | null;
  referenceEphemerisStopTime?: string | null;
}

export interface SatcatImportSummary {
  records: number;
  inserted: number;
  skipped: number;
  ms: number;
}

/**
 * Import one SATCAT snapshot into the `satcat` table.
 *
 * ## Two feeds, one table
 *
 * Spacebook publishes the catalogue twice:
 *
 *   `/api/entity/satcat`             — names, launch/decay dates, RCS, orbit
 *   `/api/entity/satcat/supplemental` — status, lifetime, covariance window
 *
 * They are keyed by the same COMSPOC `entityId`, but the supplemental feed has no
 * NORAD number and the detail feed's numbers are what every join uses. The merge
 * is therefore done on `entityId`: the detail import runs first and establishes
 * the NORAD key, then the supplemental import fills the extra columns on matching
 * rows.
 *
 * ## Replace, not merge — for the detail feed
 *
 * The detail snapshot is authoritative for the rows it contains, so it replaces
 * the table: an entry removed upstream means the object was reclassified, and
 * keeping stale rows forever would make every count wrong. The supplemental feed
 * is the opposite — it only *adds* columns to rows that exist, so it updates in
 * place and never deletes.
 */
export function importSatcat(
  sqlite: Database.Database,
  snapshot: SatcatRecord[],
  sourceSnapshot: string,
): SatcatImportSummary {
  return new SatcatImporter(sqlite).importDetail(snapshot, sourceSnapshot);
}

/** Fill status and covariance columns from the supplemental snapshot. */
export function importSatcatSupplemental(
  sqlite: Database.Database,
  snapshot: SatcatRecord[],
  sourceSnapshot: string,
): SatcatImportSummary {
  return new SatcatImporter(sqlite).importSupplemental(snapshot, sourceSnapshot);
}

export class SatcatImporter {
  private readonly sqlite: Database.Database;

  constructor(sqlite: Database.Database) {
    this.sqlite = sqlite;
  }

  importDetail(snapshot: SatcatRecord[], sourceSnapshot: string): SatcatImportSummary {
    const started = Date.now();
    const now = new Date().toISOString();

    const insert = this.sqlite.prepare(
      `INSERT INTO satcat (norad_id, entity_id, intl_id, name, object_type, owner,
                           launch_site, launch_date, decay_date, period, inclination,
                           apogee, perigee, rcs_size, source_snapshot, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(norad_id) DO UPDATE SET
         entity_id = excluded.entity_id,
         intl_id = excluded.intl_id,
         name = excluded.name,
         object_type = excluded.object_type,
         owner = excluded.owner,
         launch_site = excluded.launch_site,
         launch_date = excluded.launch_date,
         decay_date = excluded.decay_date,
         period = excluded.period,
         inclination = excluded.inclination,
         apogee = excluded.apogee,
         perigee = excluded.perigee,
         rcs_size = excluded.rcs_size,
         source_snapshot = excluded.source_snapshot,
         updated_at = excluded.updated_at`,
    );

    let inserted = 0;
    let skipped = 0;

    const tx = this.sqlite.transaction((rows: SatcatRecord[]) => {
      this.sqlite.prepare("DELETE FROM satcat").run();
      for (const r of rows) {
        const noradId = num(r.noradId);
        const name = text(r.name);
        // Without a NORAD number the row cannot be joined to any element set, and
        // without a name it cannot be displayed; both are required to be useful.
        if (noradId === null || noradId <= 0 || name === null) {
          skipped += 1;
          continue;
        }
        insert.run(
          noradId,
          text(r.id),
          text(r.intlId),
          name,
          text(r.objectType),
          text(r.owner),
          text(r.launchSite),
          text(r.launchDate),
          text(r.decayDate),
          num(r.period),
          num(r.inclination),
          num(r.apogee),
          num(r.perigee),
          text(r.rcsSize),
          sourceSnapshot,
          now,
        );
        inserted += 1;
      }
    });

    tx(snapshot);
    return { records: snapshot.length, inserted, skipped, ms: Date.now() - started };
  }

  /**
   * Apply the supplemental feed.
   *
   * Matched on `entityId`, because that is the only key the supplemental body
   * carries. A row whose entity id is unknown is skipped rather than inserted: it
   * would have no NORAD number and no name, so it could never be joined or shown.
   */
  importSupplemental(snapshot: SatcatRecord[], sourceSnapshot: string): SatcatImportSummary {
    const started = Date.now();

    const update = this.sqlite.prepare(
      `UPDATE satcat SET
         status = ?, ops_status_code = ?,
         covariance_start = ?, covariance_stop = ?,
         reference_ephemeris_start = ?, reference_ephemeris_stop = ?,
         source_snapshot = ?, updated_at = ?
       WHERE entity_id = ?`,
    );
    const now = new Date().toISOString();
    let updated = 0;
    let skipped = 0;

    const tx = this.sqlite.transaction((rows: SatcatRecord[]) => {
      for (const r of rows) {
        const entityId = text(r.id);
        if (!entityId) {
          skipped += 1;
          continue;
        }
        const result = update.run(
          text(r.status),
          text(r.opsStatusCode),
          text(r.covarianceStartTime),
          text(r.covarianceStopTime),
          text(r.referenceEphemerisStartTime),
          text(r.referenceEphemerisStopTime),
          sourceSnapshot,
          now,
          entityId,
        );
        if (result.changes > 0) updated += 1;
        else skipped += 1;
      }
    });

    tx(snapshot);
    return { records: snapshot.length, inserted: updated, skipped, ms: Date.now() - started };
  }
}

/**
 * Spacebook sometimes returns `""` for a field it has no value for. Storing the
 * empty string would make "no decay date" indistinguishable from "decayed at the
 * empty string" everywhere downstream, so it is normalised to NULL once.
 */
function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
