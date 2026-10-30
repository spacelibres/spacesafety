/**
 * Build the unified database from the source-specific tables.
 *
 * ## The one rule
 *
 * **Observations and computations never share a table.** A consumer must be able
 * to ask "is this a fact or is this our arithmetic?" and answer it by looking at
 * the table name alone. Three layers, one per table:
 *
 *   `master_object`       L1  merged observations
 *   `master_element_set`  L1  which source's orbit is canonical (a selection)
 *   `derived_state`       L2  numbers we computed
 *   `master_conflict`     L3  where the sources disagree and no rule decided
 *
 * ## Why each merge rule is what it is
 *
 * Every precedence below was measured before it was written (`docs/ANALYSIS.md`);
 * none is a preference.
 *
 * **Name** — from SATCAT / `entity-tle`, the operator-facing short form.
 * 66 436 of 71 175 objects have a different DISCOS name, and the difference is a
 * display variant, not an identity: `ONEWEB-0012` vs `OneWeb 0012`, and
 * `CALSPHERE 4(A)` vs `Calsphere 4`. DISCOS's form is kept in `alias_names`, which
 * is what makes `OneWeb-0010 (ChusigSat)` findable without renaming the object.
 *
 * **Object class** — from DISCOS, which has 10 classes against SATCAT's 3.
 * The finer source is also the more correct one: 988 objects SATCAT records as
 * UNKNOWN are a known Payload in DISCOS, and 606 SATCAT calls DEBRIS are Payloads.
 * That distinction decides manoeuvrability, so getting it from the coarse source
 * would mark a working satellite as unable to move.
 *
 * **Mass and cross-section** — DISCOS only. No other source has them at all.
 *
 * **Manoeuvrability** — one rule, applied once and stored: a payload can move, a
 * rocket body, debris or unknown cannot. Storing the result rather than re-deriving
 * it means two consumers cannot disagree about what the rule says.
 *
 * ## What is deliberately *not* merged
 *
 * Conflicting values are written to `master_conflict` and left unresolved. The
 * alternative — pick the fresher source — hides the fact that the sources disagree,
 * and for inclination a 15° split (SKYNET 4F) is not a staleness artefact.
 */

import type Database from "better-sqlite3";

import { trajectorySources } from "./registry";

export interface MergeOptions {
  /** Inclination difference, degrees, beyond which a conflict is recorded. */
  inclinationToleranceDeg?: number;
  /** Bias term, days, beyond which two sources disagree about decay. */
  decayToleranceDays?: number;
  log?: (line: string) => void;
}

export interface MergeSummary {
  /** Objects present in at least one identity source. */
  universe: number;
  /** Rows written to `master_object`. */
  objects: number;
  /** With a canonical element set selected. */
  withElements: number;
  /** With a usable mass. */
  withMass: number;
  /** With a usable cross-section. */
  withCrossSection: number;
  /** Conflicts recorded this run. */
  conflicts: number;
  /** Broken down by field. */
  conflictsByField: Record<string, number>;
  /** Element sets selected, by source. */
  bySource: Record<string, number>;
  ms: number;
}

/** One row of the comparison basis, as the merge sees it. */
interface SourceView {
  noradId: number;
  satcat?: {
    name: string;
    objectType: string | null;
    owner: string | null;
    launchDate: string | null;
    decayDate: string | null;
    status: string | null;
    inclination: number | null;
    covarianceStart: string | null;
    covarianceStop: string | null;
    entityId: string | null;
  };
  discos?: {
    name: string | null;
    objectClass: string | null;
    mass: number | null;
    xSectAvg: number | null;
    xSectMax: number | null;
    xSectMin: number | null;
    shape: string | null;
    cosparId: string | null;
    firstEpoch: string | null;
    predDecayDate: string | null;
  };
  /**
   * Where this NORAD appears, and the element set to consider for each.
   *
   * `inclination` is carried here so the merge can compare the catalogue's value
   * against what the orbit source actually says, without a second query.
   */
  elements: Array<{
    sourceId: string;
    trajectoryId: string;
    epoch: string | null;
    arcHours: number | null;
    inclination?: number | null;
    /** `ocm` | `itc` | `tle` — decides which registry id an operator row is. */
    fileFormat?: string | null;
  }>;
}

