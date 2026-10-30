/**
 * Reading the three-source wide catalogue.
 *
 * ## Why a separate query module
 *
 * The wide table has a shape unlike anything else in the schema: every field is
 * four columns (`__spacetrack`, `__spacebook`, `__discos`, `__chosen`) and the
 * field list is data, not code. Writing that out into Drizzle's typed schema would
 * produce 105 hand-maintained column definitions that must be kept in step with a
 * build script; reading it generically keeps the two from drifting.
 *
 * ## What a caller gets
 *
 * Not a flat row. A field the sources disagree about is only meaningful with all
 * of its claims together, so each field is returned as a small object carrying the
 * three values and which one is currently chosen. A page can then render one row
 * per object and still show three sources per cell.
 */

import { getDb } from "@/db";

/** The three catalogues, in the order the UI displays them. */
export const SOURCE_IDS = ["spacetrack", "spacebook", "discos", "keeptrack"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const SOURCE_LABELS: Record<SourceId, { short: string; long: string }> = {
  spacetrack: { short: "Space-Track", long: "Space-Track（美国太空军）" },
  spacebook: { short: "Spacebook", long: "Spacebook（AGI/STK + ComSpoc）" },
  discos: { short: "DISCOS", long: "ESA DISCOSweb（欧空局）" },
  keeptrack: { short: "KeepTrack", long: "KeepTrack（keeptrack.space）" },
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
  /** Number of fields where the sources do not agree, for the list's badge. */
  disagreementCount: number;
}

export interface WideStats {
  objects: number;
  /** Per field: how many objects have a value from each source. */
  coverage: Array<{ field: WideField; spacetrack: number; spacebook: number; discos: number }>;
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
 * Reads only the `__chosen` columns (plus a disagreement count computed from the
 * three name sources) so the page can serve 71 000 objects without materialising
 * 105 columns per row.
 */
export function listWideObjects(options: ListOptions = {}): WideListRow[] {
  if (!wideReady()) return [];
  const { sqlite } = getDb();

  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  const offset = Math.max(options.offset ?? 0, 0);

  const where: string[] = [];
  const params: unknown[] = [];
  if (options.noradId !== undefined) {
    where.push("norad_id = ?");
    params.push(options.noradId);
  }
  if (options.nameContains) {
    where.push("upper(COALESCE(name__spacetrack, name__spacebook, name__discos)) LIKE ?");
    params.push(`%${options.nameContains.toUpperCase()}%`);
  }

  const rows = sqlite
    .prepare(
      `SELECT norad_id AS noradId,
              COALESCE(
                name__spacetrack,
                name__spacebook,
                name__discos
              ) AS name,
              cospar_id__spacetrack AS cosparId,
              object_class__spacetrack AS objectClass,
              country__spacetrack AS country,
              COALESCE(mass_kg__discos, mass_kg__spacebook) AS massKg,
              hard_body_radius_m__spacebook AS hardBodyRadiusM,
              inclination_deg__spacetrack AS inclinationDeg,
              decay_date__spacetrack AS decayDate,
              cls.constellation AS constellation,
              cls.regime AS regime,
              cls.purpose_group AS purposeGroup,
              -- How many fields the sources actively disagree about. Computed in
              -- SQL because doing it in JS would mean reading every claim of every
              -- row, which is exactly what the wide layout exists to avoid.
              (
                (object_class__spacetrack IS NOT NULL AND object_class__discos IS NOT NULL) +
                (mass_kg__discos IS NOT NULL AND mass_kg__spacebook IS NOT NULL
                   AND abs(mass_kg__discos - mass_kg__spacebook) > 0.01 * max(mass_kg__discos, mass_kg__spacebook)) +
                (inclination_deg__spacetrack IS NOT NULL AND inclination_deg__spacebook IS NOT NULL
                   AND abs(inclination_deg__spacetrack - inclination_deg__spacebook) > 0.5) +
                (decay_date__spacetrack IS NOT NULL AND decay_date__discos IS NOT NULL
                   AND decay_date__spacetrack <> decay_date__discos)
              ) AS disagreementCount
         FROM wide.catalogue_wide
         LEFT JOIN cls.object_classification cls ON cls.norad_id = catalogue_wide.norad_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY norad_id
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<WideListRow & { disagreementCount: number }>;

  return rows;
}

export function countWideObjects(): number {
  if (!wideReady()) return 0;
  const { sqlite } = getDb();
  const row = sqlite.prepare("SELECT COUNT(*) AS n FROM wide.catalogue_wide").get() as { n: number };
  return row.n;
}

/**
 * One object, with every field's three values.
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

/** Coverage per field per source, for the catalogue overview page. */
export function wideStats(): WideStats {
  if (!wideReady()) return { objects: 0, coverage: [] };
  const { sqlite } = getDb();

  const objects = countWideObjects();
  const selects = WIDE_FIELDS.map(
    (f) =>
      `SUM(CASE WHEN ${f}__spacetrack IS NOT NULL AND ${f}__spacetrack <> '' THEN 1 ELSE 0 END) AS st_${f},
       SUM(CASE WHEN ${f}__spacebook IS NOT NULL AND ${f}__spacebook <> '' THEN 1 ELSE 0 END) AS sb_${f},
       SUM(CASE WHEN ${f}__discos IS NOT NULL AND ${f}__discos <> '' THEN 1 ELSE 0 END) AS ds_${f}`,
  ).join(",\n");

  const row = sqlite.prepare(`SELECT ${selects} FROM wide.catalogue_wide`).get() as Record<
    string,
    number
  >;

  return {
    objects,
    coverage: WIDE_FIELDS.map((f) => ({
      field: f,
      spacetrack: row[`st_${f}`] ?? 0,
      spacebook: row[`sb_${f}`] ?? 0,
      discos: row[`ds_${f}`] ?? 0,
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
  if (!wideReady()) throw new Error("宽表未挂载");
  if (!(WIDE_FIELDS as readonly string[]).includes(field)) throw new Error(`未知字段：${field}`);
  if (source !== null && !(SOURCE_IDS as readonly string[]).includes(source)) {
    throw new Error(`未知来源：${source}`);
  }
  const { sqlite } = getDb();
  sqlite
    .prepare(`UPDATE wide.catalogue_wide SET ${field}__chosen = ? WHERE norad_id = ?`)
    .run(source, noradId);
}

/** Human-readable field names, for the UI. */
export const FIELD_LABELS: Record<WideField, string> = {
  name: "名称",
  cospar_id: "COSPAR 编号",
  object_class: "目标分类",
  country: "发射国",
  launch_site: "发射场",
  launch_date: "发射日期",
  decay_date: "再入日期",
  inclination_deg: "倾角 (°)",
  period_min: "周期 (min)",
  apogee_km: "远地点 (km)",
  perigee_km: "近地点 (km)",
  rcs_size: "RCS 分级",
  mass_kg: "质量 (kg)",
  hard_body_radius_m: "硬体半径 (m)",
  cross_section_avg_m2: "横截面积均值 (m²)",
  cross_section_max_m2: "横截面积最大 (m²)",
  cross_section_min_m2: "横截面积最小 (m²)",
  span_m: "翼展 (m)",
  diameter_m: "直径 (m)",
  ballistic_coefficient: "弹道系数",
  shape: "形状",
  manufacturer: "制造商",
  bus: "平台型号",
  orbit_type: "轨道类型",
  dry_mass_kg: "干重 (kg)",
  length_m: "长度 (m)",
};
