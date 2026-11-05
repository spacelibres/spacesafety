/**
 * Health of every ingest, in one screen.
 *
 * Answers the question that takes the longest to answer by hand after an unattended
 * night: **is each source current, and if not, why?**
 *
 * Three traps this is written to avoid, all of which have produced a wrong "all
 * good" in this project:
 *
 *   1. **`ok` is not `fresh`.** A source can fetch successfully every cycle and
 *      still hold data from last week, if it answers 304 or returns nothing new.
 *      Both are reported: last attempt, and last cycle that actually delivered.
 *   2. **An empty table is not an empty source.** `master_element_set` was 0 rows
 *      while the TLEs it is built from sat in `trajectories`, because no step
 *      joined them. Row counts of the *derived* tables are shown next to their
 *      inputs.
 *   3. **A 200 with an error body is a failure.** Space-Track answers a rate limit
 *      with HTTP 200 and `[{"error":"You've violated your query rate limit…"}]`;
 *      that was archived as data. Rows whose `error` is set are listed even when
 *      their status says otherwise.
 *
 *   npm run data:health
 *   npm run data:health -- --verbose     (list every endpoint, not just problems)
 */

import Database from "better-sqlite3";

import { loadEnvLocal } from "../scripts/env";
import { budgetStatus } from "../src/lib/sources/space-track-budget";

loadEnvLocal();

const verbose = process.argv.includes("--verbose");
const db = new Database(process.env.SPACE_SAFETY_DB ?? "./data/catalogue.sqlite", {
  readonly: true,
});

interface FetchRow {
  source_id: string;
  status: string;
  records: number | null;
  bytes: number | null;
  error: string | null;
  finished_at: string;
}

/** Every source's most recent attempt. */
const latest = db
  .prepare(
    `SELECT source_id, status, records, bytes, error, finished_at
       FROM source_fetches f
      WHERE finished_at = (SELECT MAX(finished_at) FROM source_fetches g WHERE g.source_id = f.source_id)
      ORDER BY source_id`,
  )
  .all() as FetchRow[];

/** Last attempt that delivered bytes *or* confirmed the bytes had not changed. */
const lastOk = new Map(
  (
    db
      .prepare(
        `SELECT source_id, MAX(finished_at) AS at FROM source_fetches
          WHERE status IN ('ok', 'unchanged') GROUP BY source_id`,
      )
      .all() as Array<{ source_id: string; at: string }>
  ).map((r) => [r.source_id, r.at]),
);

function age(iso: string | null | undefined): { text: string; hours: number } {
  if (!iso) return { text: "从未", hours: Infinity };
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return { text: `${Math.round(hours * 60)} 分钟前`, hours };
  if (hours < 48) return { text: `${hours.toFixed(1)} 小时前`, hours };
  return { text: `${(hours / 24).toFixed(1)} 天前`, hours };
}

/**
 * Hours after which a source is considered stale. Tuned to each provider's cadence.
 *
 * A source that keeps answering `unchanged` is healthy, not stale: that status means
 * the bytes hash the same as last time, which is the whole point of a conditional
 * request. So the age used below is the age of the last *successful fetch of either
 * kind* (`ok` or `unchanged`), not the age of the last time the bytes differed.
 * ESA DISCOS publishes a few times a week; its `objects` collection has hashed
 * identically for three days and that is the correct answer, not a fault.
 */
function staleAfter(sourceId: string): number {
  if (sourceId.startsWith("space-track-cdm")) return 3;
  if (sourceId.startsWith("space-track-gp")) return 5;
  if (sourceId.startsWith("space-track-tip")) return 26;
  if (sourceId.startsWith("space-track")) return 30;
  if (sourceId === "spacebook-omm-json" || sourceId === "spacebook-omm-kvn") return 5;
  if (sourceId.startsWith("spacebook-omm")) return 30;
  if (sourceId.startsWith("spacebook-xp")) return 5;
  if (sourceId.startsWith("spacebook")) return 30;
  if (sourceId.startsWith("discos")) return 30;
  return 30;
}