export class MasterMerge {
  private readonly sqlite: Database.Database;
  private readonly options: Required<Omit<MergeOptions, "log">> & { log: (line: string) => void };

  constructor(sqlite: Database.Database, options: MergeOptions = {}) {
    this.sqlite = sqlite;
    this.options = {
      inclinationToleranceDeg: options.inclinationToleranceDeg ?? 0.5,
      decayToleranceDays: options.decayToleranceDays ?? 30,
      log: options.log ?? ((line) => console.log(line)),
    };
  }

  run(): MergeSummary {
    const started = Date.now();
    const now = new Date().toISOString();
    const summary: MergeSummary = {
      universe: 0,
      objects: 0,
      withElements: 0,
      withMass: 0,
      withCrossSection: 0,
      conflicts: 0,
      conflictsByField: {},
      bySource: {},
      ms: 0,
    };

    // The universe is the union of every identity source, not of `objects`: an
    // object DISCOS knows but no element set covers is still part of the
    // catalogue and must not vanish from the master table.
    const universe = new Set<number>();
    for (const table of ["satcat", "discos_objects", "objects"]) {
      const rows = this.sqlite
        .prepare(`SELECT DISTINCT norad_id AS n FROM ${table} WHERE norad_id IS NOT NULL`)
        .all() as Array<{ n: number }>;
      for (const r of rows) universe.add(r.n);
    }
    summary.universe = universe.size;

    const satcatStmt = this.sqlite.prepare(
      `SELECT name, object_type AS objectType, owner, launch_date AS launchDate,
              decay_date AS decayDate, status, inclination,
              covariance_start AS covarianceStart, covariance_stop AS covarianceStop,
              entity_id AS entityId
         FROM satcat WHERE norad_id = ?`,
    );
    const discosStmt = this.sqlite.prepare(
      `SELECT name, object_class AS objectClass, mass, x_sect_avg AS xSectAvg,
              x_sect_max AS xSectMax, x_sect_min AS xSectMin, shape,
              cospar_id AS cosparId, first_epoch AS firstEpoch,
              pred_decay_date AS predDecayDate
         FROM discos_objects WHERE norad_id = ? LIMIT 1`,
    );
    const elementStmt = this.sqlite.prepare(
      `SELECT t.state_source AS sourceId, t.id AS trajectoryId, t.start_at AS epoch,
              (julianday(t.end_at) - julianday(t.start_at)) * 24 AS arcHours,
              t.file_format AS fileFormat,
              (SELECT o2.inclination FROM object_sources o2
                WHERE o2.norad_id = ? AND o2.source_id = t.state_source LIMIT 1) AS inclination
         FROM trajectories t JOIN objects o ON o.id = t.object_id
        WHERE o.norad_id = ?`,
    );

    const insertObject = this.sqlite.prepare(
      `INSERT INTO master_object
         (norad_id, name, alias_names, cospar_id, object_class, satcat_type, owner,
          launch_date, decay_date, mass_kg, cross_section_avg_m2, cross_section_max_m2,
          cross_section_min_m2, shape, status, maneuverable, sources, source_count,
          covariance_start, covariance_stop, merged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertElement = this.sqlite.prepare(
      `INSERT INTO master_element_set
         (norad_id, source_id, trajectory_id, epoch, arc_hours, sigma_km, alternatives, selected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertConflict = this.sqlite.prepare(
      `INSERT INTO master_conflict
         (id, norad_id, field, claims_json, chosen_value, resolution, reason, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.sqlite.transaction(() => {
      // A full rebuild, not an incremental patch: the merge is a pure function of
      // the source tables, and a partial update would keep stale rows from a
      // source that has since dropped an object.
      this.sqlite.prepare("DELETE FROM master_object").run();
      this.sqlite.prepare("DELETE FROM master_element_set").run();
      this.sqlite.prepare("DELETE FROM master_conflict").run();

      for (const noradId of universe) {
        const view: SourceView = {
          noradId,
          satcat: satcatStmt.get(noradId) as SourceView["satcat"],
          discos: discosStmt.get(noradId) as SourceView["discos"],
          elements: elementStmt.all(noradId, noradId) as SourceView["elements"],
        };

        const merged = mergeIdentity(view, this.options);
        insertObject.run(
          noradId,
          merged.name,
          merged.aliasNames,
          merged.cosparId,
          merged.objectClass,
          merged.satcatType,
          merged.owner,
          merged.launchDate,
          merged.decayDate,
          merged.massKg,
          merged.crossSectionAvgM2,
          merged.crossSectionMaxM2,
          merged.crossSectionMinM2,
          merged.shape,
          merged.status,
          merged.maneuverable ? 1 : 0,
          merged.sources,
          merged.sourceCount,
          merged.covarianceStart,
          merged.covarianceStop,
          now,
        );
        summary.objects += 1;
        if (merged.massKg !== null) summary.withMass += 1;
        if (merged.crossSectionAvgM2 !== null) summary.withCrossSection += 1;

        for (const conflict of merged.conflicts) {
          insertConflict.run(
            crypto.randomUUID(),
            noradId,
            conflict.field,
            JSON.stringify(conflict.claims),
            conflict.chosen,
            conflict.resolution,
            conflict.reason,
            now,
          );
          summary.conflicts += 1;
          summary.conflictsByField[conflict.field] =
            (summary.conflictsByField[conflict.field] ?? 0) + 1;
        }

        // Element selection: the highest-priority source that actually holds one.
        //
        // Operator ephemerides are stored under `state_source =
        // 'operator_ephemeris'` with the real identity in `file_format` (`ocm` or
        // `itc`), while the registry names them `starlink-ocm` / `starlink-itc`.
        // Matching on `state_source` alone therefore found no OCM at all, and every
        // Starlink silently fell back to its single-epoch TLE — the exact
        // inversion of the intended policy. The mapping below is the fix.
        const canonicalId = (e: SourceView["elements"][number]): string =>
          e.sourceId === "operator_ephemeris"
            ? e.fileFormat === "itc"
              ? "starlink-itc"
              : "starlink-ocm"
            : e.sourceId;

        const byCanonical = new Map<string, SourceView["elements"][number]>();
        for (const e of view.elements) {
          const id = canonicalId(e);
          // Prefer the OCM over an ITC when both exist, and never let a later row
          // overwrite a better one for the same canonical source.
          if (!byCanonical.has(id)) byCanonical.set(id, e);
        }

        const ordered = trajectorySources().filter((s) => byCanonical.has(s.id));
        const winner = ordered[0];
        if (winner) {
          const chosen = byCanonical.get(winner.id)!;
          const others = ordered.slice(1).map((s) => s.id);
          insertElement.run(
            noradId,
            winner.id,
            chosen.trajectoryId,
            chosen.epoch,
            chosen.arcHours,
            null,
            others.length ? others.join(",") : null,
            now,
          );
          summary.withElements += 1;
          summary.bySource[winner.id] = (summary.bySource[winner.id] ?? 0) + 1;
        }
      }
    });

    tx();

    summary.ms = Date.now() - started;
    return summary;
  }
}

