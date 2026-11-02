/**
 * Column sorting for the list pages.
 *
 * ## Why this is a module and not three lines per page
 *
 * The official UI sorts from the column header (`Name ↕`), and four list pages
 * need the same three behaviours: parse `?sort=&dir=`, keep it inside a whitelist,
 * and build a link that toggles direction without dropping the other filters.
 * Written inline four times, one of them drifts — that is how a page ends up
 * sorting by a column name interpolated straight into SQL.
 *
 * ## Injection
 *
 * `sort` comes from the URL, so it is never interpolated. Each page passes a map
 * from a *fixed* key to a SQL fragment; an unknown key falls back to the default.
 * A request with `?sort=id;DROP TABLE` therefore sorts by the default column
 * instead of reaching the database.
 */

export type SortDir = "asc" | "desc";

export interface SortSpec<Key extends string = string> {
  key: Key;
  dir: SortDir;
}

/** A whitelist: sort key → SQL expression. Only these keys ever reach SQL. */
export type SortColumns<Key extends string> = Record<Key, string>;

/**
 * Read `?sort=&dir=`, clamped to the whitelist.
 *
 * `dir` is only honoured as the literal `asc`/`desc`; anything else uses the
 * fallback, because a typo silently reversing a table is worse than ignoring it.
 */
export function parseSort<Key extends string>(
  raw: { sort?: string; dir?: string } | undefined,
  columns: SortColumns<Key>,
  fallback: SortSpec<Key>,
): SortSpec<Key> {
  const key = raw?.sort;
  if (!key || !(key in columns)) return fallback;
  const dir: SortDir = raw?.dir === "asc" || raw?.dir === "desc" ? raw.dir : fallback.dir;
  return { key: key as Key, dir };
}

/** `ORDER BY` clause for a whitelisted sort. Always ends in a stable tiebreaker. */
export function orderByClause<Key extends string>(
  columns: SortColumns<Key>,
  sort: SortSpec<Key>,
  tiebreaker = "norad_id",
): string {
  const expression = columns[sort.key] ?? columns[Object.keys(columns)[0] as Key];
  const direction = sort.dir === "desc" ? "DESC" : "ASC";
  // Without a tiebreaker, two rows sharing the sort value can swap between the
  // two queries a pager makes — the same row appears twice and another never does.
  return `${expression} ${direction} NULLS LAST, ${tiebreaker} ASC`;
}

/**
 * The href that toggles one column, preserving every other query parameter.
 *
 * Clicking the current column flips direction; clicking a different one sorts by
 * it ascending, which is what every table the reader has ever used does.
 */
export function sortHref<Key extends string>(
  pathname: string,
  params: Record<string, string | undefined>,
  column: Key,
  current: SortSpec<Key>,
): string {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "" || k === "sort" || k === "dir") continue;
    next[k] = v;
  }
  next.sort = column;
  next.dir = current.key === column && current.dir === "asc" ? "desc" : "asc";
  const query = new URLSearchParams(next).toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** The arrow shown beside the active column. */
export function sortMarker<Key extends string>(column: Key, current: SortSpec<Key>): string {
  if (current.key !== column) return "↕";
  return current.dir === "asc" ? "▲" : "▼";
}