const rows = latest.map((r) => {
  const lastOkAge = age(lastOk.get(r.source_id));
  const attemptAge = age(r.finished_at);
  const problems: string[] = [];
  if (r.status === "failed") problems.push("上次抓取失败");
  if (r.error) problems.push(`错误：${r.error.slice(0, 70)}`);
  if (lastOkAge.hours > staleAfter(r.source_id)) {
    problems.push(`${lastOkAge.text}没有成功过（阈值 ${staleAfter(r.source_id)} h）`);
  }
  return { ...r, lastOkAge, attemptAge, problems };
});

const broken = rows.filter((r) => r.problems.length > 0);

console.log("\n  数据源健康\n");

const fmt = (n: number | null) =>
  n === null ? "—" : n.toLocaleString("en-US");

if (broken.length === 0) {
  console.log(`  全部 ${rows.length} 个端点正常。\n`);
  if (!verbose) {
    console.log("  加 --verbose 看每个端点的明细。\n");
  }
} else {
  console.log(`  ${broken.length} / ${rows.length} 个端点有问题：\n`);
  for (const r of broken) {
    console.log(`  ${r.source_id}`);
    console.log(`    最后一次成功   ${r.lastOkAge.text}`);
    console.log(`    最后一次尝试   ${r.attemptAge.text}  ${r.status}  记录 ${fmt(r.records)}`);
    for (const p of r.problems) console.log(`    · ${p}`);
    console.log("");
  }
}

if (verbose) {
  console.log("  ── 全部端点 ────────────────────────────────────────────\n");
  for (const r of rows) {
    const mark = r.problems.length > 0 ? "!" : " ";
    console.log(
      `  ${mark} ${r.source_id.padEnd(32)} ${r.status.padEnd(10)} ` +
        `成功于 ${r.lastOkAge.text.padEnd(12)} 记录 ${fmt(r.records)}`,
    );
  }
  console.log("");
}

// ------------------------------------------------------------------ table rows
//
// Counts of what the pipeline *built*, next to what it was built from. A table at
// 0 with its input non-empty is the failure mode this section exists to catch.
const counts: Array<{ table: string; label: string; from?: string }> = [
  { table: "space_track_satcat", label: "Space-Track SATCAT" },
  { table: "satcat", label: "合并 SATCAT（宽表源）" },
  { table: "discos_objects", label: "DISCOS 对象" },
  { table: "keeptrack_object", label: "KeepTrack 对象" },
  { table: "space_track_cdm_public", label: "Space-Track CDM" },
  { table: "space_track_tip", label: "Space-Track TIP" },
  { table: "socrates_event", label: "SOCRATES 交会" },
  { table: "master_object", label: "L1 主表对象" },
  { table: "object_field_claim", label: "L0 字段声明" },
  { table: "trajectories", label: "星历行（TLE/OMM/OCM）", from: "ingest:tle" },
  { table: "object_sources", label: "各源轨道元素", from: "sources:refresh" },
  { table: "master_element_set", label: "选定规范星历", from: "master:build" },
  { table: "derived_state", label: "L2 派生值", from: "master:build" },
];

console.log("\n  ── 表规模 ──────────────────────────────────────────────\n");
for (const c of counts) {
  let n: number | null = null;
  try {
    n = (db.prepare(`SELECT COUNT(*) AS n FROM "${c.table}"`).get() as { n: number }).n;
  } catch {
    n = null;
  }
  const bad = n === null || n === 0;
  console.log(
    `  ${bad ? "!" : " "} ${c.label.padEnd(24)} ${fmt(n).padStart(10)}` +
      (bad && c.from ? `   ← 应为非空，由 ${c.from} 填充` : ""),
  );
}

console.log("");
db.close();

// ------------------------------------------------------------ Space-Track budget
//
// Reported every run, not only when exhausted. The account was warned on 2026-11-05
// for 667 queries in one hour; a number nobody looks at is not a budget.
const st = budgetStatus();
console.log("  ── Space-Track 调用额度 ────────────────────────\n");
console.log(
  `  ${st.hourCount >= st.hourly ? "!" : " "} 本小时   ${st.hourCount} / ${st.hourly}`,
);
console.log(
  `  ${st.dayCount >= st.daily ? "!" : " "} 今日     ${st.dayCount} / ${st.daily}`,
);
console.log("\n  每次调用 Space-Track 都会先记账；超限时本地直接拒绝发送。\n");
