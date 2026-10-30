/**
 * Aggregate statistics over the classified catalogue.
 *
 * ## What these tables answer that the browse facets do not
 *
 * The facets answer "what is in this slice". These answer "how is the whole
 * distributed", which is a different question and needs a different shape: a
 * cross-tabulation of two dimensions shows at a glance that Starlink is entirely LEO
 * while NOAA spans LEO and GEO, and no list of per-value counts shows that.
 *
 * ## Why the counts come from one pass
 *
 * Every table here is derived from the same joined rows. Running a query per table
 * would read 72 000 rows twelve times; one pass into memory and a group-by per
 * dimension is a single read.
 */

import { getDb } from "@/db";

export interface Bucket {
  label: string;
  count: number;
  /** Share of the total, 0–1. */
  share: number;
}

export interface CrossTab {
  rowLabel: string;
  columnLabel: string;
  columns: string[];
  rows: Array<{ label: string; cells: number[]; total: number }>;
  columnTotals: number[];
}

export interface Statistics {
  total: number;
  inOrbit: number;
  regime: Bucket[];
  objectClass: Bucket[];
  purpose: Bucket[];
  country: Bucket[];
  constellation: Bucket[];
  /** Constellation × orbit regime. */
  constellationByRegime: CrossTab;
  /** Object class × orbit regime. */
  classByRegime: CrossTab;
  /** Launch year histogram, from the catalogue's launch date. */
  launchYears: Bucket[];
  /** Mass summary per regime, where a mass is known. */
  massByRegime: Array<{ regime: string; count: number; medianKg: number; totalKg: number }>;
}

interface Row {
  noradId: number;
  regime: string;
  objectClass: string | null;
  purpose: string | null;
  country: string | null;
  constellation: string | null;
  launchDate: string | null;
  massKg: number | null;
  /** SQLite returns 0/1; converted to boolean immediately after the query. */
  decayed: boolean | number;
}

const REGIMES = ["LEO", "MEO", "GEO", "HEO", "UNKNOWN"];

function bucketise(counts: Map<string, number>, total: number, limit = 200): Bucket[] {
  return [...counts]
    .map(([label, count]) => ({ label, count, share: total ? count / total : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function statistics(): Statistics {
  const { sqlite, wideAttached } = getDb();
  const empty: Statistics = {
    total: 0,
    inOrbit: 0,
    regime: [],
    objectClass: [],
    purpose: [],
    country: [],
    constellation: [],
    constellationByRegime: { rowLabel: "", columnLabel: "", columns: [], rows: [], columnTotals: [] },
    classByRegime: { rowLabel: "", columnLabel: "", columns: [], rows: [], columnTotals: [] },
    launchYears: [],
    massByRegime: [],
  };
  if (!wideAttached) return empty;

  const rows = sqlite
    .prepare(
      `SELECT w.norad_id AS noradId,
              c.regime AS regime,
              w.object_class__spacetrack AS objectClass,
              c.purpose_group AS purpose,
              c.country AS country,
              c.constellation AS constellation,
              w.launch_date__spacetrack AS launchDate,
              COALESCE(w.mass_kg__discos, w.mass_kg__spacebook) AS massKg,
              w.decay_date__spacetrack IS NOT NULL AS decayed
         FROM wide.catalogue_wide w
         JOIN object_classification c ON c.norad_id = w.norad_id`,
    )
    .all() as Array<Row>;

  const list: Row[] = rows.map((r) => ({ ...r, decayed: Boolean(r.decayed) }));
  const total = list.length;
  const inOrbit = list.filter((r) => !r.decayed).length;

  const count = (pick: (r: Row) => string | null): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of list) {
      const k = pick(r);
      if (!k) continue;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };

  // -------------------------------------------------------- cross tabs
  const crossTab = (
    rowPicker: (r: Row) => string | null,
    columnPicker: (r: Row) => string,
    rowLimit: number,
  ): CrossTab => {
    const rowKeys = [...count(rowPicker).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, rowLimit)
      .map(([k]) => k);

    const colSet = new Set<string>();
    const cells = new Map<string, Map<string, number>>();
    for (const r of list) {
      const rk = rowPicker(r);
      if (!rk || !rowKeys.includes(rk)) continue;
      const ck = columnPicker(r);
      colSet.add(ck);
      const m = cells.get(rk) ?? new Map<string, number>();
      m.set(ck, (m.get(ck) ?? 0) + 1);
      cells.set(rk, m);
    }

    const columns = REGIMES.filter((x) => colSet.has(x)).concat(
      [...colSet].filter((x) => !REGIMES.includes(x)).sort(),
    );

    const outRows = rowKeys.map((label) => {
      const m = cells.get(label) ?? new Map<string, number>();
      const c = columns.map((col) => m.get(col) ?? 0);
      return { label, cells: c, total: c.reduce((a, b) => a + b, 0) };
    });

    const columnTotals = columns.map((_, i) => outRows.reduce((a, r) => a + (r.cells[i] ?? 0), 0));

    return { rowLabel: "", columnLabel: "", columns, rows: outRows, columnTotals };
  };

  // ------------------------------------------------------- launch years
  const yearCounts = new Map<string, number>();
  for (const r of list) {
    if (!r.launchDate) continue;
    const y = r.launchDate.slice(0, 4);
    if (!/^\d{4}$/.test(y)) continue;
    yearCounts.set(y, (yearCounts.get(y) ?? 0) + 1);
  }
  const launchYears = [...yearCounts]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, n]) => ({ label, count: n, share: total ? n / total : 0 }));

  // -------------------------------------------------------- mass by regime
  const masses = new Map<string, number[]>();
  for (const r of list) {
    if (r.massKg === null || r.massKg <= 0) continue;
    const arr = masses.get(r.regime) ?? [];
    arr.push(r.massKg);
    masses.set(r.regime, arr);
  }
  const massByRegime = REGIMES.filter((g) => masses.has(g)).map((g) => {
    const arr = masses.get(g)!;
    return {
      regime: g,
      count: arr.length,
      medianKg: median(arr),
      totalKg: arr.reduce((a, b) => a + b, 0),
    };
  });

  return {
    total,
    inOrbit,
    regime: bucketise(count((r) => r.regime), total),
    objectClass: bucketise(count((r) => r.objectClass), total),
    purpose: bucketise(count((r) => r.purpose), total),
    country: bucketise(count((r) => r.country), total),
    constellation: bucketise(count((r) => r.constellation), total),
    constellationByRegime: crossTab((r) => r.constellation, (r) => r.regime, 15),
    classByRegime: crossTab((r) => r.objectClass, (r) => r.regime, 8),
    launchYears,
    massByRegime,
  };
}
