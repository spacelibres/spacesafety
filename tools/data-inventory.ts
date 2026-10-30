/**
 * Inventory and health check for every dataset that is **not** the catalogue and
 * **not** the orbit pipeline.
 *
 * ## Why this exists
 *
 * The catalogue is finished and has its own document (`docs/CATALOGUE-FINAL.md`)
 * and its own verification (`npm run test:wide`). Everything else — public CDMs,
 * re-entry predictions, the decay record, space weather, earth orientation,
 * fragmentation events, the launch feeds — was downloaded into tables that
 * **nothing read**. Ten datasets, ~225 k rows, invisible: not broken, not shown.
 *
 * That is a specific failure mode worth naming. A pipeline that stores data and
 * never reads it looks healthy from every angle the tests covered: the download
 * succeeded, the row count went up, the loader was idempotent. Nothing was wrong
 * except that the data may as well not exist.
 *
 * So this tool answers four questions per dataset:
 *
 *   1. **Is it there?** rows, and whether emptiness is expected.
 *   2. **Is it unique?** duplicate rows on the declared key must be zero.
 *   3. **Does it line up?** time columns complete, daily series without gaps,
 *      object references resolving in the catalogue.
 *   4. **Does anything read it?** the consumer, or an explicit "仅入库".
 *
 * ## Usage
 *
 *   npm run data:inventory              # table + summary, exit 1 on a failed check
 *   npm run data:inventory -- --json    # machine-readable, for a diff over time
 *   npm run data:inventory -- --domain cdm-public
 */

import type Database from "better-sqlite3";

/** One dataset, described by what it means rather than by its columns. */
interface Domain {
  id: string;
  table: string;
  label: string;
  /** Which service produced it, and under which `downloads.ts` endpoint id. */
  origin: string;
  endpoint: string | null;
  /**
   * The column that carries time, and what that time *means*.
   *
   * `column: null` marks a snapshot with no time dimension at all — the box score
   * is "as of when the file was generated", which the file itself does not record.
   */
  time: { column: string | null; meaning: string };
  /** The natural key. Duplicates on it are a defect. */
  key: string[];
  /** Where it is read, or `null` when nothing reads it yet. */
  consumer: string | null;
  /** Fake content fetched at build time, so no network is touched here. */
  optional?: boolean;
}

/**
 * The datasets in this inventory.
 *
 * `time.meaning` is not decoration: `space_track_decay` mixes a *predicted*
 * re-entry epoch with the epoch at which 18 SDS stopped tracking the object, and
 * reading `decay_epoch` as "when it burned up" is wrong for the prediction rows.
 * Writing the distinction down is the point.
 */
