import Link from "next/link";

import { sortHref, sortMarker, type SortSpec } from "@/lib/sort";

/**
 * A sortable table header.
 *
 * Renders a `<th>` whose label is a link to the same page with `?sort=<column>`,
 * preserving the active filters. Sorting is therefore a server round-trip: no
 * client JavaScript, no hydration, and the resulting URL is shareable — which
 * matters because "look at this sorted view" is how a table gets discussed.
 *
 * The marker is text (`↕` / `▲` / `▼`) rather than an icon so it is announced by
 * screen readers and survives with images disabled.
 */
export function SortableTh<Key extends string>({
  label,
  column,
  current,
  pathname,
  params,
  className,
}: {
  label: string;
  column: Key;
  current: SortSpec<Key>;
  pathname: string;
  params: Record<string, string | undefined>;
  className?: string;
}) {
  const active = current.key === column;
  return (
    <th className={className}>
      <Link
        className={`th-sort${active ? " on" : ""}`}
        href={sortHref(pathname, params, column, current)}
        aria-sort={active ? (current.dir === "asc" ? "ascending" : "descending") : "none"}
      >
        {label}
        <span className="th-sort-mark" aria-hidden="true">
          {sortMarker(column, current)}
        </span>
      </Link>
    </th>
  );
}
