/**
 * Reading the classification dimensions as browsable facets.
 *
 * ## What a facet is here
 *
 * Each dimension (orbit regime, country, constellation, purpose) is a set of values
 * with counts, computed against the current filter. Clicking a value narrows the
 * object list; the other facets recount against the narrowed set, so the numbers
 * always describe what clicking would actually produce.
 *
 * ## Why counts are recomputed per request
 *
 * The alternative — one global count per value — lets a user click "Starlink" and
 * then "GEO" and land on an empty page, because nothing said Starlink has no GEO
 * satellites. Faceted counts prevent dead ends and cost one grouped query.
 */

import { getDb } from "@/db";

export type FacetName = "objectClass" | "classDetail" | "regime" | "country" | "constellation" | "purpose";

const COLUMN: Record<FacetName, string> = {
  // What the object is. This was missing from the facet list even though the
  // identity is the first question anyone asks of a catalogue: the page could
  // filter by orbit and by fleet but not by "show me only the live satellites".
  objectClass: "c.object_class",
  // The source's finer term: which fragments came from payloads, which from
  // stages, and which objects were released deliberately rather than broken off.
  classDetail: "c.class_detail",
  regime: "c.regime",
  country: "c.country",
  constellation: "c.constellation",
  purpose: "c.purpose_group",
};

export interface FacetValue {
  value: string;
  count: number;
}

export interface BrowseFilter {
  objectClass?: string;
  classDetail?: string;
  regime?: string;
  country?: string;
  constellation?: string;
  purpose?: string;
  /** Free-text name or NORAD match. */
  q?: string;
  /** Restrict to objects still in orbit. */
  orbitsOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface BrowseResult {
  facets: Record<FacetName, FacetValue[]>;
  rows: Array<{
    noradId: number;
    name: string | null;
    constellation: string | null;
    regime: string | null;
    country: string | null;
    purposeGroup: string | null;
    objectClass: string | null;
    classDetail: string | null;
    massKg: number | null;
    inclinationDeg: number | null;
    decayDate: string | null;
  }>;
  total: number;
  page: number;
  pageSize: number;
}

/** Build the WHERE clause shared by the facet counts and the row query. */
function buildWhere(f: BrowseFilter): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];

  for (const [name, col] of Object.entries(COLUMN) as Array<[FacetName, string]>) {
    const v = f[name];
    if (v) {
      parts.push(`${col} = ?`);
      params.push(v);
    }
  }
  if (f.q) {
    // NORAD ids are numeric; matching the text form keeps one search box usable for
    // both, which is what a person typing "44713" or "STARLINK-1007" expects.
    parts.push("(upper(w.name__spacetrack) LIKE ? OR CAST(w.norad_id AS TEXT) = ?)");
    params.push(`%${f.q.toUpperCase()}%`, f.q);
  }
  if (f.orbitsOnly) {
    parts.push("w.decay_date__spacetrack IS NULL");
  }

  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

export function browse(f: BrowseFilter = {}): BrowseResult {
  const { sqlite, wideAttached } = getDb();
  if (!wideAttached) {
    return {
      facets: {
        objectClass: [],
        classDetail: [],
        regime: [],
        country: [],
        constellation: [],
        purpose: [],
      },
      rows: [],
      total: 0,
      page: 1,
      pageSize: 50,
    };
  }

  const page = Math.max(f.page ?? 1, 1);
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 10), 200);
  const { sql: where, params } = buildWhere(f);

  const base = `
    FROM wide.catalogue_wide w
    JOIN object_classification c ON c.norad_id = w.norad_id
    ${where}`;

  // ------------------------------------------------------------- facets
  const facets = {} as Record<FacetName, FacetValue[]>;
  for (const [name, col] of Object.entries(COLUMN) as Array<[FacetName, string]>) {
    // Count for each value **with this dimension's own filter removed**, so the
    // selected value keeps its neighbours visible and switching is one click.
    const without: BrowseFilter = { ...f };
    delete without[name];
    const withoutQuery = buildWhere(without);
    const p2 = withoutQuery.params;

    const rows = sqlite
      .prepare(
        `SELECT ${col} AS value, COUNT(*) AS count
           FROM wide.catalogue_wide w
           JOIN object_classification c ON c.norad_id = w.norad_id
           ${withoutQuery.sql ? `${withoutQuery.sql} AND` : "WHERE"} ${col} IS NOT NULL AND ${col} <> ''
          GROUP BY ${col}
          ORDER BY count DESC
          LIMIT 400`,
      )
      .all(...p2) as FacetValue[];
    facets[name] = rows;
  }

  // --------------------------------------------------------------- rows
  const total = (
    sqlite.prepare(`SELECT COUNT(*) AS n ${base}`).get(...params) as { n: number }
  ).n;

  const rows = sqlite
    .prepare(
      `SELECT w.norad_id AS noradId,
              COALESCE(w.name__spacetrack, w.name__spacebook, w.name__discos,
                       w.name__keeptrack, w.name__sbsup) AS name,
              c.constellation AS constellation,
              c.regime AS regime,
              c.country AS country,
              c.purpose_group AS purposeGroup,
              /* The normalised value, not the raw Space-Track column: the raw
                 column is upper-case there and title-case in DISCOS, and it is
                 blank for the 1,112 analyst objects. Reading it here made the list
                 disagree with both the facet counts and the filter selection. */
              c.object_class AS objectClass,
              c.class_detail AS classDetail,
              COALESCE(w.mass_kg__discos, w.mass_kg__spacebook) AS massKg,
              w.inclination_deg__spacetrack AS inclinationDeg,
              w.decay_date__spacetrack AS decayDate
         ${base}
        ORDER BY w.norad_id
        LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as BrowseResult["rows"];

  return { facets, rows, total, page, pageSize };
}