const DOMAINS: Domain[] = [
  {
    id: "cdm-public",
    table: "space_track_cdm_public",
    label: "公开发布的 CDM",
    origin: "Space-Track `/class/cdm_public`（EMERGENCY_REPORTABLE）",
    endpoint: "space-track-cdm-public",
    time: {
      column: "tca",
      meaning: "预计最接近时刻。TCA 晚于现在的行仍是预测，早于现在的行已成历史。",
    },
    key: ["cdm_id"],
    consumer: "app/conjunctions（页面）· api/v1/cdm?source=public",
  },
  {
    id: "tip",
    table: "space_track_tip",
    label: "再入预测（TIP）",
    origin: "Space-Track `/class/tip`",
    endpoint: "space-track-tip",
    time: {
      column: "decay_epoch",
      meaning: "被预测的再入时刻（不是消息发出的时刻，那是 msg_epoch）。",
    },
    key: ["norad_id", "msg_epoch"],
    consumer: null,
  },
  {
    id: "decay",
    table: "space_track_decay",
    label: "再入记录（合并四源）",
    origin:
      "Space-Track：`decay`、`60day_msg`、`tip` 与 SATCAT 的 DECAY_DATE 合并（`source` 列标明来源）",
    endpoint: "space-track-decay",
    time: {
      column: "decay_epoch",
      meaning:
        "18 SDS 停止跟踪该物体的时刻。`msg_type='Prediction'` 的行是预测值，" +
        "`'Historical'` 才是既成事实——同一物体可能两者都有。",
    },
    key: ["norad_id", "msg_epoch"],
    consumer: null,
  },
  {
    id: "space-weather",
    table: "space_weather",
    label: "空间天气（逐日）",
    origin: "Spacebook `/api/spaceweather/full`",
    endpoint: "spacebook-spaceweather",
    time: { column: "day", meaning: "观测日的 UTC 日期，逐日一行。" },
    key: ["day"],
    consumer: null,
  },
  {
    id: "eop",
    table: "earth_orientation",
    label: "地球定向参数（逐日）",
    origin: "Spacebook `/api/eop/full`",
    endpoint: "spacebook-eop",
    time: { column: "mjd", meaning: "修正儒略日，逐日一行。" },
    key: ["mjd"],
    consumer: null,
  },
  {
    id: "fragmentation",
    table: "discos_fragmentation",
    label: "解体事件",
    origin: "ESA DISCOSweb `/api/fragmentations`",
    endpoint: "discos-fragmentations",
    time: {
      column: "epoch",
      meaning:
        "解体日期。DISCOS 只给日期（`1979-12-15`），不给时刻，因此按日期存、不补零点。",
    },
    key: ["discos_id"],
    consumer: null,
  },
  {
    id: "boxscore",
    table: "space_track_boxscore",
    label: "各国家/组织在轨与再入数量",
    origin: "Space-Track `/class/boxscore`",
    endpoint: "space-track-boxscore",
    time: {
      column: null,
      meaning: "无时间列：文件生成时刻的快照，权威方自报的分组统计。",
    },
    key: ["country"],
    consumer: null,
  },
  {
    id: "keeptrack-conjunction",
    table: "keeptrack_conjunction",
    label: "KeepTrack 交会告警",
    origin: "KeepTrack `/v4/conjunctions`",
    endpoint: "keeptrack-feeds",
    time: { column: "tca", meaning: "预计最接近时刻。" },
    key: ["id"],
    consumer: "app/screening/socrates（页面）",
  },
  {
    id: "keeptrack-launch-stat",
    table: "keeptrack_launch_stat",
    label: "KeepTrack 发射统计",
    origin: "KeepTrack `/v4/launch/stats`",
    endpoint: "keeptrack-feeds",
    time: { column: "fetched_at", meaning: "抓取时刻（上游未给时间列）。" },
    key: ["kind", "key1", "key2"],
    consumer: null,
  },
  {
    id: "keeptrack-reentry",
    table: "keeptrack_reentry",
    label: "KeepTrack 再入预测",
    origin: "KeepTrack `/v4/reentry`",
    endpoint: "keeptrack-feeds",
    time: { column: "decay_epoch", meaning: "被预测的再入时刻。" },
    key: ["norad_id"],
    consumer: null,
  },
  {
    id: "keeptrack-upcoming-launch",
    table: "keeptrack_upcoming_launch",
    label: "KeepTrack 待发射",
    origin: "KeepTrack `/v4/launch/upcoming`",
    endpoint: "keeptrack-feeds",
    time: { column: "net", meaning: "计划发射时刻（No Earlier Than）。" },
    key: ["id"],
    consumer: null,
  },
];

/**
 * Tables that are empty **on purpose**, with the reason.
 *
 * Listed so "0 rows" is never mistaken for a failure. Each one is asserted empty
 * only in the sense that its emptiness is documented — the moment one of them
 * gains rows, this list must change, and that is the signal.
 */
