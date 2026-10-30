/**
 * Probe every KeepTrack v4 endpoint and report what it actually returns.
 *
 * ## Why probe rather than trust the OpenAPI document
 *
 * The spec lists 86 endpoints, but "listed" is not "populated". Some are parameterised
 * per object and cannot be bulk-fetched, some return empty arrays, and at least one
 * (`/v4/sat/{id}` for an obscure object) returns all-null fields. Deciding what to
 * ingest from the spec alone is how a project ends up with tables that look full and
 * are empty — the failure this project already had once with `__keeptrack`.
 *
 * So each endpoint is called once, with the smallest request that should produce
 * data, and the result is recorded: size, item count, and a sample key set.
 *
 * Run: npx tsx tools/keeptrack-probe.ts
 */

import { loadEnvLocal } from "../scripts/env";

loadEnvLocal();

const KEY = process.env.SPACE_SAFETY_KEEPTRACK_KEY ?? "";
const BASE = "https://api.keeptrack.space/v4";

interface Probe {
  id: string;
  path: string;
  /** What we expect it to add to the catalogue. */
  value: "catalogue" | "launch" | "conjunction" | "metrics" | "ephemeris" | "meta" | "none";
  note: string;
}

/** One representative call per endpoint family. */
const PROBES: Probe[] = [
  // ---- bulk catalogue
  { id: "sats", path: "/sats", value: "catalogue", note: "全量卫星+碎片，含物理字段" },
  { id: "sats-brief", path: "/sats/brief", value: "catalogue", note: "精简版，含 TLE + bus" },
  { id: "sats-debris", path: "/sats/debris", value: "catalogue", note: "仅碎片" },
  { id: "sats-leo", path: "/sats/leo", value: "catalogue", note: "仅 LEO" },
  { id: "sats-leo-debris", path: "/sats/leo/debris", value: "catalogue", note: "LEO 碎片" },
  { id: "sats-geo", path: "/sats/geo", value: "catalogue", note: "仅 GEO" },
  { id: "sats-celestrak", path: "/sats/celestrak", value: "catalogue", note: "CelesTrak 全集" },
  { id: "sats-celestrak-sup", path: "/sats/celestrak-sup", value: "catalogue", note: "CelesTrak 补充集" },
  { id: "sats-satnogs", path: "/sats/satnogs", value: "catalogue", note: "SATNOGS TLE" },
  { id: "sats-vimpel", path: "/sats/vimpel", value: "catalogue", note: "俄罗斯 Vimpel TLE" },
  { id: "sats-extended-ids", path: "/sats/extended-ids", value: "catalogue", note: "扩展编号" },
  { id: "text-data", path: "/text-data", value: "catalogue", note: "管道分隔 CSV" },
  { id: "satcat-latest", path: "/satcat/latest", value: "catalogue", note: "SATCAT 最新" },
  { id: "catalog-latest", path: "/catalog/latest", value: "catalogue", note: "CelesTrak 最新" },
  { id: "catalog-groups-types", path: "/catalog/groups/types", value: "metrics", note: "按类型统计" },
  { id: "catalog-groups-bus", path: "/catalog/groups/bus", value: "metrics", note: "按平台型号分组" },
  { id: "catalog-groups-owner", path: "/catalog/groups/owner", value: "metrics", note: "按所有者分组" },

  // ---- launch
  { id: "launches", path: "/launches", value: "launch", note: "即将发射" },
  { id: "launch-history", path: "/launch-history", value: "launch", note: "发射年表" },
  { id: "launch-history-years", path: "/launch-history/years", value: "launch", note: "年度统计" },
  { id: "launch-history-tags", path: "/launch-history/tags", value: "launch", note: "发射标签" },
  { id: "launch-history-by-vehicle", path: "/launch-history/by-vehicle", value: "launch", note: "按运载火箭" },
  { id: "launch-history-by-site", path: "/launch-history/by-site", value: "launch", note: "按发射场" },
  { id: "launch-history-months", path: "/launch-history/months", value: "launch", note: "按月" },
  { id: "launch-history-firsts", path: "/launch-history/firsts", value: "launch", note: "首飞记录" },
  { id: "reentries", path: "/reentries", value: "launch", note: "**预测再入**" },
  { id: "socrates-latest", path: "/socrates/latest", value: "conjunction", note: "**SOCRATES 交会数据**" },

  // ---- stats
  { id: "metrics-active", path: "/metrics/active/count", value: "metrics", note: "在轨载荷数" },
  { id: "metrics-inactive", path: "/metrics/inactive/count", value: "metrics", note: "失效载荷数" },
  { id: "metrics-payload", path: "/metrics/payload/count", value: "metrics", note: "载荷总数" },
  { id: "metrics-debris", path: "/metrics/debris/count", value: "metrics", note: "碎片总数" },
  { id: "stats-popular", path: "/stats/popular", value: "metrics", note: "热门查询" },
  { id: "stats-usage", path: "/stats/usage", value: "metrics", note: "API 用量" },
  { id: "stats-recent-launches", path: "/stats/recent-launches", value: "metrics", note: "近期发射" },
  { id: "stats-tle-age", path: "/stats/tle-age", value: "metrics", note: "TLE 时效" },

  // ---- per object (sample NORAD 25544 = ISS)
  { id: "sat", path: "/sat/25544", value: "catalogue", note: "单对象详情" },
  { id: "sat-summary", path: "/sat/25544/summary", value: "catalogue", note: "单对象摘要" },
  { id: "sat-tle", path: "/sat/25544/tle", value: "ephemeris", note: "单对象 TLE" },
  { id: "sat-tles", path: "/sat/25544/tles", value: "ephemeris", note: "多源 TLE" },
  { id: "sat-omm", path: "/sat/25544/omm", value: "ephemeris", note: "OMM 记录" },
  { id: "notices", path: "/notices?satId=25544", value: "catalogue", note: "KTOC 通告" },
  { id: "sat-trivia", path: "/sat/25544/trivia", value: "none", note: "冷知识" },
  { id: "sats-search", path: "/sats/ISS", value: "catalogue", note: "按名称搜索" },
  { id: "sats-latest", path: "/sats/latest/5", value: "catalogue", note: "最新 N 颗" },

  // ---- misc
  { id: "health", path: "/health", value: "meta", note: "健康检查" },
  { id: "api-key", path: "/api-key", value: "meta", note: "密钥信息" },
  { id: "news", path: "/news", value: "none", note: "博客" },
  { id: "trivia", path: "/trivia", value: "none", note: "冷知识" },
  { id: "catalog-last-update", path: "/catalog/last-update", value: "meta", note: "目录更新时间" },
  { id: "satcat-last-update", path: "/satcat/last-update", value: "meta", note: "SATCAT 更新时间" },
  { id: "sats-brief-last-update", path: "/sats/brief/last-update", value: "meta", note: "brief 更新时间" },
];