/** Round to `digits`, for values that go into a human-readable claim. */
function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

interface MergedIdentity {
  name: string;
  aliasNames: string | null;
  cosparId: string | null;
  objectClass: string | null;
  satcatType: string | null;
  owner: string | null;
  launchDate: string | null;
  decayDate: string | null;
  massKg: number | null;
  crossSectionAvgM2: number | null;
  crossSectionMaxM2: number | null;
  crossSectionMinM2: number | null;
  shape: string | null;
  status: string | null;
  maneuverable: boolean;
  sources: string;
  sourceCount: number;
  covarianceStart: string | null;
  covarianceStop: string | null;
  conflicts: Array<{
    field: string;
    claims: Record<string, string | number | null>;
    chosen: string | null;
    resolution: string;
    reason: string;
  }>;
}

/**
 * Merge one object's fields. Pure, so the rules can be tested without a database.
 */
export function mergeIdentity(
  view: SourceView,
  options: { inclinationToleranceDeg: number } = { inclinationToleranceDeg: 0.5 },
): MergedIdentity {
  const conflicts: MergedIdentity["conflicts"] = [];
  const sources: string[] = [];
  if (view.satcat) sources.push("satcat");
  if (view.discos) sources.push("discos");
  if (view.elements.length) sources.push("elements");

  // Name precedence: the operator-facing short form.
  const satcatName = view.satcat?.name?.trim() || null;
  const discosName = view.discos?.name?.trim() || null;
  const name = satcatName ?? discosName ?? `NORAD-${view.noradId}`;

  // Keep the other form as an alias, and only when it says something different.
  const aliasNames =
    satcatName && discosName && satcatName.toUpperCase() !== discosName.toUpperCase()
      ? discosName
      : null;

  // Object class: DISCOS wins on granularity and on correctness.
  const objectClass = view.discos?.objectClass ?? view.satcat?.objectType ?? null;
  const satcatType = view.satcat?.objectType ?? null;

  // One stored manoeuvrability rule.
  const cls = (objectClass ?? "").toLowerCase();
  const maneuverable = cls === "payload";

  // Decay date: SATCAT is the catalogue authority; DISCOS's `predDecayDate` is a
  // *prediction*, so the two are only in conflict when both claim an actual decay
  // and those differ beyond tolerance.
  const satcatDecay = view.satcat?.decayDate ?? null;
  const decayDate = satcatDecay;

  if (view.discos?.predDecayDate && satcatDecay) {
    const a = Date.parse(satcatDecay);
    const b = Date.parse(view.discos.predDecayDate);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const days = Math.abs(a - b) / 86_400_000;
      // DISCOS's `predDecayDate` is a *prediction* made in advance; SATCAT records
      // the observed re-entry. Measured on 306 objects where both exist, the two
      // differ by 1–2 days in the vast majority — that is the normal skill of a
      // decay prediction, not a data conflict. The threshold is therefore 7 days:
      // beyond that the two are describing different events, not one event with
      // forecast error.
      if (days > 7) {
        conflicts.push({
          field: "decay-date",
          claims: { satcat: satcatDecay, discosPredicted: view.discos.predDecayDate },
          chosen: satcatDecay,
          resolution: "undecidable",
          reason:
            `SATCAT 实际衰降与 DISCOS 的预测相差 ${days.toFixed(0)} 天，` +
            `超出预测误差可解释的范围（7 天），需核查`,
        });
      }
    }
  }

  // Inclination: SATCAT states a value taken from the catalogue; the element-set
  // sources state their own. Measured: 1 102 comparable objects agree to 0.02° on
  // average, with 4 beyond 0.1° and one (SKYNET 4F) 15° apart. A 15° difference
  // is not staleness, so it is recorded rather than resolved.
  const elementInclination = view.elements.find((e) => e.inclination !== undefined)?.inclination;
  if (
    view.satcat?.inclination !== null &&
    view.satcat?.inclination !== undefined &&
    elementInclination !== null &&
    elementInclination !== undefined
  ) {
    const diff = Math.abs(view.satcat.inclination - elementInclination);
    if (diff > options.inclinationToleranceDeg) {
      conflicts.push({
        field: "inclination",
        claims: {
          satcat: round(view.satcat.inclination, 4),
          elementSet: round(elementInclination, 4),
        },
        chosen: null,
        resolution: "undecidable",
        reason:
          `倾角相差 ${diff.toFixed(3)}°，超过容差 ${options.inclinationToleranceDeg}°；` +
          `无法用陈旧解释，需人工核查（编号错配？机动？）`,
      });
    }
  }

  return {
    name,
    aliasNames,
    cosparId: view.discos?.cosparId ?? null,
    objectClass,
    satcatType,
    owner: view.satcat?.owner ?? null,
    launchDate: view.satcat?.launchDate ?? view.discos?.firstEpoch ?? null,
    decayDate,
    massKg: view.discos?.mass ?? null,
    crossSectionAvgM2: view.discos?.xSectAvg ?? null,
    crossSectionMaxM2: view.discos?.xSectMax ?? null,
    crossSectionMinM2: view.discos?.xSectMin ?? null,
    shape: view.discos?.shape ?? null,
    status: view.satcat?.status ?? null,
    maneuverable,
    sources: sources.join(","),
    sourceCount: sources.length,
    covarianceStart: view.satcat?.covarianceStart ?? null,
    covarianceStop: view.satcat?.covarianceStop ?? null,
    conflicts,
  };
}