const EXPECTED_EMPTY: Array<{ table: string; reason: string }> = [
  {
    table: "trajectories",
    reason: "没有上传星历的运营方。官方 API 的星历与 CDM 都建立在这张表之上。",
  },
  {
    table: "trajectory_files",
    reason: "同上：没有星历文件就没有正文。",
  },
  {
    table: "cdms",
    reason:
      "自主筛查产物。没有 operator_ephemeris 星历就无法筛查，所以为空；" +
      "公开发布的 CDM 存在 space_track_cdm_public，两者不可混为一谈。",
  },
  {
    table: "events",
    reason: "交会事件是自主筛查的上层聚合，随 cdms 一起为空。",
  },
  {
    table: "object_sources",
    reason: "逐源元素集对照表；该链路在轨道数据一侧，本轮不整理。",
  },
  {
    table: "master_element_set",
    reason: "轨道元素集选择结果；同上，属于轨道数据。",
  },
  {
    table: "catalog",
    reason: "运营方自有星历的索引，随 trajectories 一起为空。",
  },
  {
    table: "credentials",
    reason: "本部署用环境变量存凭据，不用数据库表。",
  },
  {
    table: "screening_jobs",
    reason: "没有自主筛查任务，队列为空。",
  },
  {
    table: "pagination_tokens",
    reason: "分页游标只在有 API 输出时产生，当前无数据可翻页。",
  },
];

interface Args {
  json: boolean;
  domain: string | null;
}

function parseArgs(argv: string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  return { json: argv.includes("--json"), domain: flag("--domain") ?? null };
}

interface Row {
  id: string;
  table: string;
  label: string;
  rows: number;
  keys: number;
  duplicateKeys: number;
  timeColumn: string | null;
  timeFirst: string | null;
  timeLast: string | null;
  nullTimes: number;
  gaps: number | null;
  joinCoverage: string | null;
  consumer: string | null;
  freshnessDays: number | null;
}

function tableExists(sqlite: Database.Database, table: string): boolean {
  const row = sqlite
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as { n: number };
  return row.n > 0;
}

function count(sqlite: Database.Database, sql: string, ...params: unknown[]): number {
  const row = sqlite.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Midnight-anchored day difference; `null` when the value is not a date. */
/** MJD → ISO date, so the EOP series shows a date instead of 61342. */
function mjdToIso(mjd: string): string {
  const days = Number(mjd);
  if (!Number.isFinite(days)) return mjd;
  return new Date((days - 40587) * 86_400_000).toISOString().slice(0, 10);
}

function daysSince(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  // `mjd` is a number of days, not a date string: 40587 is the MJD of 1970-01-01.
  const numeric = Number(value);
  const ms = Number.isFinite(numeric) && String(numeric) === value
    ? (numeric - 40587) * 86_400_000
    : Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(ms)) return null;
  return Math.floor((now - ms) / 86_400_000);
}

