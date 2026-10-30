/**
 * Supplementary claims gathered from outside the three catalogues.
 *
 * ## The rule this layer exists to enforce
 *
 * Every number in the catalogue must be attributable. Space-Track, Spacebook and
 * DISCOS satisfy that: they are official catalogues with fixed files that can be
 * re-downloaded and diffed. A value scraped from a web page does not, and mixing
 * the two in one table would make "the US Space Force records 260 kg" and "a blog
 * said 260 kg" indistinguishable.
 *
 * So a supplement is never a value on its own. It is a *claim*: a value, the page
 * it came from, the sentence that supports it, and how many independent sources
 * agree. Nothing here is trusted until a person confirms it.
 *
 * ## Why `quote` is mandatory
 *
 * Without the supporting sentence, a claim cannot be reviewed — the reviewer has
 * to re-do the search to find out what the model was looking at. Requiring the
 * quote also removes most of the incentive to hallucinate: a fabricated value has
 * no sentence to quote, and a fabricated sentence is checkable in one click.
 *
 * ## Why grade C is rejected rather than stored
 *
 * Storing a rejected claim and filtering it later means every downstream query has
 * to remember the filter. Rejecting at insert time makes the table's contract
 * simple: everything in it is at least plausible.
 */

import type Database from "better-sqlite3";

