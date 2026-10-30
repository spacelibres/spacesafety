/**
 * Load the eight archived event feeds into `catalogue.sqlite`.
 *
 * ## Why the archive is the input
 *
 * `scripts/sources-download.ts` writes each capture to
 * `data/archive/<source>/<date>/<id>.json`. This reads those files and nothing
 * else, so:
 *
 *   - the database always reflects a named capture, not "whatever the API said";
 *   - a parser fix re-runs in seconds without re-downloading 50 MB;
 *   - the same loader can be pointed at an older capture to compare.
 *
 * ## Order
 *
 * The feeds are independent — none joins to another inside a single run — so the
 * order below is presentation order, not dependency order.
 *
 * Run:
 *   npx tsx tools/event-feeds-sync.ts
 *   npx tsx tools/event-feeds-sync.ts --only cdm
 *   npx tsx tools/event-feeds-sync.ts --date 2026-10-29 --db ./data/catalogue.sqlite
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { loadEnvLocal } from "../scripts/env";
import {
  BoxScoreLoader,
  DecayLoader,
  EopLoader,
  FragmentationLoader,
  LaunchSiteLoader,
  PublicCdmLoader,
  SpaceWeatherLoader,
  TipLoader,
  type EventFeedLoader,
  type TextFeedLoader,
} from "../src/lib/sources/event-feeds";

loadEnvLocal();

type FeedName = "cdm" | "tip" | "decay" | "frag" | "boxscore" | "site" | "eop" | "weather";

interface FeedSpec {
  name: FeedName;
  label: string;
  /** Archive directory under `data/archive`. */
  dir: string;
  /** `json` files are parsed and handed to the loader; `kv` files go in as text. */
  kind: "json" | "kv";
  make: (db: Database.Database) => EventFeedLoader | TextFeedLoader;
}

const FEEDS: FeedSpec[] = [
  { name: "cdm", label: "公开 CDM    ", dir: "space-track-cdm-public", kind: "json", make: (db) => new PublicCdmLoader(db) },
  { name: "tip", label: "再入预测 TIP", dir: "space-track-tip", kind: "json", make: (db) => new TipLoader(db) },
  { name: "decay", label: "再入历史    ", dir: "space-track-decay", kind: "json", make: (db) => new DecayLoader(db) },
  { name: "frag", label: "解体事件    ", dir: "discos-fragmentations", kind: "json", make: (db) => new FragmentationLoader(db) },
  { name: "boxscore", label: "国别统计    ", dir: "space-track-boxscore", kind: "json", make: (db) => new BoxScoreLoader(db) },
  { name: "site", label: "发射场      ", dir: "space-track-launch-site", kind: "json", make: (db) => new LaunchSiteLoader(db) },
  { name: "eop", label: "地球定向 EOP", dir: "spacebook-eop", kind: "kv", make: (db) => new EopLoader(db) },
  { name: "weather", label: "空间天气    ", dir: "spacebook-spaceweather", kind: "kv", make: (db) => new SpaceWeatherLoader(db) },
];

/** The newest capture directory, or the requested date. */
function captureDir(archiveRoot: string, dir: string, date?: string): string | null {
  const root = join(archiveRoot, dir);
  if (!existsSync(root)) return null;
  const days = readdirSync(root)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const pick = date ?? days.at(-1);
  if (!pick) return null;
  const full = join(root, pick);
  return existsSync(full) ? full : null;
}

