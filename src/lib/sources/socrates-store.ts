/**
 * Storage for CelesTrak's SOCRATES screening.
 *
 * Replaces `keeptrack_conjunction`, which held KeepTrack's ten-row copy of the same
 * feed (see `src/lib/sources/celestrak-socrates.ts` for the measurement). The table
 * is replaced wholesale on every run: SOCRATES itself is a rolling window of
 * upcoming events, not an archive, so carrying yesterday's rows forward would keep
 * events that have already happened.
 *
 * 197,600 rows × ~120 bytes is small enough to keep in the main catalogue database.
 */

import type Database from "better-sqlite3";

import type { SocratesEventRow } from "./celestrak-socrates";

export const SOCRATES_DDL = `
CREATE TABLE IF NOT EXISTS socrates_event (
  norad1        INTEGER NOT NULL,
  norad2        INTEGER NOT NULL,
  name1         TEXT NOT NULL,
  name2         TEXT NOT NULL,
  age1_d        REAL,
  age2_d        REAL,
  tca           TEXT,
  min_range_km  REAL,
  rel_speed_kms REAL,
  max_prob      REAL,
  dilution      REAL,
  fetched_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS socrates_tca_idx ON socrates_event(tca);
CREATE INDEX IF NOT EXISTS socrates_range_idx ON socrates_event(min_range_km);
CREATE INDEX IF NOT EXISTS socrates_prob_idx ON socrates_event(max_prob);
CREATE INDEX IF NOT EXISTS socrates_norad1_idx ON socrates_event(norad1);
CREATE INDEX IF NOT EXISTS socrates_norad2_idx ON socrates_event(norad2);

CREATE TABLE IF NOT EXISTS socrates_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class SocratesStore {
  constructor(private readonly sqlite: Database.Database) {
    this.sqlite.exec(SOCRATES_DDL);
  }

  /** Replace every row in one transaction; returns the row count written. */
  replaceAll(rows: SocratesEventRow[], meta: Record<string, string>): number {
    const now = new Date().toISOString();
    const stmt = this.sqlite.prepare(
      `INSERT INTO socrates_event
         (norad1, norad2, name1, name2, age1_d, age2_d, tca,
          min_range_km, rel_speed_kms, max_prob, dilution, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const metaStmt = this.sqlite.prepare(
      "INSERT OR REPLACE INTO socrates_meta (key, value) VALUES (?, ?)",
    );
    this.sqlite.transaction((batch: SocratesEventRow[]) => {
      this.sqlite.prepare("DELETE FROM socrates_event").run();
      for (const r of batch) {
        stmt.run(
          r.norad1,
          r.norad2,
          r.name1,
          r.name2,
          r.age1,
          r.age2,
          r.tca,
          r.minRangeKm,
          r.relSpeedKmS,
          r.maxProb,
          r.dilution,
          now,
        );
      }
      for (const [k, v] of Object.entries({ ...meta, fetched_at: now })) {
        metaStmt.run(k, v);
      }
    })(rows);
    return rows.length;
  }

  readMeta(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.sqlite.prepare("SELECT key, value FROM socrates_meta").all() as {
      key: string;
      value: string;
    }[]) {
      out[row.key] = row.value;
    }
    return out;
  }

  /** The ten-row KeepTrack copy, if this database still has it. */
  keepTrackTableExists(): boolean {
    return (
      (
        this.sqlite
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='keeptrack_conjunction'")
          .get() as { n: number }
      ).n > 0
    );
  }
}
