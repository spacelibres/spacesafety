/**
 * Load an archived DISCOSweb `objects` capture into `discos_objects`.
 *
 * ## Why the loader reads the archive, not the API
 *
 * The crawl takes about fifteen minutes and 131 MB; the import takes four seconds
 * from the archived file. Separating them means a loader fix can be re-run
 * without re-crawling, and the database always reflects a specific archive
 * capture rather than "whatever the API returned sometime today".
 *
 * ## JSON:API shape
 *
 * Each record is `{ id, type: "object", attributes: { satno, name, mass, … } }`.
 * `satno` is the NORAD number; it is present for catalogue objects and absent for
 * a small number of DISCOS-only entries, which are skipped — without a catalogue
 * number nothing downstream can join them to an orbit.
 */

import type Database from "better-sqlite3";

export interface DiscosObjectAttributes {
  satno?: number | null;
  cosparId?: string | null;
  name?: string | null;
  objectClass?: string | null;
  mission?: string | null;
  mass?: number | null;
  shape?: string | null;
  width?: number | null;
  height?: number | null;
  depth?: number | null;
  diameter?: number | null;
  span?: number | null;
  xSectMax?: number | null;
  xSectMin?: number | null;
  xSectAvg?: number | null;
  firstEpoch?: string | null;
  predDecayDate?: string | null;
  [key: string]: unknown;
}

export interface DiscosRecord {
  id?: string;
  type?: string;
  attributes?: DiscosObjectAttributes;
}

export interface DiscosImportSummary {
  records: number;
  imported: number;
  skippedNoNorad: number;
  withMass: number;
  withCrossSection: number;
  ms: number;
}

export class DiscosImporter {
  private readonly sqlite: Database.Database;

  constructor(sqlite: Database.Database) {
    this.sqlite = sqlite;
  }

  /**
   * Replace the table with the capture's contents.
   *
   * A full replace rather than a merge: DISCOSweb deletes records it retracts,
   * and a merge would keep a retracted object's mass forever.
   */
  import(records: DiscosRecord[]): DiscosImportSummary {
    const started = Date.now();
    const now = new Date().toISOString();

    const insert = this.sqlite.prepare(
      `INSERT INTO discos_objects
         (discos_id, norad_id, cospar_id, name, object_class, mission, mass, shape,
          width, height, depth, diameter, span, x_sect_max, x_sect_min, x_sect_avg,
          first_epoch, pred_decay_date, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(discos_id) DO UPDATE SET
         norad_id = excluded.norad_id, cospar_id = excluded.cospar_id,
         name = excluded.name, object_class = excluded.object_class,
         mission = excluded.mission, mass = excluded.mass, shape = excluded.shape,
         width = excluded.width, height = excluded.height, depth = excluded.depth,
         diameter = excluded.diameter, span = excluded.span,
         x_sect_max = excluded.x_sect_max, x_sect_min = excluded.x_sect_min,
         x_sect_avg = excluded.x_sect_avg,
         first_epoch = excluded.first_epoch, pred_decay_date = excluded.pred_decay_date,
         updated_at = excluded.updated_at`,
    );

    const summary: DiscosImportSummary = {
      records: records.length,
      imported: 0,
      skippedNoNorad: 0,
      withMass: 0,
      withCrossSection: 0,
      ms: 0,
    };

    const tx = this.sqlite.transaction((rows: DiscosRecord[]) => {
      this.sqlite.prepare("DELETE FROM discos_objects").run();
      for (const record of rows) {
        const a = record.attributes;
        const id = record.id;
        if (!id || !a) continue;

        const noradId = num(a.satno);
        if (noradId === null || noradId <= 0) {
          summary.skippedNoNorad += 1;
          continue;
        }

        const mass = num(a.mass);
        const xSectAvg = num(a.xSectAvg);
        if (mass !== null) summary.withMass += 1;
        if (xSectAvg !== null) summary.withCrossSection += 1;

        insert.run(
          id,
          noradId,
          text(a.cosparId),
          text(a.name),
          text(a.objectClass),
          text(a.mission),
          mass,
          text(a.shape),
          num(a.width),
          num(a.height),
          num(a.depth),
          num(a.diameter),
          num(a.span),
          num(a.xSectMax),
          num(a.xSectMin),
          xSectAvg,
          text(a.firstEpoch),
          text(a.predDecayDate),
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

/** Cross-section lookup by NORAD number, for the collision model. */
export interface CrossSection {
  noradId: number;
  /** Mean projected area, m². */
  areaM2: number;
  /** Largest projected area, m². */
  maxAreaM2: number;
  /** Smallest projected area, m². */
  minAreaM2: number;
  massKg: number | null;
  shape: string | null;
}

export function loadCrossSections(sqlite: Database.Database): Map<number, CrossSection> {
  const rows = sqlite
    .prepare(
      `SELECT norad_id AS noradId, x_sect_avg AS avg, x_sect_max AS max,
              x_sect_min AS min, mass, shape
         FROM discos_objects WHERE norad_id IS NOT NULL AND x_sect_avg IS NOT NULL`,
    )
    .all() as Array<{
    noradId: number;
    avg: number;
    max: number | null;
    min: number | null;
    mass: number | null;
    shape: string | null;
  }>;

  const out = new Map<number, CrossSection>();
  for (const row of rows) {
    out.set(row.noradId, {
      noradId: row.noradId,
      areaM2: row.avg,
      maxAreaM2: row.max ?? row.avg,
      minAreaM2: row.min ?? row.avg,
      massKg: row.mass,
      shape: row.shape,
    });
  }
  return out;
}

/** Identity, kept explicit so the row shape above stays readable. */
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
