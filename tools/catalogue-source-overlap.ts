/**
 * How many catalogue objects each source actually knows about, and how the
 * sources' object sets overlap.
 *
 * ## Why this exists
 *
 * The wide table's row count (72,401) is the union of five sources, so it says
 * nothing about whether any one source is complete. The questions that matter for
 * catalogue integrity are:
 *
 *   - how many objects does each source have a row for at all;
 *   - how many objects does only one source know;
 *   - for the ones only one source knows, is that a real object the others missed,
 *     or a source artefact?
 *
 * Run: npx tsx tools/catalogue-source-overlap.ts
 */

import Database from "better-sqlite3";

const WIDE = process.env.SPACE_SAFETY_WIDE_DB ?? "data/catalogue-wide.sqlite";
const SOURCES = ["spacetrack", "spacebook", "discos", "keeptrack", "sbsup"] as const;

interface Overlap {
  sourceCount: number;
  n: number;
}

function main(): void {
  const db = new Database(WIDE, { readonly: true });
  const cols = (db.prepare("SELECT name FROM pragma_table_info('catalogue_wide')").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );

  // A source "knows" an object when any of its columns holds a value. Using only
  // name/cospar/inclination undercounted by an order of magnitude the first time
  // this was measured: 90 objects looked absent from every source while Spacebook
  // held a name for them in a column the check had not looked at.
  const present = (s: string): string => {
    const c = cols.filter((n) => n.endsWith(`__${s}`));
    if (c.length === 0) throw new Error(`宽表里没有 ${s} 的列`);
    return `(${c.map((n) => `${n} IS NOT NULL`).join(" OR ")})`;
  };

  console.log("\n  各来源覆盖的对象数\n");
  for (const s of SOURCES) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM catalogue_wide WHERE ${present(s)}`).get() as {
      n: number;
    };
    console.log(`  ${s.padEnd(12)}${String(n).padStart(8)}`);
  }

  const sum = SOURCES.slice(0, 4).map((s) => `CASE WHEN ${present(s)} THEN 1 ELSE 0 END`).join(" + ");
  const overlap = db
    .prepare(
      `WITH s AS (SELECT norad_id, ${sum} AS k FROM catalogue_wide)
       SELECT k AS sourceCount, COUNT(*) AS n FROM s GROUP BY 1 ORDER BY 1`,
    )
    .all() as Overlap[];

  console.log("\n  被多少个来源同时收录\n");
  for (const r of overlap) {
    console.log(`  ${String(r.sourceCount)} 个来源  ${String(r.n).padStart(8)}`);
  }

  // Only-one-source objects need to be looked at individually: that is where an
  // unmapped field, a misparsed row or a source artefact would hide.
  console.log("\n  只有一个来源收录的对象\n");
  for (const s of SOURCES.slice(0, 4)) {
    const others = SOURCES.slice(0, 4).filter((o) => o !== s).map((o) => `NOT ${present(o)}`).join(" AND ");
    const rows = db
      .prepare(
        `SELECT norad_id, ${cols
          .filter((n) => n.endsWith(`__${s}`) && n !== "norad_id")
          .map((n) => `${n} AS ${n}`)
          .slice(0, 6)
          .join(", ")}
           FROM catalogue_wide WHERE ${present(s)} AND ${others} LIMIT 5`,
      )
      .all() as Array<Record<string, unknown>>;
    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM catalogue_wide WHERE ${present(s)} AND ${others}`)
      .get() as { n: number };
    console.log(`  ${s.padEnd(12)}${String(n).padStart(7)} 个`);
    for (const r of rows) console.log(`      ${JSON.stringify(r).slice(0, 170)}`);
  }

  db.close();
  console.log("");
}

main();