/** Source classes, in descending order of weight. */
export const SOURCE_TYPES = [
  "agency", // NASA, ESA, CNSA, JAXA — a space agency publishing its own mission
  "official", // manufacturer's own product page or press release
  "fcc", // FCC / ITU filings — the legal record of what was launched
  "press", // SpaceNews, Spaceflight Now — trade press with named sources
  "encyclopedia", // Wikipedia and similar, only with its own citations
  "paper", // peer-reviewed or conference paper
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * Grade A: a first-party document.
 * Grade B: a second-party report that names its source.
 * Grade C: anything else — rejected at insert.
 */
export type SourceGrade = "A" | "B" | "C";

const GRADE_BY_TYPE: Record<SourceType, SourceGrade> = {
  agency: "A",
  official: "A",
  fcc: "A",
  press: "B",
  encyclopedia: "B",
  paper: "B",
};

export interface SupplementClaim {
  noradId: number | null;
  cosparId: string | null;
  objectName: string | null;
  field: string;
  valueNum: number | null;
  valueText: string | null;
  unit: string | null;
  sourceUrl: string;
  sourceType: SourceType;
  /** Credit line the site's terms require. Stored, not recomputed at render time. */
  attribution?: string | null;
  quote: string;
  evidenceCount: number;
  corroboration: string[];
  confidence: number;
  note: string | null;
}

export interface Rejected {
  claim: SupplementClaim;
  reason: string;
}

export const SUPPLEMENT_DDL = `
CREATE TABLE IF NOT EXISTS supplement_claim (
  id              TEXT PRIMARY KEY,
  norad_id        INTEGER,
  cospar_id       TEXT,
  object_name     TEXT,
  field           TEXT NOT NULL,
  value_num       REAL,
  value_text      TEXT,
  unit            TEXT,
  source_url      TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  source_grade    TEXT NOT NULL,
  attribution     TEXT,
  quote           TEXT NOT NULL,
  retrieved_at    TEXT NOT NULL,
  evidence_count  INTEGER NOT NULL DEFAULT 1,
  corroboration   TEXT,
  confidence      REAL NOT NULL,
  verified        INTEGER NOT NULL DEFAULT 0,
  verifier        TEXT,
  note            TEXT
);
CREATE INDEX IF NOT EXISTS supplement_norad_idx ON supplement_claim(norad_id);
CREATE INDEX IF NOT EXISTS supplement_field_idx ON supplement_claim(field);
CREATE INDEX IF NOT EXISTS supplement_verified_idx ON supplement_claim(verified);
`;

/** Longest a `quote` may be; the point is a supporting sentence, not the page. */
const MAX_QUOTE = 2000;
/** Shortest a `quote` may be and still plausibly contain evidence. */
const MIN_QUOTE = 20;

/**
 * Validate a claim before it can be stored.
 *
 * Returns the reason it was rejected, or null when it is acceptable. Deliberately
 * strict: a claim that fails here is dropped, never "fixed up", because a
 * repaired claim no longer reflects what the source said.
 */
export function validateClaim(claim: SupplementClaim): string | null {
  if (!SOURCE_TYPES.includes(claim.sourceType)) {
    return `未知来源类型：${claim.sourceType}`;
  }
  if (GRADE_BY_TYPE[claim.sourceType] === "C") {
    return "C 级来源一律不收";
  }
  if (claim.noradId === null && claim.cosparId === null) {
    return "既无 NORAD 也无 COSPAR，无法定位对象";
  }
  if (!claim.sourceUrl || !/^https?:\/\//.test(claim.sourceUrl)) {
    return "缺少可复核的来源 URL";
  }
  const quote = claim.quote.trim();
  if (quote.length < MIN_QUOTE) {
    return `原文摘录过短（${quote.length} < ${MIN_QUOTE}）`;
  }
  if (quote.length > MAX_QUOTE) {
    return `原文摘录过长（${quote.length} > ${MAX_QUOTE}）`;
  }
  if (claim.valueNum === null && (claim.valueText === null || claim.valueText.trim() === "")) {
    return "没有值";
  }
  if (claim.valueNum !== null && !Number.isFinite(claim.valueNum)) {
    return "数值不是有限数";
  }
  if (claim.confidence < 0 || claim.confidence > 1) {
    return "confidence 必须在 0..1";
  }
  return null;
}

/**
 * Score how much to trust a claim.
 *
 * Three things move the number: how authoritative the source class is, whether a
 * second independent source agrees, and — the smallest factor — how clearly the
 * quote states the value rather than implying it. The result is a *prior* for the
 * reviewer, not a decision: nothing is promoted on confidence alone.
 */
export function scoreConfidence(claim: {
  sourceType: SourceType;
  evidenceCount: number;
  quote: string;
}): number {
  const base = GRADE_BY_TYPE[claim.sourceType] === "A" ? 0.75 : 0.5;
  // Each additional independent source adds up to 0.15, capped at two extras.
  const corroboration = Math.min(Math.max(claim.evidenceCount - 1, 0), 2) * 0.075;
  // A quote that names the field's subject is stronger than one that only implies it.
  const explicit = /\d/.test(claim.quote) ? 0.1 : 0;
  return Math.min(base + corroboration + explicit, 0.99);
}

export class SupplementStore {
  private readonly insert: Database.Statement;

  constructor(private readonly sqlite: Database.Database) {
    this.sqlite.exec(SUPPLEMENT_DDL);
    this.insert = sqlite.prepare(
      `INSERT INTO supplement_claim
         (id, norad_id, cospar_id, object_name, field, value_num, value_text, unit,
          source_url, source_type, source_grade, attribution, quote, retrieved_at,
          evidence_count, corroboration, confidence, verified, verifier, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
    );
  }

  /**
   * Store claims, dropping the ones that fail validation.
   *
   * Rejections are returned rather than thrown: a crawl will always produce some
   * unusable rows, and the caller should report how many and why instead of
   * aborting a run that otherwise succeeded.
   */
  add(claims: SupplementClaim[]): { stored: number; rejected: Rejected[] } {
    const rejected: Rejected[] = [];
    let stored = 0;
    const now = new Date().toISOString();

    const tx = this.sqlite.transaction(() => {
      for (const claim of claims) {
        const reason = validateClaim(claim);
        if (reason) {
          rejected.push({ claim, reason });
          continue;
        }
        const grade = GRADE_BY_TYPE[claim.sourceType];
        const confidence = claim.confidence > 0 ? claim.confidence : scoreConfidence(claim);
        this.insert.run(
          crypto.randomUUID(),
          claim.noradId,
          claim.cosparId,
          claim.objectName,
          claim.field,
          claim.valueNum,
          claim.valueText,
          claim.unit,
          claim.sourceUrl,
          claim.sourceType,
          grade,
          claim.attribution ?? null,
          claim.quote.trim(),
          now,
          claim.evidenceCount,
          claim.corroboration.length ? JSON.stringify(claim.corroboration) : null,
          confidence,
          claim.note,
        );
        stored += 1;
      }
    });
    tx();

    return { stored, rejected };
  }

  /** Claims awaiting review, newest first. */
  pending(limit = 200): Array<Record<string, unknown>> {
    return this.sqlite
      .prepare(
        `SELECT * FROM supplement_claim WHERE verified = 0
          ORDER BY confidence DESC, retrieved_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
  }

  /**
   * Confirm or reject one claim.
   *
   * `verified = 1` records that a person checked the cited page and found the
   * quoted sentence there. It is not a judgement that the value is true — only
   * that the source says it, which is all the catalogue ever claims.
   */
  review(id: string, verified: boolean, verifier: string, note?: string): void {
    this.sqlite
      .prepare(
        `UPDATE supplement_claim SET verified = ?, verifier = ?, note = COALESCE(?, note)
          WHERE id = ?`,
      )
      .run(verified ? 1 : -1, verifier, note ?? null, id);
  }

  /** Confirmed values for one object, keyed by field. */
  confirmedFor(noradId: number): Map<string, Array<Record<string, unknown>>> {
    const rows = this.sqlite
      .prepare(
        `SELECT field, value_num AS valueNum, value_text AS valueText, unit,
                source_url AS sourceUrl, source_grade AS sourceGrade, attribution,
                quote, confidence, evidence_count AS evidenceCount
           FROM supplement_claim WHERE norad_id = ? AND verified = 1
          ORDER BY field, confidence DESC`,
      )
      .all(noradId) as Array<{ field: string } & Record<string, unknown>>;

    const out = new Map<string, Array<Record<string, unknown>>>();
    for (const r of rows) {
      const list = out.get(r.field) ?? [];
      list.push(r);
      out.set(r.field, list);
    }
    return out;
  }

  /** Counts by review state, for the build report. */
  summary(): { pending: number; confirmed: number; rejected: number; byField: Array<{ field: string; n: number; confirmed: number }> } {
    const states = this.sqlite
      .prepare(
        `SELECT
           SUM(CASE WHEN verified = 0 THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS confirmed,
           SUM(CASE WHEN verified = -1 THEN 1 ELSE 0 END) AS rejected
         FROM supplement_claim`,
      )
      .get() as { pending: number | null; confirmed: number | null; rejected: number | null };

    const byField = this.sqlite
      .prepare(
        `SELECT field, COUNT(*) AS n,
                SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS confirmed
           FROM supplement_claim GROUP BY field ORDER BY n DESC`,
      )
      .all() as Array<{ field: string; n: number; confirmed: number }>;

    return {
      pending: states.pending ?? 0,
      confirmed: states.confirmed ?? 0,
      rejected: states.rejected ?? 0,
      byField,
    };
  }
}
