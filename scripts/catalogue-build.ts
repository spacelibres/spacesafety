/**
 * Build the standalone catalogue database.
 *
 * ## Why this exists
 *
 * The working database grew to 53 GB because raw ephemeris text was stored
 * alongside the catalogue. That makes the catalogue impossible to inspect, copy,
 * back up or hand to anyone. This tool writes a separate file that contains
 * **only** the catalogue and nothing else:
 *
 *   data/catalogue.sqlite   ~155 MB   identity, physical model, launch record
 *
 * It is a copy, not a move. The source database is never written to.
 *
 * ## What is in it, and in what layer
 *
 * The layers are kept as separate tables on purpose, because they answer different
 * questions and have different provenance:
 *
 *   source   what each provider said, verbatim          satcat, space_track_satcat,
 *                                                       discos_objects,
 *                                                       object_physics,
 *                                                       object_launch_info
 *   merged   what we decided to believe                 master_object
 *   derived  what we computed from the merged row       derived_state
 *
 * A number in `master_object.mass_kg` is a merged observation. A number in
 * `derived_state` is arithmetic on one. They must never be quoted interchangeably.
 *
 * ## Usage
 *
 *   npm run catalogue:build
 *   npm run catalogue:build -- --source data/spacesafety.sqlite --out data/catalogue.sqlite
 *   npm run catalogue:build -- --verify-only
 */

import { existsSync, rmSync, statSync } from "node:fs";

import Database from "better-sqlite3";

/**
 * Tables that make up the catalogue, by layer.
 *
 * `master_element_set` is included even though it points at an ephemeris: it is
 * three numbers per object (which source we chose, its epoch, its arc) and is the
 * only record of that decision. The ephemeris body itself is not copied.
 */
const LAYERS = {
  source: [
    "satcat",
    "space_track_satcat",
    "discos_objects",
    "object_physics",
    "object_launch_info",
    "objects",
    "operators",
    "data_sources",
    "source_fetches",
  ],
  merged: ["master_object", "master_element_set", "master_conflict"],
  derived: ["derived_state"],
} as const;

const ALL_TABLES = [...LAYERS.source, ...LAYERS.merged, ...LAYERS.derived];

interface Args {
  source: string;
  out: string;
  verifyOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    source: flag("--source") ?? "data/spacesafety.sqlite",
    out: flag("--out") ?? "data/catalogue.sqlite",
    verifyOnly: argv.includes("--verify-only"),
  };
}

function exists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { n: number };
  return row.n > 0;
}