function inspect(sqlite: Database.Database, domain: Domain): Row {
  if (!tableExists(sqlite, domain.table)) {
    return {
      id: domain.id,
      table: domain.table,
      label: domain.label,
      rows: 0,
      keys: 0,
      duplicateKeys: 0,
      timeColumn: domain.time.column,
      timeFirst: null,
      timeLast: null,
      nullTimes: 0,
      gaps: null,
      joinCoverage: null,
      consumer: domain.consumer,
      freshnessDays: null,
    };
  }

  const rows = count(sqlite, `SELECT COUNT(*) AS n FROM "${domain.table}"`);
  // SQLite's `||` yields NULL when any operand is NULL, and `COUNT(DISTINCT NULL)`
  // skips those rows — which reported 895 phantom duplicates on a table whose key
  // legitimately contains NULL (`keeptrack_launch_stat.key2` is NULL for the
  // year/month rows, where only `kind` + `key1` identify the row).
  const keyExpr = domain.key
    .map((c) => `COALESCE(CAST("${c}" AS TEXT), char(1))`)
    .join("||'|'||");
  const keys = count(sqlite, `SELECT COUNT(DISTINCT ${keyExpr}) AS n FROM "${domain.table}"`);
  const timeCol = domain.time.column ? `"${domain.time.column}"` : null;

  const minMax = timeCol
    ? (sqlite
        .prepare(`SELECT MIN(${timeCol}) AS first, MAX(${timeCol}) AS last FROM "${domain.table}"`)
        .get() as { first: string | number | null; last: string | number | null })
    : { first: null, last: null };

  const nullTimes = timeCol
    ? count(
        sqlite,
        `SELECT COUNT(*) AS n FROM "${domain.table}"
          WHERE ${timeCol} IS NULL OR CAST(${timeCol} AS TEXT) = ''`,
      )
    : 0;

  // Gaps are only meaningful for a daily series with a numeric/date day column.
  let gaps: number | null = null;
  if (domain.id === "space-weather") {
    const span = count(
      sqlite,
      `SELECT CAST(julianday(MAX(day)) - julianday(MIN(day)) + 1 AS INTEGER) AS n FROM space_weather`,
    );
    gaps = Math.max(0, span - rows);
  } else if (domain.id === "eop") {
    const span = count(sqlite, `SELECT MAX(mjd) - MIN(mjd) + 1 AS n FROM earth_orientation`);
    gaps = Math.max(0, span - rows);
  }

  // Object references must resolve in the catalogue: an event about an object we
  // cannot name is a row a reader cannot use.
  let joinCoverage: string | null = null;
  const joinColumn =
    domain.id === "cdm-public"
      ? "sat1_norad"
      : ["tip", "decay", "keeptrack-reentry"].includes(domain.id)
        ? "norad_id"
        : null;
  if (joinColumn && tableExists(sqlite, "object_classification")) {
    const distressed = count(
      sqlite,
      `SELECT COUNT(*) AS n FROM (
         SELECT DISTINCT "${joinColumn}" AS id FROM "${domain.table}"
       ) s LEFT JOIN object_classification c ON c.norad_id = s.id
        WHERE c.norad_id IS NULL`,
    );
    const distinct = count(
      sqlite,
      `SELECT COUNT(DISTINCT "${joinColumn}") AS n FROM "${domain.table}"`,
    );
    const resolved = distinct - distressed;
    joinCoverage = `${resolved}/${distinct}`;
  }

  const rawLast = minMax.last === null ? null : String(minMax.last);
  const rawFirst = minMax.first === null ? null : String(minMax.first);
  const last = rawLast && domain.time.column === "mjd" ? mjdToIso(rawLast) : rawLast;
  const first = rawFirst && domain.time.column === "mjd" ? mjdToIso(rawFirst) : rawFirst;

  return {
    id: domain.id,
    table: domain.table,
    label: domain.label,
    rows,
    keys,
    duplicateKeys: rows - keys,
    timeColumn: domain.time.column,
    timeFirst: first,
    timeLast: last,
    nullTimes,
    gaps,
    joinCoverage,
    consumer: domain.consumer,
    freshnessDays: daysSince(last),
  };
}

interface Finding {
  domain: string;
  level: "fail" | "warn" | "note";
  message: string;
}

