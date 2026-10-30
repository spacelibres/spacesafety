/**
 * Data scheduler — fetch each source at *its own* published frequency.
 *
 * ## What "daily refresh" actually means per source
 *
 * The three live catalogues do not update on the same clock, so a single nightly
 * sweep is wrong in both directions: it fetches Spacebook's 2-hourly element sets
 * twelve times too late, and it re-downloads 72 k-row SATCAT tables that only
 * change once a day.
 *
 * | source | endpoint | published frequency | in \`downloads.ts\` |
 * |---|---|---|---|
 * | Space-Track | GP | 每 2 小时 | 120 min |
 * | Space-Track | SATCAT / decay / boxscore / launch-site | 每日 | 1440 min |
 * | Space-Track | TIP | 6 小时 | 360 min |
 * | Space-Track | public CDM | 1 小时 | 60 min |
 * | Spacebook | OMM / entity-TLE / supplemental | 每 2 小时 | 120 min |
 * | Spacebook | SATCAT / details / weather / EOP | 每日 | 1440 min |
 * | KeepTrack | catalogue + 5 feeds | 每日 | 每日一次（此脚本判定）|
 * | DISCOS | objects / launches / fragmentations | 不定期 | 1440 min |
 * | DISCOS | reference / orbits | 近乎静态 | 10080 min |
 *
 * The frequencies live in `src/lib/sources/downloads.ts`; this script *uses* them
 * rather than repeating them, so "which sources are due" has one definition.
 *
 * ## One cycle
 *
 *   1. Ask `dueForRefresh()` which endpoints are past their frequency.
 *   2. Fetch those (via `scripts/sources-download.ts`, the tested path).
 *   3. If KeepTrack's archive is not from today, sync it and its five feeds.
 *   4. If anything was fetched, rebuild what depends on it:
 *      load → wide → classify, plus the event feeds when a Space-Track feed moved.
 *
 * Nothing is rebuilt when nothing changed, so a 10-minute cycle is cheap.
 *
 *   npm run data:schedule -- --status    # per-source frequency and due time
 *   npm run data:schedule -- --once      # one cycle (this is what a timer calls)
 *   npm run data:schedule -- --loop      # stay resident, honouring frequencies
 *   npm run data:schedule -- --once --dry-run
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG_DIR = join(ROOT, "data", "logs");
const LOG_FILE = join(LOG_DIR, "data-schedule.log");

/** Endpoints that feed the event tables rather than the catalogue. */
const EVENT_ENDPOINTS = new Set([
  "space-track-cdm-public",
  "space-track-tip",
  "space-track-decay",
  "space-track-boxscore",
  "space-track-launch-site",
  "discos-fragmentation",
  "spacebook-eop",
  "spacebook-spaceweather",
]);