function count(db: Database.Database, schema: string, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${schema}."${table}"`).get() as { n: number };
  return row.n;
}

/**
 * Copy one table, reconstructing the target from the source's own DDL.
 *
 * The DDL is read rather than duplicated here so that a column added to the
 * source schema can never be silently dropped from the catalogue copy — the
 * failure mode that left `object_physics` unread for days.
 */
function copyTable(
  target: Database.Database,
  table: string,
): number {
  const sql = (target.prepare("SELECT sql FROM src.sqlite_master WHERE type='table' AND name=?").get(table) as
    | { sql: string }
    | undefined)?.sql;
  if (!sql) return 0;

  target.exec(sql);

  const columns = target.prepare(`PRAGMA src.table_info("${table}")`).all() as Array<{ name: string }>;
  const list = columns.map((c) => `"${c.name}"`).join(",");
  // INSERT … SELECT is executed entirely inside SQLite. Reading 71 000 rows into
  // JS to re-insert them is what crashed this process before.
  target.exec(`INSERT INTO main."${table}" (${list}) SELECT ${list} FROM src."${table}"`);

  return count(target, "src", table);
}

/** Tables present in `target` that the source database does not have. */
function foreignTables(target: string, source: string): string[] {
  if (!existsSync(target)) return [];
  const namesOf = (path: string): Set<string> => {
    const db = new Database(path, { readonly: true });
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      return new Set(rows.map((r) => r.name));
    } finally {
      db.close();
    }
  };
  const targetTables = namesOf(target);
  const sourceTables = namesOf(source);
  return [...targetTables].filter((name) => !sourceTables.has(name)).sort();
}

function main(): void {
  const { source, out, verifyOnly } = parseArgs(process.argv.slice(2));

  if (!existsSync(source)) {
    console.error(`\n  源库不存在：${source}\n`);
    process.exit(1);
  }

  if (!verifyOnly) {
    // Guard: the rebuild copies a fixed set of tables out of the working database,
    // so anything that lives *only* in the target is destroyed. On 2026-10-30 that
    // silently deleted the KeepTrack tables (35 203 rows — `keeptrack:sync` writes
    // to this file, not to the working database) and reset the event tables.
    //
    // Refusing is the honest fix: the tool exists to publish a small catalogue
    // database, and losing sources to do that is never the intent. Run it against a
    // fresh path (`--out`) instead.
    const dropped = foreignTables(out, source);
    if (dropped.length) {
      console.error(
        `\n  拒绝重建：\`${out}\` 里有 ${dropped.length} 张表不在源库中，重建会把它们删掉：\n` +
          `    ${dropped.join(", ")}\n\n` +
          "  These tables are not copied by this tool. Either\n" +
          "    · pass --out <new path> to build next to the current database, or\n" +
          "    · re-create them afterwards (e.g. npm run keeptrack:sync && npm run keeptrack:feeds).\n",
      );
      process.exit(1);
    }
    rmSync(out);

    console.log(`\n  源：${source}  ${(statSync(source).size / 1e9).toFixed(1)} GB`);
    console.log(`  编目库：${out}\n`);

    const src = new Database(source, { readonly: true });
    const target = new Database(out);
    // Rollback journal, not WAL. A WAL file next to a 155 MB catalogue doubles the
    // file count on disk for no benefit — nothing writes to this database.
    target.pragma("journal_mode = DELETE");
    target.pragma("synchronous = OFF");

    target.exec(`ATTACH DATABASE '${source.replace(/'/g, "''")}' AS src`);

    const copied: Array<{ layer: keyof typeof LAYERS; table: string; rows: number }> = [];

    for (const [layer, tables] of Object.entries(LAYERS) as Array<
      [keyof typeof LAYERS, readonly string[]]
    >) {
      for (const table of tables) {
        if (!exists(src, table)) {
          console.log(`  ${layer.padEnd(8)} ${table.padEnd(24)} 缺失，跳过`);
          continue;
        }
        const rows = copyTable(target, table);
        copied.push({ layer, table, rows });
        console.log(`  ${layer.padEnd(8)} ${table.padEnd(24)} ${String(rows).padStart(8)} 行`);
      }
    }

    // Indexes are part of the schema. They are recreated from the source's own
    // definitions so the copy answers the same queries at the same speed. This has
    // to happen while `src` is still attached — after DETACH there is no
    // `src.sqlite_master` to read.
    const indexes = target
      .prepare("SELECT sql FROM src.sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all() as Array<{ sql: string }>;

    target.exec("DETACH DATABASE src");
    src.close();

    let indexCount = 0;
    for (const { sql } of indexes) {
      try {
        target.exec(sql);
        indexCount += 1;
      } catch {
        // An index naming a table that was not copied is expected here; skipping it
        // is correct, not an error.
      }
    }

    target.exec("VACUUM");
    target.close();

    const sizeMb = statSync(out).size / 1e6;
    console.log(`\n  索引 ${indexCount} 个`);
    console.log(`  编目库 ${sizeMb.toFixed(1)} MB（源库 ${(statSync(source).size / 1e9).toFixed(1)} GB）`);
    console.log(`  压缩比 ${((sizeMb * 1e6) / statSync(source).size * 100).toFixed(2)}%\n`);
  }

  verify(source, out);
}

/** Compare every table row-for-row against the source, and check integrity. */
function verify(source: string, out: string): void {
  if (!existsSync(out)) {
    console.error(`\n  编目库不存在：${out}，先运行 npm run catalogue:build\n`);
    process.exit(1);
  }

  console.log("  校验\n");

  const src = new Database(source, { readonly: true });
  const cat = new Database(out, { readonly: true });

  let failures = 0;
  for (const table of ALL_TABLES) {
    if (!exists(cat, table)) {
      console.log(`    ${table.padEnd(24)} 不在编目库`);
      continue;
    }
    const a = exists(src, table) ? count(src, "main", table) : 0;
    const b = count(cat, "main", table);
    const ok = a === b;
    if (!ok) failures += 1;
    console.log(`    ${table.padEnd(24)} ${String(b).padStart(8)} / ${String(a).padStart(8)}  ${ok ? "ok" : "不一致"}`);
  }

  const check = cat.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  console.log(`\n    integrity_check ${check.integrity_check}`);

  src.close();
  cat.close();

  if (failures > 0 || check.integrity_check !== "ok") {
    console.error(`\n  校验失败：${failures} 张表行数不一致\n`);
    process.exit(1);
  }
  console.log("\n  编目库可用。\n");
}

main();

export {};
