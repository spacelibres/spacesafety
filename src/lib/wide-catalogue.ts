/**
 * Reading the five-source wide catalogue.
 *
 * ## Why a separate query module
 *
 * The wide table has a shape unlike anything else in the schema: every field is
 * six columns — one per source plus `__chosen` — and the field list is data, not
 * code. Writing that out into Drizzle's typed schema would produce 156
 * hand-maintained column definitions that must be kept in step with a build
 * script; reading it generically keeps the two from drifting.
 *
 * ## What a caller gets
 *
 * Not a flat row. A field the sources disagree about is only meaningful with all
 * of its claims together, so each field is returned as a small object carrying
 * every source's value and which one is currently chosen. A page can then render
 * one row per object and still show five sources per cell.
 */

import { getDb } from "@/db";
import type { MessageTable } from "@/lib/i18n/messages/en";

/**
 * A dictionary key, checked at compile time.
 *
 * The label maps below are looked up indirectly (`t.t(FIELD_LABEL_KEYS[field])`),
 * which the key-usage check in `tools/check.ts` cannot see — it reads literal
 * `t.t("…")` calls. Typing the value as a key of the reference table moves the
 * verification to the compiler, so a typo fails `tsc` instead of rendering the
 * key name into a table cell.
 */
type MessageKey = keyof MessageTable;

