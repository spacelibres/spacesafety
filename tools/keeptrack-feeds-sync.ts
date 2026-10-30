/**
 * Pull every KeepTrack feed this project uses, in one run.
 *
 * ## What "all the endpoints" turned out to mean
 *
 * The API documents 86. After probing each one:
 *
 *   ingestable in bulk        5   catalogue, conjunctions, reentries, launch stats, upcoming launches
 *   per-object detail        ~8   only reachable one NORAD at a time
 *   filtered views of the    ~20  /text-data combinations, /sats/leo|geo|debris
 *   same rows
 *   not applicable          ~30  positions, radio passes, TV channels, trivia, blog
 *   dangerous                1   /api-key/roll, which invalidates the key in use
 *   broken without params    2   /launch-history, /text-data return 400 as documented
 *
 * Pulling 20 filtered copies of a table we already have would multiply the disk
 * without adding a row of new information; the filters are served from the local
 * table instead. So this fetches the five bulk feeds and stops.
 *
 * Run:
 *   npx tsx tools/keeptrack-feeds-sync.ts
 *   npx tsx tools/keeptrack-feeds-sync.ts --only conjunctions
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { loadEnvLocal } from "../scripts/env";
import {
  fetchLaunchByMonth,
  fetchLaunchBySite,
  fetchLaunchByVehicle,
  fetchLaunchYears,
  fetchMetrics,
  fetchReentries,
  fetchSocrates,
  fetchUpcomingLaunches,
  KeepTrackFeeds,
} from "../src/lib/sources/keeptrack-feeds";

loadEnvLocal();

type FeedName = "conjunctions" | "reentries" | "launches" | "upcoming" | "metrics";

function parseArgs(argv: string[]) {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    db: flag("--db") ?? process.env.SPACE_SAFETY_DB ?? "./data/catalogue.sqlite",
    only: flag("--only") as FeedName | undefined,
    archiveDir: flag("--archive-dir") ?? "data/archive/keeptrack-feeds",
  };
}

function archive(dir: string, name: string, data: unknown): string {
  const day = new Date().toISOString().slice(0, 10);
  const path = join(dir, day);
  mkdirSync(path, { recursive: true });
  const file = join(path, `${name}-${day}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(args.db);
  const feeds = new KeepTrackFeeds(db);
  const want = (n: FeedName) => !args.only || args.only === n;

  console.log("\n  KeepTrack 数据源同步\n");

  // ------------------------------------------------------ conjunctions
  if (want("conjunctions")) {
    const { events, note } = await fetchSocrates();
    if (note) {
      console.log(`  交会事件    失败：${note}`);
    } else {
      archive(args.archiveDir, "socrates", events);
      const n = feeds.replaceConjunctions(events);
      const withPc = events.filter((e) => e.maxProb !== null).length;
      const closest = events.reduce(
        (a, e) => (e.minRangeKm !== null && (a === null || e.minRangeKm < a.minRangeKm!) ? e : a),
        null as (typeof events)[number] | null,
      );
      console.log(`  交会事件    ${n} 个，其中 ${withPc} 个带 Pc`);
      if (closest) {
        console.log(
          `              最近：${closest.sat1Name} × ${closest.sat2Name}  ${closest.minRangeKm} km  TCA ${closest.tca}`,
        );
      }
    }
  }

  // --------------------------------------------------------- reentries
  if (want("reentries")) {
    const { entries, note } = await fetchReentries();
    if (note) {
      console.log(`  预测再入    失败：${note}`);
    } else {
      archive(args.archiveDir, "reentries", entries);
      const n = feeds.replaceReentries(entries);
      console.log(`  预测再入    ${n} 个`);
    }
  }

  // ----------------------------------------------------------- launches
  if (want("launches")) {
    const [years, byVehicle, bySite, byMonth] = await Promise.all([
      fetchLaunchYears(),
      fetchLaunchByVehicle(),
      fetchLaunchBySite(),
      fetchLaunchByMonth(),
    ]);
    archive(args.archiveDir, "launch-stats", { years, byVehicle, bySite, byMonth });
    const n = feeds.replaceLaunchStats(years, byVehicle, bySite, byMonth);
    const last = years.at(-1);
    console.log(`  发射统计    ${n} 行（年度 ${years.length}、火箭 ${byVehicle.length}、发射场 ${bySite.length}、月度 ${byMonth.length}）`);
    if (last) console.log(`              最新年度 ${last.year}：${last.launches} 次发射`);
  }

  // ----------------------------------------------------------- upcoming
  if (want("upcoming")) {
    const upcoming = await fetchUpcomingLaunches();
    archive(args.archiveDir, "upcoming", upcoming);
    const n = feeds.replaceUpcoming(upcoming);
    console.log(`  即将发射    ${n} 次`);
  }

  // ------------------------------------------------------------ metrics
  if (want("metrics")) {
    const m = await fetchMetrics();
    archive(args.archiveDir, "metrics", m);
    console.log(`  统计指标`);
    console.log(`              在轨载荷 ${m.activePayloads ?? "—"}  失效 ${m.inactivePayloads ?? "—"}  碎片 ${m.debris ?? "—"}`);
    console.log(`              在轨总数 ${m.orbitingSatellites ?? "—"}  已再入 ${m.reenteredSatellites ?? "—"}`);
  }

  db.close();
  console.log("");
}

void main();