/** Endpoints deliberately not called: they need live parameters we do not have. */
const SKIPPED: Array<{ path: string; reason: string }> = [
  { path: "/sat/{id}/eci|ecf|lla|rae|radec/{time}", reason: "单点瞬时位置，与本地 SGP4/OCM 重复" },
  { path: "/positions/{id}/{lat}/{lng}/{alt}/{seconds}", reason: "观测者相关位置序列，前端实时算更合适" },
  { path: "/radiopasses/...", reason: "无线电过境预测，与轨道安全无关" },
  { path: "/channels/{name}|norad/{id}", reason: "卫星电视转发器，与编目无关" },
  { path: "/r2/{id}", reason: "对象存储直取，无目录" },
  { path: "/rso/{date}", reason: "历史 OMPub 归档，需逐日下载（另行处理）" },
  { path: "/launch-history/{launchTag}", reason: "单次发射详情，待 launch-history 索引后再接" },
  { path: "/launch-history/launches|search|images", reason: "同上" },
  { path: "/launch-vehicle/{id}", reason: "待索引" },
  { path: "/tle/{id}", reason: "N2YO 格式，与 /sat/{id}/tle 重复" },
  { path: "/text-data/... (14 个组合)", reason: "同一数据的筛选视图，接 /text-data 即可" },
  { path: "/api-key/roll", reason: "会作废当前密钥，不自动调用" },
  { path: "/stats/*", reason: "仅统计，已单独探测 4 个代表端点" },
];

async function probe(p: Probe): Promise<string> {
  const url = `${BASE}${p.path}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "X-API-Key": KEY, Accept: "application/json, text/plain, */*" },
      signal: AbortSignal.timeout(120_000),
    });
    const ms = Date.now() - started;
    if (!res.ok) return `HTTP ${res.status}  ${ms}ms`;

    const text = await res.text();
    const bytes = text.length;

    let shape = "";
    try {
      const j = JSON.parse(text) as unknown;
      if (Array.isArray(j)) {
        shape = `数组 ${j.length} 项`;
        if (j.length > 0 && typeof j[0] === "object" && j[0] !== null) {
          const keys = Object.keys(j[0] as object);
          shape += `  键: ${keys.slice(0, 10).join(",")}${keys.length > 10 ? "…" : ""}（${keys.length}）`;
        }
      } else if (j !== null && typeof j === "object") {
        const keys = Object.keys(j as object);
        shape = `对象  ${keys.slice(0, 10).join(",")}${keys.length > 10 ? "…" : ""}（${keys.length}）`;
      } else {
        shape = String(j).slice(0, 60);
      }
    } catch {
      shape = `非 JSON: ${text.slice(0, 60).replace(/\n/g, " ")}`;
    }

    return `${(bytes / 1024).toFixed(0)}KB  ${ms}ms  ${shape}`;
  } catch (err) {
    return `失败: ${(err as Error).message.slice(0, 60)}`;
  }
}

async function main(): Promise<void> {
  if (!KEY) {
    console.error("未配置 SPACE_SAFETY_KEEPTRACK_KEY");
    process.exit(1);
  }

  const groups: Record<Probe["value"], Probe[]> = {
    catalogue: [],
    launch: [],
    conjunction: [],
    metrics: [],
    ephemeris: [],
    meta: [],
    none: [],
  };
  for (const p of PROBES) groups[p.value].push(p);

  const VALUE_LABEL: Record<Probe["value"], string> = {
    catalogue: "编目数据（可入库）",
    launch: "发射与再入",
    conjunction: "交会数据",
    metrics: "统计指标",
    ephemeris: "星历",
    meta: "元信息",
    none: "与本项目无关",
  };

  for (const key of ["catalogue", "launch", "conjunction", "metrics", "ephemeris", "meta", "none"] as const) {
    const list = groups[key];
    if (list.length === 0) continue;
    console.log(`\n=== ${VALUE_LABEL[key]} ===\n`);
    for (const p of list) {
      const result = await probe(p);
      console.log(`  ${p.id.padEnd(22)} ${result}`);
      console.log(`  ${"".padEnd(22)} └ ${p.note}`);
    }
  }

  console.log(`\n=== 未调用（有理由）===\n`);
  for (const s of SKIPPED) {
    console.log(`  ${s.path}`);
    console.log(`     └ ${s.reason}`);
  }
  console.log("");
}

void main();