function judge(row: Row, domain: Domain): Finding[] {
  const out: Finding[] = [];
  const add = (level: Finding["level"], message: string) =>
    out.push({ domain: row.id, level, message });

  if (row.rows === 0 && !domain.optional) {
    add("fail", `${domain.table} 为空（该数据源应当有数据）`);
    return out;
  }
  if (row.duplicateKeys > 0) {
    add("fail", `主键 ${domain.key.join("+")} 上有 ${row.duplicateKeys} 行重复`);
  }
  if (row.timeColumn && row.nullTimes > 0) {
    add("fail", `时间列 ${row.timeColumn} 有 ${row.nullTimes} 行为空`);
  }
  if (row.gaps !== null && row.gaps > 0) {
    add("fail", `逐日序列缺 ${row.gaps} 天`);
  }
  if (row.joinCoverage) {
    const [resolved, total] = row.joinCoverage.split("/").map(Number);
    if (resolved !== total) {
      add("warn", `${total - resolved}/${total} 个物体编号在编目表里找不到`);
    }
  }
  // Freshness is reported, not asserted: the cadence table decides when a fetch is
  // due, and a source that has not changed legitimately has an old newest row.
  if (row.freshnessDays !== null && row.freshnessDays > 30) {
    add("note", `最新一行是 ${row.freshnessDays} 天前（对历史型数据是正常的）`);
  }
  if (!row.consumer) {
    add("note", "仅入库：没有页面或 API 读它");
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  const { loadEnvLocal } = await import("../scripts/env");
  loadEnvLocal();
  const { getDb } = await import("../src/db");
  const { sqlite } = getDb();

  const domains = args.domain
    ? DOMAINS.filter((d) => d.id === args.domain || d.table === args.domain)
    : DOMAINS;
  if (domains.length === 0) {
    console.error(`\n  未找到域：${args.domain}\n  可选：${DOMAINS.map((d) => d.id).join(", ")}\n`);
    process.exit(1);
  }

  const rows = domains.map((d) => inspect(sqlite, d));
  const findings = domains.flatMap((d, i) => judge(rows[i], d));

  const emptyStates = EXPECTED_EMPTY.map((e) => ({
    table: e.table,
    reason: e.reason,
    rows: tableExists(sqlite, e.table) ? count(sqlite, `SELECT COUNT(*) AS n FROM "${e.table}"`) : null,
  }));

  if (args.json) {
    console.log(JSON.stringify({ domains: rows, findings, emptyStates }, null, 2));
    process.exit(findings.some((f) => f.level === "fail") ? 1 : 0);
  }

  console.log("\n数据清单 — 编目与轨道以外的全部数据\n");
  console.log(
    "  " +
      "数据".padEnd(24) +
      "行数".padStart(9) +
      "重复".padStart(6) +
      "缺口".padStart(6) +
      "关联".padStart(11) +
      "  最新" +
      "  消费方",
  );
  for (const row of rows) {
    const consumer = row.consumer ? row.consumer.split("（")[0] : "仅入库";
    console.log(
      "  " +
        row.label.padEnd(24) +
        String(row.rows).padStart(9) +
        String(row.duplicateKeys).padStart(6) +
        String(row.gaps ?? "—").padStart(6) +
        (row.joinCoverage ?? "—").padStart(11) +
        "  " +
        (row.timeLast ?? "—").slice(0, 10).padEnd(11) +
        consumer,
    );
  }

  console.log("\n  按设计为空的表：");
  for (const e of emptyStates) {
    console.log(`    ${e.table.padEnd(24)} ${String(e.rows ?? "—").padStart(6)} 行  ${e.reason}`);
  }

  const notes = findings.filter((f) => f.level === "note");
  const warns = findings.filter((f) => f.level === "warn");
  const fails = findings.filter((f) => f.level === "fail");

  if (warns.length) {
    console.log("\n  需要注意：");
    for (const f of warns) console.log(`    ${f.domain}: ${f.message}`);
  }
  if (notes.length) {
    console.log("\n  说明：");
    for (const f of notes) console.log(`    ${f.domain}: ${f.message}`);
  }

  const totalRows = rows.reduce((s, r) => s + r.rows, 0);
  console.log(
    `\n  ${rows.length} 个数据集、${totalRows.toLocaleString("en-US")} 行；` +
      `${rows.filter((r) => !r.consumer).length} 个尚无消费方。`,
  );

  if (fails.length) {
    console.log(`\n  失败 ${fails.length} 项：`);
    for (const f of fails) console.log(`    ${f.domain}: ${f.message}`);
    console.log("");
    process.exit(1);
  }
  console.log("\n  全部检查通过。\n");
  sqlite.close();
}

void main();