/** The catalogues, in the order the UI displays them. Must match the build script's SOURCES. */
export const SOURCE_IDS = [
  "spacetrack",
  "spacebook",
  "discos",
  "keeptrack",
  "sbsup",
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/**
 * Dictionary key for each source's display name.
 *
 * A key, not the text: these labels render in five places and every one of them
 * has to follow the reader's language. A `Record<SourceId, …>` rather than a list
 * so that a source added to the build script fails to compile here instead of
 * quietly disappearing from the tables.
 */
export const SOURCE_LABEL_KEYS: Record<SourceId, MessageKey> = {
  spacetrack: "catalogue.sourceSpaceTrack",
  spacebook: "catalogue.sourceSpacebook",
  discos: "catalogue.sourceDiscos",
  keeptrack: "catalogue.sourceKeepTrack",
  sbsup: "catalogue.sourceSupplemental",
};

/** Every field the wide table carries. Must match the build script's FIELDS. */
export const WIDE_FIELDS = [
  "name",
  "cospar_id",
  "object_class",
  "country",
  "launch_site",
  "launch_date",
  "decay_date",
  "inclination_deg",
  "period_min",
  "apogee_km",
  "perigee_km",
  "rcs_size",
  "mass_kg",
  "hard_body_radius_m",
  "cross_section_avg_m2",
  "cross_section_max_m2",
  "cross_section_min_m2",
  "span_m",
  "diameter_m",
  "ballistic_coefficient",
  "shape",
  "manufacturer",
  "bus",
  "orbit_type",
  "dry_mass_kg",
  "length_m",
] as const;

export type WideField = (typeof WIDE_FIELDS)[number];

/** One field of one object: what each source said, and what is in use. */
export interface FieldComparison {
  field: WideField;
  values: Record<SourceId, string | number | null>;
  chosen: SourceId | null;
  /** True when at least two sources have a value and they are not all equal. */
  disagrees: boolean;
}

export interface WideRow {
  noradId: number;
  fields: Record<WideField, FieldComparison>;
}

export interface WideListRow {
  noradId: number;
  name: string | null;
  cosparId: string | null;
  objectClass: string | null;
  country: string | null;
  massKg: number | null;
  hardBodyRadiusM: number | null;
  inclinationDeg: number | null;
  decayDate: string | null;
  /** Named fleet from `object_classification`, e.g. `Starlink`. */
  constellation: string | null;
  /** Orbit regime: LEO / MEO / GEO / HEO / UNKNOWN. */
  regime: string | null;
  /** Role group, e.g. `communication`. */
  purposeGroup: string | null;
}

export interface WideStats {
  objects: number;
  /**
   * Per field: how many objects carry a value from each source, and how many
   * carry one from at least one source.
   *
   * `union` must be computed as an OR over every source. It is *not* the largest
   * single-source count: the sources cover different objects, so `max()` silently
   * reports a fraction of what the catalogue actually holds. It did — the table
   * showed 50.4% for decay dates that 97.3% of objects have, and 17.5% for
   * diameters that 41.5% have, hiding KeepTrack's entire contribution.
   */
  coverage: Array<{ field: WideField; values: Record<SourceId, number>; union: number }>;
}

function wideReady(): boolean {
  const { wideAttached } = getDb();
  return wideAttached;
}

/** Does the wide build exist? Pages use this to show an explicit notice. */
export function wideCatalogueAvailable(): boolean {
  return wideReady();
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  /** Substring of the chosen name, case-insensitive. */
  nameContains?: string;
  /** Exact NORAD id. */
  noradId?: number;
}

/**
 * The list view: one summary row per object.
 *
 * Reads only the `__chosen` columns so the page can serve 72 000 objects without
 * materialising 156 columns per row.
 *
 * It used to also select a `disagreementCount` badge. Nothing ever rendered it,
 * and its object-class term counted "both sources have a class" as a
 * disagreement — 71 174 of 72 401 objects — because Space-Track's `DEBRIS` and
 * DISCOS's `Payload Fragmentation Debris` are different granularities, not a
 * contradiction. The per-field `disagrees` flag on `getWideObject`, which
 * compares actual values, is the mechanism the detail page uses.
 */
export function listWideObjects(options: ListOptions = {}): WideListRow[] {
  if (!wideReady()) return [];
  const { sqlite } = getDb();

  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  const offset = Math.max(options.offset ?? 0, 0);

  const where: string[] = [];
  const params: unknown[] = [];
  if (options.noradId !== undefined) {
    where.push("catalogue_wide.norad_id = ?");
    params.push(options.noradId);
  }
  if (options.nameContains) {
    where.push("upper(COALESCE(name__spacetrack, name__spacebook, name__discos)) LIKE ?");
    params.push(`%${options.nameContains.toUpperCase()}%`);
  }

  const rows = sqlite
    .prepare(
      `SELECT catalogue_wide.norad_id AS noradId,
              COALESCE(
                name__spacetrack,
                name__spacebook,
                name__discos,
                name__keeptrack,
                name__sbsup
              ) AS name,
              /* These were previously read from Space-Track alone, so the 1,112
                 analyst objects (present only in sbsup) and the DISCOS-only rows
                 showed a blank identity, inclination and decay date even though
                 the catalogue held the values. COALESCE across the sources that
                 actually populate each field, in preference order. */
              COALESCE(cospar_id__spacetrack, cospar_id__spacebook,
                       cospar_id__discos, cospar_id__sbsup) AS cosparId,
              COALESCE(object_class__spacetrack, object_class__discos,
                       object_class__sbsup) AS objectClass,
              COALESCE(country__spacetrack, country__sbsup) AS country,
              COALESCE(mass_kg__discos, mass_kg__spacebook) AS massKg,
              hard_body_radius_m__spacebook AS hardBodyRadiusM,
              COALESCE(inclination_deg__spacetrack, inclination_deg__spacebook,
                       inclination_deg__sbsup) AS inclinationDeg,
              COALESCE(decay_date__spacetrack, decay_date__spacebook,
                       decay_date__discos) AS decayDate,
              cls.constellation AS constellation,
              cls.regime AS regime,
              cls.purpose_group AS purposeGroup
         FROM wide.catalogue_wide
         LEFT JOIN object_classification cls ON cls.norad_id = catalogue_wide.norad_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY catalogue_wide.norad_id
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as WideListRow[];

  return rows;
}

export function countWideObjects(): number {
  if (!wideReady()) return 0;
  const { sqlite } = getDb();
  const row = sqlite.prepare("SELECT COUNT(*) AS n FROM wide.catalogue_wide").get() as { n: number };
  return row.n;
}

/**
 * One object, with every field's values from every source.
 *
 * Returns null when the object is not in the wide build, so the caller can tell
 * "no such object" apart from "object exists but nothing is known about it".
 */
export function getWideObject(noradId: number): WideRow | null {
  if (!wideReady()) return null;
  const { sqlite } = getDb();

  const cols = WIDE_FIELDS.flatMap((f) => SOURCE_IDS.map((s) => `${f}__${s}`)).concat(
    WIDE_FIELDS.map((f) => `${f}__chosen`),
  );
  const row = sqlite
    .prepare(`SELECT norad_id AS noradId, ${cols.join(", ")} FROM wide.catalogue_wide WHERE norad_id = ?`)
    .get(noradId) as (Record<string, unknown> & { noradId: number }) | undefined;

  if (!row) return null;

  const fields = {} as Record<WideField, FieldComparison>;
  for (const f of WIDE_FIELDS) {
    const values = {} as Record<SourceId, string | number | null>;
    const present: Array<string | number> = [];
    for (const s of SOURCE_IDS) {
      const v = (row[`${f}__${s}`] as string | number | null) ?? null;
      values[s] = v;
      if (v !== null && v !== "") present.push(v);
    }
    const distinct = new Set(present.map((v) => String(v)));
    const chosenRaw = row[`${f}__chosen`] as string | null;
    fields[f] = {
      field: f,
      values,
      chosen: (SOURCE_IDS as readonly string[]).includes(chosenRaw ?? "")
        ? (chosenRaw as SourceId)
        : null,
      disagrees: present.length >= 2 && distinct.size > 1,
    };
  }

  return { noradId: row.noradId, fields };
}

/** Coverage per field per source, plus the union across all five, for the catalogue page. */
export function wideStats(): WideStats {
  if (!wideReady()) return { objects: 0, coverage: [] };
  const { sqlite } = getDb();

  const objects = countWideObjects();
  const filled = (f: WideField, s: SourceId): string =>
    `CASE WHEN "${f}__${s}" IS NOT NULL AND "${f}__${s}" <> '' THEN 1 ELSE 0 END`;

  const selects = WIDE_FIELDS.map((f) => {
    const perSource = SOURCE_IDS.map((s) => `SUM(${filled(f, s)}) AS "${f}__${s}"`).join(",\n       ");
    // The union is an OR over the sources, not the largest single count: the
    // sources hold different objects, so the maximum understates the catalogue.
    const union = `SUM(CASE WHEN ${SOURCE_IDS.map((s) => filled(f, s)).join(" OR ")} THEN 1 ELSE 0 END) AS "${f}__union"`;
    return `${perSource},\n       ${union}`;
  }).join(",\n       ");

  const row = sqlite.prepare(`SELECT ${selects} FROM wide.catalogue_wide`).get() as Record<string, number>;

  return {
    objects,
    coverage: WIDE_FIELDS.map((f) => ({
      field: f,
      values: Object.fromEntries(SOURCE_IDS.map((s) => [s, row[`${f}__${s}`] ?? 0])) as Record<SourceId, number>,
      union: row[`${f}__union`] ?? 0,
    })),
  };
}

/**
 * Change which source a field uses, for one object.
 *
 * Written to the attached database, so the wide file must be writable. Kept as a
 * single-row update rather than a rebuild: a user changing one cell should not
 * cost 40 seconds of recomputation.
 */
export function setFieldChoice(noradId: number, field: WideField, source: SourceId | null): void {
  if (!wideReady()) throw new Error("the wide catalogue is not attached");
  if (!(WIDE_FIELDS as readonly string[]).includes(field)) throw new Error(`unknown field: ${field}`);
  if (source !== null && !(SOURCE_IDS as readonly string[]).includes(source)) {
    throw new Error(`unknown source: ${source}`);
  }
  const { sqlite } = getDb();
  sqlite
    .prepare(`UPDATE wide.catalogue_wide SET ${field}__chosen = ? WHERE norad_id = ?`)
    .run(source, noradId);
}

/**
 * Dictionary key for each wide field's display name.
 *
 * Keyed by `WideField` so a field added to the build script cannot be rendered
 * without a label. The reuses below are deliberate: a name shown in a table
 * header and the same name shown in the coverage list must be one string, or the
 * two drift apart in five languages at once.
 */
export const FIELD_LABEL_KEYS: Record<WideField, MessageKey> = {
  name: "column.name",
  cospar_id: "column.cospar",
  object_class: "column.objectClass",
  country: "column.country",
  launch_site: "field.launchSite",
  launch_date: "field.launchDate",
  decay_date: "field.decayDate",
  inclination_deg: "catalogue.inclination",
  period_min: "catalogue.period",
  apogee_km: "field.apogee",
  perigee_km: "field.perigee",
  rcs_size: "field.rcsSize",
  mass_kg: "column.mass",
  hard_body_radius_m: "column.hardBodyRadius",
  cross_section_avg_m2: "field.crossSectionAvg",
  cross_section_max_m2: "field.crossSectionMax",
  cross_section_min_m2: "field.crossSectionMin",
  span_m: "field.span",
  diameter_m: "field.diameter",
  ballistic_coefficient: "field.ballisticCoefficient",
  shape: "field.shape",
  manufacturer: "field.manufacturer",
  bus: "field.bus",
  orbit_type: "field.orbitType",
  dry_mass_kg: "field.dryMass",
  length_m: "field.length",
};
