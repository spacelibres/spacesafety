/**
 * Find catalogued objects that a supplement crawl could realistically improve.
 *
 * ## Why this is a separate step from the crawl
 *
 * The gaps in the catalogue are wildly uneven, and some are not gaps at all:
 *
 *   mass / hard-body radius   114 in orbit   — too few to be worth a crawl
 *   manufacturer             10 632            — but 9 465 of them are debris
 *   bus                      13 444
 *   shape                    12 831
 *
 * Debris has no manufacturer. Asking a search engine for "who built the debris
 * from a 1986 explosion" produces either nothing or a guess, and a guess is the one
 * thing this layer must never store. So the candidate list excludes debris from the
 * manufacturer/bus targets and reports it as a separate class with its own question
 * ("which object did it come from"), which is a different field set.
 *
 * ## Why newest first
 *
 * A satellite launched last month is described in a press release, an FCC filing and
 * often a manufacturer page. A satellite launched in 1968 has, at best, one line in
 * a historical database that has already been ingested. The crawl's value is
 * concentrated almost entirely on recent objects.
 *
 * Run: npx tsx tools/supplement-candidates.ts
 *      npx tsx tools/supplement-candidates.ts --limit 50 --out data/candidates.json
 */

import { mkdirSync, writeFileSync } from "node:fs";

import Database from "better-sqlite3";

interface Args {
  db: string;
  limit: number;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    db: flag("--db") ?? "data/catalogue-wide.sqlite",
    limit: Number(flag("--limit") ?? "200"),
    out: flag("--out") ?? null,
  };
}

/** Fields a crawl can supply, and which object classes they make sense for. */
const TARGETS: Array<{
  field: string;
  /** Key in the query row. */
  key: "mfr" | "bus" | "shape" | "mass";
  classes: string[];
}> = [
  { field: "manufacturer", key: "mfr", classes: ["PAYLOAD"] },
  { field: "bus", key: "bus", classes: ["PAYLOAD"] },
  { field: "shape", key: "shape", classes: ["PAYLOAD", "ROCKET BODY"] },
  { field: "mass_kg", key: "mass", classes: ["PAYLOAD", "ROCKET BODY"] },
];

interface Candidate {
  noradId: number;
  name: string | null;
  cosparId: string | null;
  objectClass: string | null;
  country: string | null;
  launchDate: string | null;
  missing: string[];
}

function main(): void {
  const { db: dbPath, limit, out } = parseArgs(process.argv.slice(2));
  const db = new Database(dbPath, { readonly: true });

  // In orbit only: a re-entered object's physical model has no use, so spending a
  // crawl on it is wasted effort.
  const rows = db
    .prepare(
      `SELECT norad_id AS noradId,
              COALESCE(name__spacetrack, name__spacebook, name__discos) AS name,
              cospar_id__spacetrack AS cosparId,
              object_class__spacetrack AS objectClass,
              country__spacetrack AS country,
              launch_date__spacetrack AS launchDate,
              manufacturer__spacebook AS mfr,
              bus__spacebook AS bus,
              shape__discos AS shape,
              COALESCE(mass_kg__discos, mass_kg__spacebook) AS mass
         FROM catalogue_wide
        WHERE decay_date__spacetrack IS NULL
          AND object_class__spacetrack IN ('PAYLOAD', 'ROCKET BODY', 'UNKNOWN', '')
          -- Mirrors the window used by the crawler: too new and no reference work has
          -- written it up yet, too old and any write-up was already ingested.
          AND launch_date__spacetrack IS NOT NULL
        ORDER BY launch_date__spacetrack DESC`,
    )
    .all() as Array<Record<string, unknown> & { objectClass: string }>;

  const candidates: Candidate[] = [];
  const byField = new Map<string, number>();

  for (const r of rows) {
    const missing: string[] = [];
    for (const t of TARGETS) {
      if (!t.classes.includes(r.objectClass)) continue;
      const cell = r[t.key];
      if (cell === null || cell === undefined || cell === "") {
        missing.push(t.field);
        byField.set(t.field, (byField.get(t.field) ?? 0) + 1);
      }
    }
    if (missing.length === 0) continue;
    candidates.push({
      noradId: Number(r.noradId),
      name: (r.name as string | null) ?? null,
      cosparId: (r.cosparId as string | null) ?? null,
      objectClass: r.objectClass || null,
      country: (r.country as string | null) ?? null,
      launchDate: (r.launchDate as string | null) ?? null,
      missing,
    });
  }

  console.log(`\n  在轨可补充对象：${candidates.length}\n`);
  console.log(`  按字段：`);
  for (const [f, n] of [...byField].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${f.padEnd(16)} ${String(n).padStart(6)}`);
  }

  /**
   * Prefer the window where documentation exists but our catalogue still lacks it.
   *
   * Measured against a run of the 5 most recent objects: all five 404'd on every
   * reference site, because a satellite launched last week has not been written up
   * anywhere yet. Below ~3 months there is nothing to find; above ~5 years the
   * write-ups were already ingested by the three catalogues. The window between is
   * where a crawl actually produces corroborated values.
   */
  const now = Date.now();
  const monthsSince = (iso: string | null): number | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return (now - t) / (30.44 * 864e5);
  };

  const ranked = [...candidates].sort((a, b) => {
    const score = (c: Candidate): number => {
      const m = monthsSince(c.launchDate);
      if (m === null) return 1e9; // unknown launch date sorts last
      if (m >= 3 && m <= 60) return Math.abs(m - 18); // best around 18 months
      return m < 3 ? 1e6 + (3 - m) * 10 : 1e5 + (m - 60) * 10;
    };
    return score(a) - score(b);
  });

  const selected = ranked.slice(0, limit);
  console.log(`\n  本次候选（按可查到资料的窗口排序，取 ${selected.length} 个）：`);
  for (const c of selected.slice(0, 15)) {
    console.log(
      `    ${String(c.noradId).padStart(6)}  ${String(c.name ?? "—").slice(0, 24).padEnd(26)} ${String(c.launchDate ?? "—").padEnd(12)} 缺 ${c.missing.join(",")}`,
    );
  }
  if (selected.length > 15) console.log(`    … 共 ${selected.length} 个`);

  // Debris is reported separately, with the question that actually applies.
  const debris = db
    .prepare(
      `SELECT COUNT(*) AS n FROM catalogue_wide
        WHERE decay_date__spacetrack IS NULL AND object_class__spacetrack = 'DEBRIS'`,
    )
    .get() as { n: number };

  console.log(`\n  单独处理：在轨碎片 ${debris.n} 个`);
  console.log(`    碎片没有制造商，应补「母体对象 + 解体事件」，不是 manufacturer。`);
  console.log(`    该字段集不在本工具的 TARGETS 内。\n`);

  if (out) {
    mkdirSync(out.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(out, JSON.stringify(selected, null, 2));
    console.log(`  已写出 ${out}\n`);
  }

  db.close();
}

main();
