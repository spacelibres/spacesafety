/**
 * Print the objects that only KeepTrack lists, as the wide table sees them.
 *
 * ## Why this is separate from `keeptrack-only-audit.ts`
 *
 * The audit counts by what KeepTrack's own row holds. The wide table counts a
 * source as present when any of its 26 columns is non-null, and it reported 682
 * KeepTrack-only objects against the audit's 90. This prints the wide-table view
 * so the 592-object gap can be seen rather than explained away.
 *
 * Run: npx tsx tools/keeptrack-only-wide.ts
 */

import Database from "better-sqlite3";

const WIDE = process.env.SPACE_SAFETY_WIDE_DB ?? "data/catalogue-wide.sqlite";
const SOURCES = ["spacetrack", "spacebook", "discos"] as const;

function main(): void {
  const db = new Database(WIDE, { readonly: true });
  const cols = (db.prepare("SELECT name FROM pragma_table_info('catalogue_wide')").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );

  const has = (s: string) => `(${cols.filter((n) => n.endsWith(`__${s}`)).map((n) => `${n} IS NOT NULL`).join(" OR ")})`;
  const ktOnly = `${has("keeptrack")} AND ${SOURCES.map((s) => `NOT ${has(s)}`).join(" AND ")}`;

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM catalogue_wide WHERE ${ktOnly}`).get() as { n: number }).n;
  console.log(`\n  宽表视角：仅 KeepTrack 有数据的对象 ${total} 个\n`);

  const ktCols = cols.filter((n) => n.endsWith("__keeptrack"));
  const rows = db
    .prepare(`SELECT norad_id, ${ktCols.join(", ")} FROM catalogue_wide WHERE ${ktOnly} LIMIT 12`)
    .all() as Array<Record<string, unknown>>;

  for (const r of rows) {
    const filled = Object.entries(r)
      .filter(([k, v]) => v !== null && k !== "norad_id")
      .map(([k, v]) => `${k.replace("__keeptrack", "")}=${String(v).slice(0, 24)}`);
    console.log(`  ${String(r.norad_id).padStart(6)}  ${filled.join("  ") || "(无值)"}`);
  }

  // Which KeepTrack column is the one making these "present"?
  console.log("\n  是哪一列让它们算作有数据\n");
  for (const c of ktCols) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM catalogue_wide WHERE ${ktOnly} AND ${c} IS NOT NULL`).get() as {
      n: number;
    }).n;
    if (n > 0) console.log(`  ${c.replace("__keeptrack", "").padEnd(24)}${String(n).padStart(6)}`);
  }

  db.close();
  console.log("");
}

main();