function parseArgs(argv: string[]) {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    db: flag("--db") ?? process.env.SPACE_SAFETY_DB ?? "./data/catalogue.sqlite",
    archiveRoot: flag("--archive-root") ?? "data/archive",
    date: flag("--date"),
    only: flag("--only") as FeedName | undefined,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(args.db);
  db.pragma("journal_mode = WAL");

  console.log("\n  事件数据源入库\n");
  console.log(`  数据库  ${args.db}`);
  console.log("");

  const failed: FeedName[] = [];

  for (const feed of FEEDS) {
    if (args.only && args.only !== feed.name) continue;

    const dir = captureDir(args.archiveRoot, feed.dir, args.date);
    if (!dir) {
      console.log(`  ${feed.label}  跳过：没有 ${feed.dir} 的归档`);
      failed.push(feed.name);
      continue;
    }

    const files = readdirSync(dir).filter((f) => (feed.kind === "json" ? f.endsWith(".json") : f.endsWith(".kvn")));
    if (files.length === 0) {
      console.log(`  ${feed.label}  跳过：${dir} 为空`);
      failed.push(feed.name);
      continue;
    }

    const path = join(dir, files[0]);
    const started = Date.now();
    try {
      const loader = feed.make(db);
      const input =
        feed.kind === "json"
          ? (unwrapJsonApi(JSON.parse(readFileSync(path, "utf8"))) as unknown as never)
          : (readFileSync(path, "utf8") as unknown as never);
      const n = loader.run(input);
      const ms = Date.now() - started;
      console.log(`  ${feed.label}  ${String(n).padStart(7)} 行  ${String(ms).padStart(5)} ms  ${files[0]}`);
    } catch (err) {
      console.log(`  ${feed.label}  失败：${(err as Error).message}`);
      failed.push(feed.name);
    }
  }

  // ------------------------------------------------------------- summary
  console.log("\n  表内现有行数\n");
  const tables = [
    ["space_track_cdm_public", "公开 CDM"],
    ["space_track_tip", "再入预测 TIP"],
    ["space_track_decay", "再入历史"],
    ["discos_fragmentation", "解体事件"],
    ["space_track_boxscore", "国别统计"],
    ["launch_site", "发射场"],
    ["earth_orientation", "地球定向 EOP"],
    ["space_weather", "空间天气"],
  ] as const;
  for (const [table, label] of tables) {
    try {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      console.log(`  ${label.padEnd(14)}${String(r.n).padStart(8)}`);
    } catch {
      console.log(`  ${label.padEnd(14)}       —`);
    }
  }

  // --------------------------------------------------- joinability check
  //
  // These feeds exist to be read alongside the catalogue, so the number that
  // matters is not the row count but how many rows name an object the catalogue
  // actually has. Printing it here makes a broken join visible immediately
  // instead of when a page renders an empty column.
  console.log("\n  与编目表的关联率\n");

  const wide = db.prepare(
    "SELECT COUNT(*) AS n FROM pragma_database_list WHERE name = 'wide'",
  ).get() as { n: number };
  const wideTable = wide.n ? "wide.catalogue_wide" : null;
  const catTable = tableExists(db, "space_track_satcat") ? "space_track_satcat" : null;

  if (!catTable && !wideTable) {
    console.log("  跳过：编辑表未找到");
  } else {
    const has = (noradExpr: string) =>
      wideTable
        ? `EXISTS (SELECT 1 FROM ${wideTable} w WHERE w.norad_id = ${noradExpr})`
        : `EXISTS (SELECT 1 FROM space_track_satcat s WHERE s.norad_id = ${noradExpr})`;

    for (const [table, label, expr] of [
      ["space_track_cdm_public", "公开 CDM", "space_track_cdm_public.sat1_norad"],
      ["space_track_tip", "再入预测 TIP", "space_track_tip.norad_id"],
      ["space_track_decay", "再入历史", "space_track_decay.norad_id"],
    ] as const) {
      try {
        const r = db
          .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN ${has(expr)} THEN 1 ELSE 0 END) AS matched
             FROM ${table}`,
          )
          .get() as { total: number; matched: number };
        const pct = r.total ? ((r.matched / r.total) * 100).toFixed(1) : "0.0";
        console.log(`  ${label.padEnd(14)}${String(r.matched).padStart(8)} / ${String(r.total).padStart(8)}  ${pct}%`);
      } catch (err) {
        console.log(`  ${label.padEnd(14)}  关联检查失败：${(err as Error).message}`);
      }
    }
  }

  console.log("");
  if (failed.length) console.log(`  ${failed.length} 个数据源未入库：${failed.join(", ")}\n`);
  db.close();
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/**
 * DISCOSweb answers in JSON:API, where the records are under `data`. Space-Track
 * answers with a bare array. Rather than make every loader know which source it
 * came from, the driver unwraps here.
 */
function unwrapJsonApi(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && "data" in payload) {
    const data = (payload as { data: unknown }).data;
    if (Array.isArray(data)) return data;
  }
  return payload;
}

main();
