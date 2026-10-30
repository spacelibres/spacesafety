/**
 * Field-level provenance: what each catalogue said, and what we chose.
 *
 * ## Why every value must be kept
 *
 * Space-Track is the US reference catalogue, DISCOSweb is ESA's, and Spacebook
 * carries ComSpoc/AGI-STK's derived model. They disagree on 4 834 inclinations and
 * 9 680 object classes, and neither disagreement is an error to be resolved — it is
 * three authoritative bodies stating different things.
 *
 * The previous merge collapsed them: `master_object` kept the chosen value and
 * `master_conflict` kept the losers, but only as an exception log. Of 72 311
 * objects, 54 recorded a competing value. The other 72 257 lost it permanently,
 * including 4 833 of the 4 834 inclination disagreements.
 *
 * This table is unconditional: one row per (object, field, source) for every
 * value any source gave, whether it was chosen or not. It is what makes the merge
 * reversible and auditable — quoting a number can always name who said it.
 *
 * ## Why a separate table and not more columns
 *
 * Three sources × twenty fields would be sixty columns on `master_object`, most
 * null, and adding a fourth source would mean migrating every row. A narrow table
 * costs one join and stays open to new sources.
 *
 * ## What this table must never contain
 *
 * Computed values. A derived quantity belongs in `derived_state`, because it has
 * no source to attribute. If an inference is stored here with `source_id =
 * 'ours'`, it becomes indistinguishable from an observation.
 */

import type Database from "better-sqlite3";

/** A source's claim about one field of one object. */
export interface FieldClaim {
  noradId: number;
  /** Canonical field name, e.g. `mass_kg`, `inclination_deg`, `object_class`. */
  field: string;
  /** Registry id of the source making the claim, e.g. `space-track`. */
  sourceId: string;
  /** Numeric value, when the field is a quantity. */
  valueNum: number | null;
  /** Text value, when the field is a category or a date. */
  valueText: string | null;
  /** Unit of `valueNum`, e.g. `kg`, `m`, `deg`. Null for text fields. */
  unit: string | null;
  /** The provider's own column name, so the claim can be traced to a file. */
  sourceField: string;
  /** When the provider's record was retrieved, ISO 8601. */
  observedAt: string;
}

export const PROVENANCE_DDL = `
CREATE TABLE IF NOT EXISTS object_field_claim (
  norad_id    INTEGER NOT NULL,
  field       TEXT    NOT NULL,
  source_id   TEXT    NOT NULL,
  value_num   REAL,
  value_text  TEXT,
  unit        TEXT,
  source_field TEXT   NOT NULL,
  observed_at TEXT    NOT NULL,
  PRIMARY KEY (norad_id, field, source_id)
);
CREATE INDEX IF NOT EXISTS claim_field_source_idx ON object_field_claim(field, source_id);
CREATE INDEX IF NOT EXISTS claim_source_idx ON object_field_claim(source_id);
`;

/**
 * Writes claims in bulk.
 *
 * A transaction per row made 71 000 × 20 inserts take minutes; batching them by
 * object keeps it to seconds. `INSERT OR REPLACE` because a re-import of the same
 * provider file must overwrite, not duplicate.
 */
export class ClaimStore {
  private readonly insert: Database.Statement;

  constructor(private readonly sqlite: Database.Database) {
    this.sqlite.exec(PROVENANCE_DDL);
    this.insert = sqlite.prepare(
      `INSERT OR REPLACE INTO object_field_claim
         (norad_id, field, source_id, value_num, value_text, unit, source_field, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /** Replace every claim for one object, then write the new ones. */
  replaceFor(noradId: number, claims: FieldClaim[]): void {
    this.sqlite.prepare("DELETE FROM object_field_claim WHERE norad_id = ?").run(noradId);
    for (const c of claims) {
      this.insert.run(
        c.noradId,
        c.field,
        c.sourceId,
        c.valueNum,
        c.valueText,
        c.unit,
        c.sourceField,
        c.observedAt,
      );
    }
  }

  /** Wrap a whole import in one transaction. */
  batch<T>(work: () => T): T {
    return this.sqlite.transaction(work)();
  }

  /**
   * How much each source contributed, for the build report.
   *
   * Reported per field rather than as a total: a source that supplies 71 000
   * names and nothing else and one that supplies 71 000 masses look identical in a
   * single number, and only the per-field view shows they are not interchangeable.
   */
  coverage(): Array<{ sourceId: string; field: string; objects: number }> {
    return this.sqlite
      .prepare(
        `SELECT source_id AS sourceId, field, COUNT(*) AS objects
           FROM object_field_claim
          GROUP BY source_id, field
          ORDER BY field, source_id`,
      )
      .all() as Array<{ sourceId: string; field: string; objects: number }>;
  }

  /**
   * Fields where the sources disagree for an object.
   *
   * Used to build the chosen-value explanations on `master_object`. A field with a
   * single claim is not a disagreement and is not reported.
   */
  disagreements(noradId: number): Array<{ field: string; claims: FieldClaim[] }> {
    const rows = this.sqlite
      .prepare(
        `SELECT field, source_id AS sourceId, value_num AS valueNum, value_text AS valueText, unit,
                source_field AS sourceField, observed_at AS observedAt
           FROM object_field_claim WHERE norad_id = ? ORDER BY field, source_id`,
      )
      .all(noradId) as Array<Omit<FieldClaim, "noradId"> & { sourceId: string }>;

    const byField = new Map<string, FieldClaim[]>();
    for (const r of rows) {
      const list = byField.get(r.field) ?? [];
      list.push({ ...r, noradId });
      byField.set(r.field, list);
    }

    const out: Array<{ field: string; claims: FieldClaim[] }> = [];
    for (const [field, claims] of byField) {
      if (claims.length < 2) continue;
      const values = new Set(claims.map((c) => `${c.valueNum}|${c.valueText}`));
      if (values.size > 1) out.push({ field, claims });
    }
    return out;
  }
}

/** Empty table, ready for a rebuild. */
export function resetClaims(sqlite: Database.Database): void {
  sqlite.exec(PROVENANCE_DDL);
  sqlite.prepare("DELETE FROM object_field_claim").run();
}
