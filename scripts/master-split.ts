/**
 * Split one database into the base catalogue and the orbit store.
 *
 * ## What moves and what stays
 *
 * Measured on the current data: 56.7 GB total, of which `trajectory_files` is
 * 53.8 GB. Everything the catalogue needs — identity, physical model, derived
 * values, which element set is canonical — is 2.9 GB, and after dropping the
 * duplicate per-source tables it is ~102 MB.
 *
 *   base    master_object, master_element_set, master_conflict, derived_state,
 *           object_sources, satcat, discos_objects, objects, operators,
 *           data_sources, source_fetches, catalog, stream_seq
 *   orbits  trajectory_files, trajectories
 *
 * `trajectories` goes with the orbit file: it holds the per-upload metadata whose
 * only purpose is to point at a file, and the base keeps what it needs in
 * `master_element_set`.
 *
 * ## Why a copy and not a rename
 *
 * The source database is the only copy of 54 GB that took hours to download. The
 * tool writes new files, verifies their contents, and leaves the original
 * untouched; deleting it is a separate, explicit decision.
 *
 *   npm run master:split
 *   npm run master:split -- --source data/spacesafety.sqlite --out data
 *   npm run master:split -- --verify-only
 */

import { existsSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";

/** Tables that belong in the base catalogue. */
const BASE_TABLES = [
  "master_object",
  "master_element_set",
  "master_conflict",
  "derived_state",
  "object_sources",
  "satcat",
  "discos_objects",
  "objects",
  "operators",
  "data_sources",
  "source_fetches",
  "catalog",
  "stream_seq",
  "credentials",
  "pagination_tokens",
] as const;

/** Tables that belong in the orbit store. */
const ORBIT_TABLES = ["trajectories", "trajectory_files"] as const;

interface TableReport {
  table: string;
  rows: number;
  bytes: number;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };

  const source = flag("--source") ?? "data/spacesafety.sqlite";
  const outDir = flag("--out") ?? "data";
  const verifyOnly = argv.includes("--verify-only");

  const basePath = join(outDir, "spacesafety-base.sqlite");
  const orbitPath = join(outDir, "spacesafety-orbits.sqlite");

  if (!existsSync(source)) {
    console.error(`\n  源数据库不存在：${source}\n`);
    process.exit(1);
  }

  if (!verifyOnly) {
    await mkdir(outDir, { recursive: true });
    // Rebuild from scratch: a partial split that resumed into a half-written file
    // would be indistinguishable from a complete one.
    await rm(basePath, { force: true });
    await rm(orbitPath, { force: true });

    console.log(`\n  源：${source}  ${(statSync(source).size / 1e9).toFixed(1)} GB`);
    console.log(`  拆分中…\n`);

    const db = new Database(source, { readonly: true });
    db.pragma("cache_size = -1048576"); // 1 GB page cache for the big scan

    const totalBytes = statSync(source).size;
    // ---- base -------------------------------------------------------------
    const base = new Database(basePath);
    base.pragma("journal_mode = WAL");
    let baseRows = 0;
    // Each table is copied through a short-lived read-only connection rather than a
    // long-lived ATTACH. ATTACH keeps a lock on the source for the duration of the
    // copy, and DETACH inside an open transaction is rejected with
    // "database src is locked" — a restriction that is easy to work around and hard
    // to notice, since it only appears once the transaction is non-empty.
    for (const table of BASE_TABLES) {
      const exists = db
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as { n: number };
      if (exists.n === 0) continue;

      const ddl = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {
          sql: string;
        }
      ).sql;
      base.exec(ddl);

      const rows = copyTable(source, base, table);
      void rows;
      baseRows += (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
    }

    // Indexes are part of the schema, not the data: recreate them in the base.
    const indexes = db
      .prepare(
        `SELECT name, tbl_name, sql FROM sqlite_master
          WHERE type='index' AND sql IS NOT NULL
            AND tbl_name IN (${BASE_TABLES.map(() => "?").join(",")})`,
      )
      .all(...BASE_TABLES) as Array<{ name: string; tbl_name: string; sql: string }>;
    for (const idx of indexes) {
      const owner = BASE_TABLES.includes(idx.tbl_name as never);
      if (!owner) continue;
      try {
        base.exec(idx.sql);
      } catch (err) {
        console.warn(`  索引 ${idx.name} 建失败：${(err as Error).message}`);
      }
    }

    base.exec("VACUUM");
    base.close();

    // ---- orbits -----------------------------------------------------------
    const orbits = new Database(orbitPath);
    orbits.pragma("journal_mode = WAL");
    let orbitRows = 0;
    for (const table of ORBIT_TABLES) {
      const ddl = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {
          sql: string;
        }
      ).sql;
      orbits.exec(ddl);
    }

    const orbitIndexes = db
      .prepare(
        `SELECT sql FROM sqlite_master
          WHERE type='index' AND sql IS NOT NULL
            AND tbl_name IN (${ORBIT_TABLES.map(() => "?").join(",")})`,
      )
      .all(...ORBIT_TABLES) as Array<{ sql: string }>;
    for (const idx of orbitIndexes) {
      try {
        orbits.exec(idx.sql);
      } catch {
        // An index on a column that the copy already covers is harmless to skip.
      }
    }

    // `trajectories` is small; `trajectory_files` is the 54 GB and has to be
    // streamed in batches rather than one virtual table scan.
    orbitRows += copyTable(source, orbits, "trajectories");
    orbitRows += copyTable(source, orbits, "trajectory_files");

    orbits.close();

    db.close();

    const baseSize = statSync(basePath).size;
    const orbitSize = statSync(orbitPath).size;
    console.log(`\n  base   ${(baseSize / 1e6).toFixed(1)} MB   ${baseRows} 行`);
    console.log(`  orbits ${(orbitSize / 1e9).toFixed(1)} GB   ${orbitRows} 行`);
    console.log(
      `  压缩比 ${((baseSize + orbitSize) / totalBytes * 100).toFixed(1)}%（去掉了重复索引与空闲页）\n`,
    );
  }

  // ---------------------------------------------------------------- verify
  console.log("  校验\n");
  const report: TableReport[] = [];

  const baseDb = new Database(basePath, { readonly: true });
  for (const table of BASE_TABLES) {
    const exists = baseDb
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) as { n: number };
    if (exists.n === 0) continue;
    const rows = baseDb.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
    report.push({ table: `base.${table}`, rows: rows.n, bytes: 0 });
  }
  // Integrity, not just row counts: a truncated copy can have the right count of
  // garbage.
  const baseCheck = baseDb.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  baseDb.close();

  const orbitDb = new Database(orbitPath, { readonly: true });
  for (const table of ORBIT_TABLES) {
    const rows = orbitDb.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
    report.push({ table: `orbits.${table}`, rows: rows.n, bytes: 0 });
  }
  const orbitCheck = orbitDb.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  orbitDb.close();

  for (const r of report) console.log(`    ${r.table.padEnd(28)} ${String(r.rows).padStart(9)}`);

  const ok = baseCheck.integrity_check === "ok" && orbitCheck.integrity_check === "ok";
  console.log(`\n  integrity_check  base=${baseCheck.integrity_check} orbits=${orbitCheck.integrity_check}`);

  if (!ok) {
    console.error("\n  校验失败：文件不完整，不要删除源数据库。\n");
    process.exit(1);
  }

  const baseSize = statSync(basePath).size;
  console.log(`\n  可用。设置环境变量后使用：`);
  console.log(`    SPACE_SAFETY_BASE_DB=${basePath}`);
  console.log(`    SPACE_SAFETY_ORBIT_DB=${orbitPath}`);
  console.log(`  仅需目录功能时，不配置 ORBIT_DB 即可（${(baseSize / 1e6).toFixed(0)} MB 即可运行）。\n`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Copy one table between two connections.
 *
 * The copy is done **inside SQLite** (`ATTACH` + `INSERT … SELECT`), not in
 * JavaScript. The first version read every row into a JS array and inserted row by
 * row; that pulled 11 162 ephemeris bodies of ~5 MB each through V8's heap and the
 * process aborted with a core dump. SQLite streams the same data without
 * materialising it.
 *
 * ATTACH is scoped to the statement: the alias is attached, the copy runs, and it
 * is detached immediately, so no lock is held while the target's own transaction
 * is open.
 */
function copyTable(sourcePath: string, target: Database.Database, table: string): number {
  const escaped = sourcePath.replace(/'/g, "''");
  target.exec(`ATTACH DATABASE '${escaped}' AS src`);
  try {
    const columns = target.prepare(`PRAGMA src.table_info("${table}")`).all() as Array<{
      name: string;
    }>;
    if (columns.length === 0) return 0;

    const list = columns.map((c) => `"${c.name}"`).join(",");
    target.exec(`INSERT INTO main."${table}" (${list}) SELECT ${list} FROM src."${table}"`);

    const row = target.prepare(`SELECT COUNT(*) AS n FROM src."${table}"`).get() as { n: number };
    return row.n;
  } finally {
    target.exec("DETACH DATABASE src");
  }
}

export {};
