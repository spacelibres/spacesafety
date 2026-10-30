/**
 * Build the unified database from the source-specific tables.
 *
 * ## The layering
 *
 * **Observations and computations never share a table.** A consumer must be able
 * to ask "is this a fact or is this our arithmetic?" and answer it by looking at
 * the table name alone:
 *
 *   `object_field_claim`  L0  every value every source gave, chosen or not
 *   `master_object`       L1  merged observations, with `value_sources` naming each origin
 *   `master_element_set`  L1  which source's orbit is canonical (a selection)
 *   `derived_state`       L2  numbers we computed
 *   `master_conflict`     L3  where the sources disagree and no rule decided
 *
 * ## Why the losers are kept
 *
 * Space-Track is the US reference catalogue, DISCOSweb is ESA's, Spacebook carries
 * ComSpoc/AGI-STK's model. They disagree on 4 834 inclinations and 9 680 object
 * classes. Neither disagreement is a data error to be resolved — it is three
 * authoritative bodies saying different things, and an operator disputing one of
 * our numbers must be able to see what the others said.
 *
 * L0 exists because the earlier merge did not keep them: `master_conflict` held the
 * losers, but only for the 54 objects where a rule raised a flag, so 4 833 of the
 * 4 834 inclination disagreements were discarded. Now every claim is stored, and
 * `master_object.value_sources` records which one we chose and why.
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
 * **Mass and cross-section** — DISCOS first, because its mass is instrumented
 * rather than adopted, then Spacebook's ComSpoc model, which covers 99.82% against
 * DISCOS' 53.97%. Measured: the two agree within 1% on 99.93% of the 38 426 objects
 * both carry, so the choice rarely matters — but it is recorded either way.
 *
 * **Hard-body radius** — Spacebook only. It is the sole source that publishes one,
 * and an RCS class band is not a radius: measured, a band estimate is 4.4× too large
 * for a Starlink and 14.6× too small for the ISS.
 *
 * **Catalogue orbit summary** (period, inclination, apogee, perigee) — Space-Track
 * only. GCAT's inclination disagrees with it on 4 834 objects, mostly 1960s
 * satellites, and GCAT records the orbit at launch while Space-Track tracks the
 * current one. Comparing them as equals produces noise, not information.
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
import { isManoeuvrable, normaliseClass } from "./class-normalise";

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
  /** Objects with a hard-body radius, the Pc geometric input. */
  withHardBodyRadius: number;
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
    launchSite: string | null;
    decayDate: string | null;
    status: string | null;
    inclination: number | null;
    period: number | null;
    apogee: number | null;
    perigee: number | null;
    rcsSize: string | null;
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
  /** Space-Track's satellite catalogue: the 100%-complete identity source. */
  spaceTrack?: {
    intlDes: string | null;
    country: string | null;
    site: string | null;
    launch: string | null;
    decay: string | null;
    satName: string | null;
    objectType: string | null;
    periodMin: number | null;
    inclinationDeg: number | null;
    apogeeKm: number | null;
    perigeeKm: number | null;
    rcsSize: string | null;
    current: string | null;
  };
  /**
   * The COMSPOC-derived physical model (Spacebook satcat-details).
   *
   * This is the highest-coverage physical source in the catalogue — 71 074 of
   * 72 311 objects, 99.98% — and it is the only one that carries a hard-body
   * radius. `massKg` and `crossSectionAvgM2` below are the DISCOS values; when
   * both exist the merge prefers this table, because DISCOS' mass covers only
   * half the catalogue and its cross-section is an average rather than a median.
   */
  physics?: {
    massKg: number | null;
    spanM: number | null;
    diameterM: number | null;
    hbrMeanM: number | null;
    ballisticCoefficient: number | null;
    crossSectionMedianM2: number | null;
    shapeNumber: number | null;
  };
  /** McDowell launch info: manufacturer, bus, dry mass, dimensions, orbit class. */
  launch?: {
    manufacturer: string | null;
    bus: string | null;
    dryMassKg: number | null;
    lengthM: number | null;
    diameterM: number | null;
    spanM: number | null;
    shape: string | null;
    orbitType: string | null;
    motor: string | null;
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
      withHardBodyRadius: 0,
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
              launch_site AS launchSite, decay_date AS decayDate, status, inclination,
              period, apogee, perigee, rcs_size AS rcsSize,
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
    // The third identity source. It is the only one that covers 100% of its own
    // records for COSPAR, country and launch site, and the only one with a
    // catalogue orbit summary; until now it was downloaded but never merged.
    const spaceTrackStmt = this.sqlite.prepare(
      `SELECT intl_des AS intlDes, country, site, launch, decay, sat_name AS satName,
              object_type AS objectType, period_min AS periodMin,
              inclination_deg AS inclinationDeg, apogee_km AS apogeeKm,
              perigee_km AS perigeeKm, rcs_size AS rcsSize, current
         FROM space_track_satcat WHERE norad_id = ?`,
    );
    // The physical model and the McDowell launch record are stored in their own
    // tables, and until now the merge never read them: 32 648 objects had a mass
    // in `object_physics` and no mass in the master table. They are queried here so
    // the merged object carries the best physical data the catalogue has.
    const physicsStmt = this.sqlite.prepare(
      `SELECT adopted_mass_kg AS massKg, adopted_span_m AS spanM,
              adopted_diameter_m AS diameterM, hbr_mean_m AS hbrMeanM,
              ballistic_coefficient AS ballisticCoefficient,
              cross_section_median_m2 AS crossSectionMedianM2,
              shape_number AS shapeNumber
         FROM object_physics WHERE norad_id = ?`,
    );
    const launchStmt = this.sqlite.prepare(
      `SELECT manufacturer, bus, dry_mass_kg AS dryMassKg, length_m AS lengthM,
              diameter_m AS diameterM, span_m AS spanM, shape,
              orbit_type AS orbitType, motor
         FROM object_launch_info WHERE norad_id = ? LIMIT 1`,
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
          cross_section_min_m2, shape, status, country, launch_site,
          catalog_period_min, catalog_inclination_deg, catalog_apogee_km,
          catalog_perigee_km, rcs_size, current, maneuverable, sources, source_count,
          covariance_start, covariance_stop,
          hard_body_radius_m, span_m, diameter_m, dry_mass_kg, length_m,
          ballistic_coefficient, shape_number, manufacturer, bus, orbit_type, motor,
          value_sources, merged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      this.sqlite.prepare("DELETE FROM object_field_claim").run();

      const insertClaim = this.sqlite.prepare(
        `INSERT OR REPLACE INTO object_field_claim
           (norad_id, field, source_id, value_num, value_text, unit, source_field, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const noradId of universe) {
        const view: SourceView = {
          noradId,
          satcat: satcatStmt.get(noradId) as SourceView["satcat"],
          discos: discosStmt.get(noradId) as SourceView["discos"],
          spaceTrack: spaceTrackStmt.get(noradId) as SourceView["spaceTrack"],
          physics: physicsStmt.get(noradId) as SourceView["physics"],
          launch: launchStmt.get(noradId) as SourceView["launch"],
          elements: elementStmt.all(noradId, noradId) as SourceView["elements"],
        };

        // L0: every value every source gave. Written before the merge so that a
        // merge rule change can never lose a value again.
        for (const c of collectClaims(view)) {
          insertClaim.run(
            noradId,
            c.field,
            c.sourceId,
            c.valueNum,
            c.valueText,
            c.unit,
            c.sourceField,
            now,
          );
        }

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
          merged.country,
          merged.launchSite,
          merged.catalogPeriodMin,
          merged.catalogInclinationDeg,
          merged.catalogApogeeKm,
          merged.catalogPerigeeKm,
          merged.rcsSize,
          merged.current === null ? null : merged.current ? 1 : 0,
          merged.maneuverable ? 1 : 0,
          merged.sources,
          merged.sourceCount,
          merged.covarianceStart,
          merged.covarianceStop,
          merged.hardBodyRadiusM,
          merged.spanM,
          merged.diameterM,
          merged.dryMassKg,
          merged.lengthM,
          merged.ballisticCoefficient,
          merged.shapeNumber,
          merged.manufacturer,
          merged.bus,
          merged.orbitType,
          merged.motor,
          JSON.stringify(valueSources(view)),
          now,
        );
        summary.objects += 1;
        if (merged.massKg !== null) summary.withMass += 1;
        if (merged.crossSectionAvgM2 !== null) summary.withCrossSection += 1;
        if (merged.hardBodyRadiusM !== null) summary.withHardBodyRadius += 1;

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

/**
 * A physical quantity, or `null` when it is absent or meaningless.
 *
 * The source CSVs use `0` for "not known" on some columns and `NaN` on others, and
 * a mass of zero would make a Pc calculation divide by zero downstream.
 */
function positive(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

interface MergedIdentity {
  name: string;
  aliasNames: string | null;
  cosparId: string | null;
  objectClass: string | null;
  satcatType: string | null;
  owner: string | null;
  launchDate: string | null;
  /** ISO country code of the launching state, e.g. `US`. */
  country: string | null;
  /** Launch site code, e.g. `AFETR`. */
  launchSite: string | null;
  /** Catalogue orbit summary — a separate quantity from the derived values. */
  catalogPeriodMin: number | null;
  catalogInclinationDeg: number | null;
  catalogApogeeKm: number | null;
  catalogPerigeeKm: number | null;
  rcsSize: string | null;
  current: boolean | null;
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
  hardBodyRadiusM: number | null;
  spanM: number | null;
  diameterM: number | null;
  dryMassKg: number | null;
  lengthM: number | null;
  ballisticCoefficient: number | null;
  shapeNumber: number | null;
  manufacturer: string | null;
  bus: string | null;
  orbitType: string | null;
  motor: string | null;
  conflicts: Array<{
    field: string;
    claims: Record<string, string | number | null>;
    chosen: string | null;
    resolution: string;
    reason: string;
  }>;
}

/**
 * Every value each source gave for one object, in canonical field names.
 *
 * This is what makes the merge reversible. The merged row keeps the winner; this
 * keeps all three, so "Space-Track says 47.86° and GCAT says 38.71°" stays
 * answerable rather than being reduced to whichever rule fired first.
 *
 * Field names here are the **catalogue** vocabulary (`inclination_deg`,
 * `mass_kg`), not the provider's own column names — the original column is carried
 * alongside each claim in `sourceField` so it can still be traced to a file.
 */
export function collectClaims(view: SourceView): Array<{
  field: string;
  sourceId: string;
  valueNum: number | null;
  valueText: string | null;
  unit: string | null;
  sourceField: string;
}> {
  const out: ReturnType<typeof collectClaims> = [];
  const add = (
    field: string,
    sourceId: string,
    valueNum: number | null,
    valueText: string | null,
    unit: string | null,
    sourceField: string,
  ): void => {
    if (valueNum === null && (valueText === null || valueText === "")) return;
    out.push({ field, sourceId, valueNum, valueText, unit, sourceField });
  };

  const s = view.satcat;
  if (s) {
    add("name", "spacebook-satcat", null, s.name, null, "OBJECT_NAME");
    add("object_class", "spacebook-satcat", null, s.objectType, null, "OBJECT_TYPE");
    add("owner", "spacebook-satcat", null, s.owner, null, "OWNER");
    add("launch_date", "spacebook-satcat", null, s.launchDate, null, "LAUNCH_DATE");
    add("launch_site", "spacebook-satcat", null, s.launchSite, null, "LAUNCH_SITE");
    add("decay_date", "spacebook-satcat", null, s.decayDate, null, "DECAY_DATE");
    add("inclination_deg", "spacebook-satcat", s.inclination, null, "deg", "INCLINATION");
    add("catalog_period_min", "spacebook-satcat", s.period, null, "min", "PERIOD");
    add("catalog_apogee_km", "spacebook-satcat", s.apogee, null, "km", "APOGEE");
    add("catalog_perigee_km", "spacebook-satcat", s.perigee, null, "km", "PERIGEE");
    add("rcs_size", "spacebook-satcat", null, s.rcsSize, null, "RCS_SIZE");
  }

  const t = view.spaceTrack;
  if (t) {
    add("name", "space-track", null, t.satName, null, "SATNAME");
    add("cospar_id", "space-track", null, t.intlDes, null, "INTLDES");
    add("object_class", "space-track", null, t.objectType, null, "OBJECT_TYPE");
    add("country", "space-track", null, t.country, null, "COUNTRY");
    add("launch_site", "space-track", null, t.site, null, "SITE");
    add("launch_date", "space-track", null, t.launch, null, "LAUNCH");
    add("decay_date", "space-track", null, t.decay, null, "DECAY");
    add("inclination_deg", "space-track", t.inclinationDeg, null, "deg", "INCLINATION");
    add("catalog_period_min", "space-track", t.periodMin, null, "min", "PERIOD");
    add("catalog_apogee_km", "space-track", t.apogeeKm, null, "km", "APOGEE");
    add("catalog_perigee_km", "space-track", t.perigeeKm, null, "km", "PERIGEE");
    add("rcs_size", "space-track", null, t.rcsSize, null, "RCS_SIZE");
  }

  const d = view.discos;
  if (d) {
    add("name", "discos", null, d.name, null, "name");
    add("cospar_id", "discos", null, d.cosparId, null, "cosparId");
    add("object_class", "discos", null, d.objectClass, null, "objectClass");
    add("mass_kg", "discos", d.mass, null, "kg", "mass");
    add("cross_section_avg_m2", "discos", d.xSectAvg, null, "m^2", "xSectAvg");
    add("cross_section_max_m2", "discos", d.xSectMax, null, "m^2", "xSectMax");
    add("cross_section_min_m2", "discos", d.xSectMin, null, "m^2", "xSectMin");
    add("shape", "discos", null, d.shape, null, "shape");
    add("decay_date_predicted", "discos", null, d.predDecayDate, null, "predDecayDate");
  }

  // Labelled as Spacebook because that is where the file comes from; the model
  // itself is ComSpoc's, which is why the column names carry that prefix.
  const p = view.physics;
  if (p) {
    add("mass_kg", "spacebook-physics", p.massKg, null, "kg", "COMSPOC Adopted Mass (kg)");
    add("hard_body_radius_m", "spacebook-physics", p.hbrMeanM, null, "m", "COMSPOC HBR Mean (m)");
    add("cross_section_avg_m2", "spacebook-physics", p.crossSectionMedianM2, null, "m^2", "COMSPOC Cross Section Median (m^2)");
    add("span_m", "spacebook-physics", p.spanM, null, "m", "COMSPOC Adopted Span (m)");
    add("diameter_m", "spacebook-physics", p.diameterM, null, "m", "COMSPOC Adopted Diameter (m)");
    add("ballistic_coefficient", "spacebook-physics", p.ballisticCoefficient, null, null, "COMSPOC Ballistic Coefficient");
  }

  const l = view.launch;
  if (l) {
    add("manufacturer", "spacebook-launch", null, l.manufacturer, null, "GCAT Manufacturer");
    add("bus", "spacebook-launch", null, l.bus, null, "GCAT Bus");
    add("dry_mass_kg", "spacebook-launch", l.dryMassKg, null, "kg", "GCAT DryMass (kg)");
    add("length_m", "spacebook-launch", l.lengthM, null, "m", "GCAT Length (m)");
    add("orbit_type", "spacebook-launch", null, l.orbitType, null, "GCAT OrbitType");
    add("motor", "spacebook-launch", null, l.motor, null, "GCAT Motor");
  }

  return out;
}

/**
 * Which source each merged value came from.
 *
 * Relative to `collectClaims` this is the *decision* alone: `{mass_kg: "discos"}`
 * means this object's mass came from DISCOS even if Spacebook also had one. The
 * rule is re-stated here rather than inferred from the merged row, because a value
 * that happens to equal the winner does not prove where it came from.
 */
export function valueSources(view: SourceView): Record<string, string> {
  const out: Record<string, string> = {};

  if (view.satcat?.name) out.name = "spacebook-satcat";
  else if (view.spaceTrack?.satName) out.name = "space-track";
  else if (view.discos?.name) out.name = "discos";

  if (view.spaceTrack?.intlDes) out.cospar_id = "space-track";
  else if (view.discos?.cosparId) out.cospar_id = "discos";

  // DISCOS carries 10 classes against SATCAT's 3, and its finer value is the one
  // that decides manoeuvrability, so it wins where present.
  if (view.discos?.objectClass && view.discos.objectClass !== "Unknown") {
    out.object_class = "discos";
  } else if (view.spaceTrack?.objectType) out.object_class = "space-track";
  else if (view.satcat?.objectType) out.object_class = "spacebook-satcat";

  if (view.spaceTrack?.country) out.country = "space-track";
  if (view.spaceTrack?.site) out.launch_site = "space-track";
  else if (view.satcat?.launchSite) out.launch_site = "spacebook-satcat";

  if (view.spaceTrack?.decay) out.decay_date = "space-track";
  else if (view.satcat?.decayDate) out.decay_date = "spacebook-satcat";

  // DISCOS first: its mass is instrumented, Spacebook's is an adopted value.
  if (positive(view.discos?.mass)) out.mass_kg = "discos";
  else if (positive(view.physics?.massKg)) out.mass_kg = "spacebook-physics";

  if (positive(view.discos?.xSectAvg)) out.cross_section_avg_m2 = "discos";
  else if (positive(view.physics?.crossSectionMedianM2)) {
    out.cross_section_avg_m2 = "spacebook-physics";
  }

  if (positive(view.physics?.hbrMeanM)) out.hard_body_radius_m = "spacebook-physics";
  if (positive(view.physics?.ballisticCoefficient)) {
    out.ballistic_coefficient = "spacebook-physics";
  }

  if (view.discos?.shape) out.shape = "discos";
  else if (view.launch?.shape) out.shape = "spacebook-launch";

  // The catalogue orbit summary is Space-Track's. GCAT's inclination is the orbit at
  // launch and disagrees on 4 834 objects, so it never competes here.
  if (view.spaceTrack?.inclinationDeg !== null && view.spaceTrack?.inclinationDeg !== undefined) {
    out.catalog_inclination_deg = "space-track";
  }
  if (view.spaceTrack?.periodMin !== null && view.spaceTrack?.periodMin !== undefined) {
    out.catalog_period_min = "space-track";
  }

  if (view.launch?.manufacturer) out.manufacturer = "spacebook-launch";
  if (view.launch?.bus) out.bus = "spacebook-launch";
  if (view.launch?.orbitType) out.orbit_type = "spacebook-launch";

  return out;
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
  if (view.spaceTrack) sources.push("space-track");
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

  // Object class: DISCOS wins on granularity and on correctness — but not when it
  // says `Unknown` and SATCAT knows the answer. Measured: 402 objects DISCOS calls
  // Unknown are PAYLOAD in SATCAT, 165 are DEBRIS, 27 are ROCKET BODY. Taking the
  // finer source unconditionally discarded those.
  const discosClass = normaliseClass(view.discos?.objectClass);
  const satcatClass = normaliseClass(view.satcat?.objectType);
  const objectClass =
    discosClass !== "Unknown" ? discosClass : satcatClass !== "Unknown" ? satcatClass : "Unknown";
  const satcatType = view.satcat?.objectType ?? null;

  const maneuverable = isManoeuvrable(objectClass);

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
    cosparId: view.discos?.cosparId ?? view.spaceTrack?.intlDes ?? null,
    objectClass,
    satcatType,
    owner: view.satcat?.owner ?? view.spaceTrack?.country ?? null,
    // Space-Track carries a launch date for 71 198 records and is the only source
    // that does; DISCOS `firstEpoch` is first observation, not launch.
    launchDate:
      view.satcat?.launchDate ?? view.spaceTrack?.launch ?? view.discos?.firstEpoch ?? null,
    country: view.spaceTrack?.country ?? null,
    launchSite: view.satcat?.launchSite ?? view.spaceTrack?.site ?? null,
    catalogPeriodMin: view.spaceTrack?.periodMin ?? view.satcat?.period ?? null,
    catalogInclinationDeg:
      view.spaceTrack?.inclinationDeg ?? view.satcat?.inclination ?? null,
    catalogApogeeKm: view.spaceTrack?.apogeeKm ?? view.satcat?.apogee ?? null,
    catalogPerigeeKm: view.spaceTrack?.perigeeKm ?? view.satcat?.perigee ?? null,
    rcsSize: view.spaceTrack?.rcsSize ?? view.satcat?.rcsSize ?? null,
    current: view.spaceTrack?.current ? view.spaceTrack.current.toUpperCase() === "Y" : null,
    decayDate,
    // Physical model precedence.
    //
    // `object_physics` is the COMSPOC-derived model that ships with Spacebook's
    // satcat-details, and it covers 71 074 of 72 311 objects (99.98%). DISCOS is
    // the better *catalogued* source when it has a value — its mass is an
    // instrumented measurement rather than a derived adoption — but it covers
    // only half the catalogue. So: DISCOS first, physics fills the rest.
    //
    // A zero or negative mass is a parse artefact, not a mass; treat it as absent
    // rather than propagating it into Pc.
    massKg: positive(view.discos?.mass) ?? positive(view.physics?.massKg) ?? null,
    crossSectionAvgM2:
      positive(view.discos?.xSectAvg) ?? positive(view.physics?.crossSectionMedianM2) ?? null,
    crossSectionMaxM2: positive(view.discos?.xSectMax) ?? null,
    crossSectionMinM2: positive(view.discos?.xSectMin) ?? null,
    // Shape: DISCOS names it (`Payload`, `Cylinder`), McDowell records it too, and
    // the physics row carries a numeric class rather than a word.
    shape: view.discos?.shape ?? view.launch?.shape ?? null,
    status: view.satcat?.status ?? null,
    maneuverable,
    sources: sources.join(","),
    sourceCount: sources.length,
    covarianceStart: view.satcat?.covarianceStart ?? null,
    covarianceStop: view.satcat?.covarianceStop ?? null,

    // Hard-body radius is the single most important physical input to a Pc
    // calculation, and only `object_physics` has it. The catalogue's RCS class is
    // not a radius — treating it as one was the 7.8x error this table fixes.
    hardBodyRadiusM: positive(view.physics?.hbrMeanM) ?? null,
    spanM: positive(view.physics?.spanM) ?? positive(view.launch?.spanM) ?? null,
    diameterM: positive(view.physics?.diameterM) ?? positive(view.launch?.diameterM) ?? null,
    dryMassKg: positive(view.launch?.dryMassKg) ?? null,
    lengthM: positive(view.launch?.lengthM) ?? null,
    ballisticCoefficient: positive(view.physics?.ballisticCoefficient) ?? null,
    shapeNumber:
      typeof view.physics?.shapeNumber === "number" && view.physics.shapeNumber > 0
        ? view.physics.shapeNumber
        : null,
    manufacturer: view.launch?.manufacturer ?? null,
    bus: view.launch?.bus ?? null,
    orbitType: view.launch?.orbitType ?? null,
    motor: view.launch?.motor ?? null,
    conflicts,
  };
}
