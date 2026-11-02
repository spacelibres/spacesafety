"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { columnsCookie, columnCookieValue } from "@/lib/columns";
import { useTranslator } from "@/lib/i18n/client";

/**
 * The gear beside a filter bar: choose which columns are shown.
 *
 * The choice is written to a cookie and the route is refreshed, so the server
 * renders the table again with the new columns — the same server-rendered table
 * as before, not a second implementation that filters on the client and drifts.
 *
 * A `<details>` for the same reason the download menu uses one: it opens without
 * JavaScript and closes on a second click.
 */
export function ColumnSettings<Key extends string>({
  table,
  columns,
  visible,
}: {
  table: string;
  columns: ReadonlyArray<{ key: Key; label: string }>;
  visible: readonly Key[];
}) {
  const t = useTranslator();
  const router = useRouter();
  const [selected, setSelected] = useState<readonly Key[]>(visible);

  const toggle = (key: Key) => {
    const next = selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
    // Never write an empty selection: a table with no columns is indistinguishable
    // from a broken page, and the reader has to clear a cookie to recover.
    if (next.length === 0) return;
    setSelected(next);
    document.cookie = `${columnsCookie(table)}=${encodeURIComponent(
      columnCookieValue(columns.map((c) => c.key), next),
    )}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  };

  return (
    <details className="dl">
      <summary className="filter-btn" title={t.t("columns.title")} aria-label={t.t("columns.title")}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
        </svg>
      </summary>
      <div className="dl-menu dl-menu-start">
        <div className="dl-head">{t.t("columns.title")}</div>
        {columns.map((column) => (
          <label className="dl-check" key={column.key}>
            <input
              type="checkbox"
              checked={selected.includes(column.key)}
              onChange={() => toggle(column.key)}
            />
            <span>{column.label}</span>
          </label>
        ))}
      </div>
    </details>
  );
}