function log(line: string): void {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const text = `[${stamp}] ${line}`;
  console.log(`  ${text}`);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${text}\n`);
  } catch {
    // Logging must never break the cycle.
  }
}

function run(command: string, args: string[]): void {
  execFileSync(command, args, { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
}

/** Newest dated folder in `data/archive/<source>/`, as `YYYY-MM-DD`. */
function newestArchiveDay(sourceId: string): string | null {
  const dir = join(ROOT, "data", "archive", sourceId);
  if (!existsSync(dir)) return null;
  const days = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
  return days.length ? days[days.length - 1] : null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export class DataScheduler {
  constructor(private readonly dryRun: boolean) {}

  /** Per-source frequency table, last success, and when it is next due. */
  async status(): Promise<string[]> {
    const { getDb } = await import("../src/db");
    const { DOWNLOADS, dueForRefresh } = await import("../src/lib/sources/downloads");
    const { sqlite } = getDb();

    const rows = sqlite
      .prepare(
        `SELECT source_id, MAX(finished_at) AS last_ok
           FROM source_fetches WHERE status = 'ok' GROUP BY source_id`,
      )
      .all() as Array<{ source_id: string; last_ok: string }>;
    const lastSuccess = new Map(rows.map((r) => [r.source_id, r.last_ok]));
    const due = new Set(dueForRefresh(lastSuccess).map((d) => d.id));

    const lines: string[] = [];
    for (const spec of DOWNLOADS) {
      const last = lastSuccess.get(spec.id);
      const label =
        spec.refreshMinutes < 60
          ? `${spec.refreshMinutes} 分钟`
          : spec.refreshMinutes < 1440
            ? `${spec.refreshMinutes / 60} 小时`
            : `${spec.refreshMinutes / 1440} 天`;
      lines.push(
        `  ${due.has(spec.id) ? "到期" : "  · "}  ${spec.id.padEnd(28)} ${label.padEnd(8)} 上次 ${last ?? "从未"}`,
      );
    }
    const keepDay = newestArchiveDay("keeptrack-sats");
    lines.push(
      `  ${keepDay === today() ? "  · " : "到期"}  ${"keeptrack".padEnd(28)} ${"1 天".padEnd(8)} 上次 ${keepDay ?? "从未"}`,
    );
    return lines;
  }

  /** Build the plan for this cycle without fetching anything. */
  async plan(): Promise<{ due: string[]; keepTrack: boolean; events: boolean }> {
    const { getDb } = await import("../src/db");
    const { dueForRefresh } = await import("../src/lib/sources/downloads");
    const { sqlite } = getDb();
    const rows = sqlite
      .prepare(
        `SELECT source_id, MAX(finished_at) AS last_ok
           FROM source_fetches WHERE status = 'ok' GROUP BY source_id`,
      )
      .all() as Array<{ source_id: string; last_ok: string }>;
    const lastSuccess = new Map(rows.map((r) => [r.source_id, r.last_ok]));
    const due = dueForRefresh(lastSuccess).map((d) => d.id);
    return {
      due,
      keepTrack: newestArchiveDay("keeptrack-sats") !== today(),
      events: due.some((id) => EVENT_ENDPOINTS.has(id)),
    };
  }

  async cycle(): Promise<number> {
    const { due, keepTrack, events } = await this.plan();
    log(
      `周期开始：${due.length} 个端点到期${keepTrack ? "，KeepTrack 需要同步" : ""}` +
        (due.length ? `\n      到期：${due.join(", ")}` : ""),
    );

    if (this.dryRun) {
      log("--dry-run：不执行抓取与重建");
      return 0;
    }

    let fetched = false;
    if (due.length) {
      try {
        run("npm", ["run", "sources:download", "--", "--only", due.join(",")]);
        fetched = true;
        log(`下载完成：${due.length} 个端点`);
      } catch (err) {
        log(`下载失败：${String((err as { stderr?: string }).stderr ?? "").trim().split("\n").slice(-3).join(" / ")}`);
        return 1;
      }
    }

    if (keepTrack) {
      try {
        run("npm", ["run", "keeptrack:sync"]);
        run("npm", ["run", "keeptrack:feeds"]);
        log("KeepTrack 已同步（编目 + 五类 feeds）");
      } catch (err) {
        log(`KeepTrack 同步失败：${String((err as { stderr?: string }).stderr ?? "").trim().slice(-200)}`);
        return 1;
      }
    }

    if (!fetched && !keepTrack) {
      log("没有数据变化，跳过重建");
      return 0;
    }

    // Rebuild only what the fetched data feeds. The order is the one documented
    // in `docs/CATALOGUE-FINAL.md` §7.0 — `catalogue:build` is deliberately absent:
    // it rebuilds `catalogue.sqlite` from the working database and would drop the
    // KeepTrack tables that live only in the former.
    try {
      run("npm", ["run", "sources:load"]);
      run("npx", ["tsx", "tools/build-wide-catalogue.ts"]);
      run("npm", ["run", "catalogue:classify"]);
      log("编目链路已重建：load → wide → classify");
      if (events) {
        run("npm", ["run", "ingest:events"]);
        log("事件表已刷新（CDM / TIP / 再入 / EOP / 天气）");
      }
    } catch (err) {
      log(`重建失败：${String((err as { stderr?: string }).stderr ?? "").trim().split("\n").slice(-3).join(" / ")}`);
      return 1;
    }

    const { getDb } = await import("../src/db");
    const { sqlite } = getDb();
    const wide = (
      sqlite.prepare("SELECT COUNT(*) AS n FROM object_classification").get() as { n: number }
    ).n;
    log(`周期完成：分类表 ${wide} 行`);
    return 0;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // `SPACE_SAFETY_DB` lives in `.env.local`; every other script calls this first.
  // Skipping it silently pointed the scheduler at the 53 GB working database and
  // made every source look a day overdue.
  const { loadEnvLocal } = await import("../scripts/env");
  loadEnvLocal();
  const scheduler = new DataScheduler(argv.includes("--dry-run"));

  console.log("\n数据调度\n");

  if (argv.includes("--status")) {
    for (const line of await scheduler.status()) console.log(line);
    console.log("");
    process.exit(0);
  }

  const plan = await scheduler.plan();
  if (argv.includes("--dry-run")) {
    for (const line of await scheduler.status()) console.log(line);
    console.log(`\n  本次将抓取：${plan.due.length ? plan.due.join(", ") : "（无）"}`);
    console.log(`  KeepTrack：${plan.keepTrack ? "需要同步" : "今天已同步"}`);
    console.log(`  事件表：${plan.events ? "需要刷新" : "无需刷新"}\n`);
  }

  if (!argv.includes("--loop")) {
    process.exit(await scheduler.cycle());
  }

  // Resident mode: honour each source's own frequency by re-planning often.
  const everyMs = Number(process.env.SPACE_SAFETY_SCHEDULE_INTERVAL_MINUTES ?? "10") * 60_000;
  for (;;) {
    await scheduler.cycle();
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

void main();
