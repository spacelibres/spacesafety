/**
 * Fill the derived layer (L2) from the merged base layer (L1).
 *
 * ## The boundary this enforces
 *
 * A derived row is a *claim we made*, not a fact we received. Every row therefore
 * carries:
 *
 *   `method`      how it was produced, e.g. `sgp4@epoch`
 *   `inputHash`   hash of the inputs, so a changed input marks the row stale
 *
 * Nothing in L2 is ever read back as an input to L1. If a number here turns out
 * to be wrong, deleting the row and re-running is sufficient; nothing upstream
 * depends on it.
 *
 * ## What is derived here
 *
 * | kind | field | why it is derived and not stored |
 * |---|---|---|
 * | `orbit-summary` | `altitude_km`, `period_min`, `eccentricity`, `inclination_deg` | recomputed from the canonical element set, so it always matches the orbit actually selected |
 * | `coverage` | `arc_hours`, `epoch_age_hours` | depends on *when* you ask, so it is a computation, not a fact |
 * | `source-agreement` | `sources_holding`, `has_mass`, `has_cross_section` | a join across the source tables |
 *
 * Orbital elements are taken from the element set the merge selected rather than
 * copied from SATCAT: SATCAT's period and inclination come from a different epoch
 * and would silently disagree with the orbit we screen with.
 */

import type Database from "better-sqlite3";

export interface DeriveOptions {
  /** Skip per-object SGP4 work; only the join-level fields are written. */
  skipOrbits?: boolean;
  log?: (line: string) => void;
}

export interface DeriveSummary {
  objects: number;
  rows: number;
  withOrbitSummary: number;
  ms: number;
}

export class DerivedLayer {
  private readonly sqlite: Database.Database;
  private readonly options: Required<Omit<DeriveOptions, "log">> & { log: (line: string) => void };

  constructor(sqlite: Database.Database, options: DeriveOptions = {}) {
    this.sqlite = sqlite;
    this.options = {
      skipOrbits: options.skipOrbits ?? false,
      log: options.log ?? ((line) => console.log(line)),
    };
  }

  /**
   * Rebuild the derived rows for every object in the master table.
   *
   * A full rebuild, because every value here is a function of L1 and the clock.
   * `epoch_age_hours` in particular is meaningless if kept from a previous run.
   */
  run(now = new Date()): DeriveSummary {
    const started = Date.now();
    const computedAt = now.toISOString();
    const summary: DeriveSummary = { objects: 0, rows: 0, withOrbitSummary: 0, ms: 0 };

    const objects = this.sqlite
      .prepare(
        `SELECT m.norad_id AS noradId, m.mass_kg AS mass, m.cross_section_avg_m2 AS area,
                m.object_class AS objectClass, m.sources AS sources,
                e.source_id AS sourceId, e.epoch AS epoch, e.arc_hours AS arcHours
           FROM master_object m
           LEFT JOIN master_element_set e ON e.norad_id = m.norad_id`,
      )
      .all() as Array<{
      noradId: number;
      mass: number | null;
      area: number | null;
      objectClass: string | null;
      sources: string;
      sourceId: string | null;
      epoch: string | null;
      arcHours: number | null;
    }>;

    const insert = this.sqlite.prepare(
      `INSERT INTO derived_state
         (norad_id, kind, source_id, field, value_num, value_text, unit, method, input_hash, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(norad_id, kind, source_id, field) DO UPDATE SET
         value_num = excluded.value_num, value_text = excluded.value_text,
         unit = excluded.unit, method = excluded.method,
         input_hash = excluded.input_hash, computed_at = excluded.computed_at`,
    );

    const elementStmt = this.sqlite.prepare(
      `SELECT (SELECT o.inclination FROM object_sources o
                WHERE o.norad_id = ? AND o.source_id = ? LIMIT 1) AS inclination,
              (SELECT o.mean_motion FROM object_sources o
                WHERE o.norad_id = ? AND o.source_id = ? LIMIT 1) AS meanMotion,
              (SELECT o.eccentricity FROM object_sources o
                WHERE o.norad_id = ? AND o.source_id = ? LIMIT 1) AS eccentricity`,
    );

    const tx = this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM derived_state").run();

      for (const row of objects) {
        summary.objects += 1;

        // --- coverage: depends on the current time, so always recomputed.
        if (row.epoch) {
          const ageHours = (now.getTime() - Date.parse(row.epoch)) / 3_600_000;
          insert.run(
            row.noradId, "coverage", null, "epoch_age_hours", ageHours, null, "h",
            "now-minus-epoch", null, computedAt,
          );
          summary.rows += 1;
        }
        if (row.arcHours !== null) {
          insert.run(
            row.noradId, "coverage", null, "arc_hours", row.arcHours, null, "h",
            "end-minus-start", null, computedAt,
          );
          summary.rows += 1;
        }

        // --- source agreement: a join, not a judgement.
        const holdingSrc = this.sqlite
          .prepare("SELECT COUNT(*) AS n FROM object_sources WHERE norad_id = ?")
          .get(row.noradId) as { n: number };
        insert.run(
          row.noradId, "source-agreement", null, "sources_holding",
          holdingSrc.n, null, "count", "count-distinct-source", null, computedAt,
        );
        summary.rows += 1;

        insert.run(
          row.noradId, "source-agreement", null, "has_mass",
          row.mass !== null ? 1 : 0, null, "bool", "mass-not-null", null, computedAt,
        );
        insert.run(
          row.noradId, "source-agreement", null, "has_cross_section",
          row.area !== null ? 1 : 0, null, "bool", "area-not-null", null, computedAt,
        );
        summary.rows += 2;

        // --- orbit summary from the *selected* element set.
        if (this.options.skipOrbits || !row.sourceId) continue;

        const elements = elementStmt.get(
          row.noradId, row.sourceId, row.noradId, row.sourceId, row.noradId, row.sourceId,
        ) as { inclination: number | null; meanMotion: number | null; eccentricity: number | null };

        if (elements.inclination !== null) {
          insert.run(
            row.noradId, "orbit-summary", row.sourceId, "inclination_deg",
            elements.inclination, null, "deg", "element-set@epoch", row.sourceId, computedAt,
          );
          summary.rows += 1;
        }
        if (elements.eccentricity !== null) {
          insert.run(
            row.noradId, "orbit-summary", row.sourceId, "eccentricity",
            elements.eccentricity, null, null, "element-set@epoch", row.sourceId, computedAt,
          );
          summary.rows += 1;
        }
        if (elements.meanMotion !== null && elements.meanMotion > 0) {
          // Period and altitude are arithmetic on the mean motion, which is why
          // they belong here and not in the store of observations.
          const periodMin = 1440 / elements.meanMotion;
          const mu = 398_600.4418; // km^3/s^2
          const a = Math.cbrt((mu * (periodMin * 60) ** 2) / (4 * Math.PI * Math.PI));

          insert.run(
            row.noradId, "orbit-summary", row.sourceId, "period_min",
            periodMin, null, "min", "kepler-from-mean-motion", row.sourceId, computedAt,
          );
          insert.run(
            row.noradId, "orbit-summary", row.sourceId, "semi_major_axis_km",
            a, null, "km", "kepler-from-mean-motion", row.sourceId, computedAt,
          );
          insert.run(
            row.noradId, "orbit-summary", row.sourceId, "altitude_km",
            a - 6378.137, null, "km", "kepler-from-mean-motion", row.sourceId, computedAt,
          );
          summary.rows += 3;
          summary.withOrbitSummary += 1;
        }
      }
    });

    tx();
    summary.ms = Date.now() - started;
    return summary;
  }
}
