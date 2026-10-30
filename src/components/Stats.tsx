import type { Translator } from "@/lib/i18n";

/**
 * A strip of KPI tiles.
 *
 * The home page has its own private copy of this markup; it is extracted here so
 * the event pages do not each re-define the same three lines. Values arrive
 * already formatted — a tile that formatted its own numbers would need a
 * translator passed through a client boundary for no benefit.
 */
export interface StatItem {
  label: string;
  value: string;
  /** Semantic tone for counters whose meaning is a risk level. */
  tone?: "high" | "medium";
}

export function StatsRow({ items }: { items: StatItem[] }) {
  return (
    <div className="stats-row">
      {items.map((item) => (
        <div className="stat" key={item.label}>
          <div className="stat-label">{item.label}</div>
          <div className={`stat-value${item.tone ? ` ${item.tone}` : ""}`}>{item.value}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Shorthand for the common case.
 *
 * A count is formatted for the locale; a measurement is passed as an already
 * formatted string (UT1-UTC is "-0.0526", not "-0.0526 s rounded to 0"), so the
 * caller decides the precision instead of the tile.
 */
export function stat(
  t: Translator,
  label: string,
  value: number | string | null | undefined,
  fallback = "—",
): StatItem {
  if (value === null || value === undefined) return { label, value: fallback };
  return { label, value: typeof value === "string" ? value : t.number(value) };
}
