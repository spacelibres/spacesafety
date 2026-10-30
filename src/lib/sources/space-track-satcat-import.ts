/**
 * Import Space-Track's satellite catalogue (`class/satcat`).
 *
 * ## Why this source is not redundant with the other two
 *
 * Measured on the 2026-10-29 capture, 71 198 records:
 *
 * | field | coverage | who else has it |
 * |---|---|---|
 * | international designator | **71 198 (100%)** | Spacebook 71 174, DISCOS partial |
 * | launch country | **71 198** | nobody, in this vocabulary |
 * | launch site | **71 198** | Spacebook has the name, not the code |
 * | period / apogee / perigee | 69 086 | DISCOS: no |
 * | inclination | 69 073 | Spacebook has it |
 * | RCS size class | 58 233 | Spacebook has it |
 *
 * The catalogue the replica was building had **no launch country, no launch site
 * code and no catalogue orbit summary at all**, because this file was downloaded
 * but never parsed. That is a catalogue-completeness gap, not a modelling one.
 *
 * ## Two fields that look useful and are not
 *
 * * `RCSVALUE` is `0` for all 71 198 records — the field exists, carries nothing.
 * * `CURRENT` is `Y` for all 71 198 — it does not distinguish live from decayed
 *   objects here, so decay status comes from `DECAY` instead.
 *
 * Both are imported anyway. A future capture may populate them, and a column that
 * silently disappears is harder to notice than one that is uniformly empty.
 */

import type Database from "better-sqlite3";

export interface SpaceTrackSatcatRecord {
  NORAD_CAT_ID?: string | number | null;
  INTLDES?: string | null;
  OBJECT_TYPE?: string | null;
  SATNAME?: string | null;
  COUNTRY?: string | null;
  LAUNCH?: string | null;
  SITE?: string | null;
  DECAY?: string | null;
  PERIOD?: string | null;
  INCLINATION?: string | null;
  APOGEE?: string | null;
  PERIGEE?: string | null;
  RCSVALUE?: string | number | null;
  RCS_SIZE?: string | null;
  CURRENT?: string | null;
  COMMENT?: string | null;
  COMMENTCODE?: string | null;
  FILE?: string | null;
  LAUNCH_YEAR?: string | number | null;
  LAUNCH_NUM?: string | number | null;
  LAUNCH_PIECE?: string | null;
}

export interface SpaceTrackSatcatSummary {
  records: number;
  imported: number;
  skipped: number;
  withIntlDes: number;
  withCountry: number;
  withOrbit: number;
  ms: number;
}

export class SpaceTrackSatcatImporter {
  private readonly sqlite: Database.Database;

  constructor(sqlite: Database.Database) {
    this.sqlite = sqlite;
  }

  import(records: SpaceTrackSatcatRecord[]): SpaceTrackSatcatSummary {
    const started = Date.now();
    const now = new Date().toISOString();

    const insert = this.sqlite.prepare(
      `INSERT INTO space_track_satcat
         (norad_id, intl_des, object_type, sat_name, country, launch, site, decay,
          period_min, inclination_deg, apogee_km, perigee_km, rcs_value, rcs_size,
          current, comment, comment_code, file_ref, launch_year, launch_num,
          launch_piece, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(norad_id) DO UPDATE SET
         intl_des = excluded.intl_des, object_type = excluded.object_type,
         sat_name = excluded.sat_name, country = excluded.country,
         launch = excluded.launch, site = excluded.site, decay = excluded.decay,
         period_min = excluded.period_min,
         inclination_deg = excluded.inclination_deg,
         apogee_km = excluded.apogee_km, perigee_km = excluded.perigee_km,
         rcs_value = excluded.rcs_value, rcs_size = excluded.rcs_size,
         current = excluded.current, comment = excluded.comment,
         comment_code = excluded.comment_code, file_ref = excluded.file_ref,
         launch_year = excluded.launch_year, launch_num = excluded.launch_num,
         launch_piece = excluded.launch_piece, updated_at = excluded.updated_at`,
    );

    const summary: SpaceTrackSatcatSummary = {
      records: records.length,
      imported: 0,
      skipped: 0,
      withIntlDes: 0,
      withCountry: 0,
      withOrbit: 0,
      ms: 0,
    };

    const tx = this.sqlite.transaction((rows: SpaceTrackSatcatRecord[]) => {
      this.sqlite.prepare("DELETE FROM space_track_satcat").run();
      for (const r of rows) {
        const noradId = num(r.NORAD_CAT_ID);
        if (noradId === null || noradId <= 0) {
          summary.skipped += 1;
          continue;
        }

        const intlDes = text(r.INTLDES);
        const country = text(r.COUNTRY);
        const period = num(r.PERIOD);
        if (intlDes) summary.withIntlDes += 1;
        if (country) summary.withCountry += 1;
        if (period !== null) summary.withOrbit += 1;

        insert.run(
          noradId,
          intlDes,
          text(r.OBJECT_TYPE),
          text(r.SATNAME),
          country,
          text(r.LAUNCH),
          text(r.SITE),
          text(r.DECAY),
          period,
          num(r.INCLINATION),
          num(r.APOGEE),
          num(r.PERIGEE),
          num(r.RCSVALUE),
          text(r.RCS_SIZE),
          text(r.CURRENT),
          text(r.COMMENT),
          text(r.COMMENTCODE),
          text(r.FILE),
          num(r.LAUNCH_YEAR),
          num(r.LAUNCH_NUM),
          text(r.LAUNCH_PIECE),
          now,
        );
        summary.imported += 1;
      }
    });

    tx(records);
    summary.ms = Date.now() - started;
    return summary;
  }
}

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
