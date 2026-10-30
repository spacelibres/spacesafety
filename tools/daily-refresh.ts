/**
 * The daily data refresh, in the one order that works.
 *
 * ## Why a single command
 *
 * The sources have different cadences (Space-Track 2 h, DISCOS 不定期, KeepTrack
 * 每日) and the pipeline has an order that cannot be guessed from the script
 * names. On 2026-10-30 the order was guessed wrong and it cost real data:
 * `npm run catalogue:build` **rebuilds `data/catalogue.sqlite` from the working
 * database**, and the KeepTrack tables exist only in the former — so running it
 * mid-refresh silently deleted 35 k rows. This script encodes the order that was
 * verified instead:
 *
 *   download  → archive (dated, hashed)            per-source cadence
 *   keepTrack → its own tables, its own script     每日
 *   load      → archive → source tables            never drops other sources
 *   wide      → the 157-column merge               reads the source tables
 *   classify  → the classification table           reads the wide table
 *   events    → CDM / TIP / decay / EOP / weather  独立于上面四步
 *
 * `catalogue:build` is **not** part of this chain on purpose; it produces the
 * small publishable database and would reset the tables only it knows about.
 *
 *   npm run data:daily             # refresh everything that is due
 *   npm run data:daily -- --force  # ignore per-source cadence
 *   npm run data:daily -- --dry-run
 *
 * It prints a before/after table so a refresh that quietly returned less data is
 * visible instead of looking like success.
 */

import { execFileSync } from "node:child_process";

/** Tables whose row count tells us whether the refresh actually moved data. */
const WATCHED = [
  "space_track_satcat",
  "satcat",
  "discos_objects",
  "object_physics",
  "object_launch_info",
  "keeptrack_object",
  "space_track_cdm_public",
  "space_track_tip",
  "space_track_decay",
  "discos_fragmentation",
  "space_weather",
  "earth_orientation",
  "object_classification",
] as const;

interface Step {
  label: string;
  /** `npm run <script>` or a raw command, run in the repository root. */
  command: string;
  args: string[];
}

export class DailyRefresh {
  constructor(
    private readonly force: boolean,
    private readonly dryRun: boolean,
  ) {}

  /** The chain, in the only order that was verified end to end. */
  steps(): Step[] {
    const download = this.force ? ["--", "--force"] : [];
    return [
      { label: "下载各源（按各自节奏）", command: "npm", args: ["run", "sources:download", ...download] },
      { label: "KeepTrack 编目", command: "npm", args: ["run", "keeptrack:sync"] },
      { label: "KeepTrack 五类 feeds", command: "npm", args: ["run", "keeptrack:feeds"] },
      { label: "归档 → 各源原样表", command: "npm", args: ["run", "sources:load"] },
      { label: "宽表 157 列重建", command: "npx", args: ["tsx", "tools/build-wide-catalogue.ts"] },
      { label: "分类表重建", command: "npm", args: ["run", "catalogue:classify"] },
      { label: "事件源（CDM/TIP/再入/EOP/天气）", command: "npm", args: ["run", "ingest:events"] },
    ];
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const table of WATCHED) {
      try {
        const n = execFileSync(
          "sqlite3",
          ["data/catalogue.sqlite", `SELECT COUNT(*) FROM ${table};`],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        out[table] = Number(n);
      } catch {
        out[table] = -1;
      }
    }
    out["catalogue_wide"] = Number(
      execFileSync("sqlite3", ["data/catalogue-wide.sqlite", "SELECT COUNT(*) FROM catalogue_wide;"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
    return out;
  }

  run(): number {
    const before = this.counts();
    console.log("\n每日数据刷新\n");
    console.log("  刷新前：");
    this.print(before);

    if (this.dryRun) {
      console.log("\n  --dry-run：只打印步骤，不执行\n");
      for (const step of this.steps()) {
        console.log(`  · ${step.label}   ${step.command} ${step.args.join(" ")}`);
      }
      return 0;
    }

    for (const step of this.steps()) {
      process.stdout.write(`\n  → ${step.label} … `);
      try {
        execFileSync(step.command, step.args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
        console.log("ok");
      } catch (err) {
        console.log("FAIL");
        const stderr = String((err as { stderr?: string }).stderr ?? "").trim().split("\n").slice(-8).join("\n");
        console.error(`\n  ${step.label} 失败，后续步骤不再执行：\n${stderr}\n`);
        return 1;
      }
    }

    const after = this.counts();
    console.log("\n  刷新后：");
    this.print(after, before);

    // A table that shrank is not automatically wrong (upserts can collapse keys),
    // but it must never pass silently — that is how a lost source looks like a
    // successful run.
    const shrank = Object.keys(after).filter(
      (table) => before[table] > 0 && after[table] >= 0 && after[table] < before[table],
    );
    if (shrank.length) {
      console.log(`\n  注意：${shrank.length} 张表的行数比刷新前少，需核对是否有源丢失或被覆盖：`);
      for (const table of shrank) console.log(`    ${table}: ${before[table]} → ${after[table]}`);
    }
    const wide = after["catalogue_wide"];
    const classified = after["object_classification"];
    if (wide !== classified) {
      console.log(`\n  失败：宽表 ${wide} 行与分类表 ${classified} 行不一致（定稿要求零缺口）\n`);
      return 1;
    }
    console.log("\n  宽表与分类表一致，刷新完成。\n");
    return 0;
  }

  private print(counts: Record<string, number>, before?: Record<string, number>): void {
    for (const [table, n] of Object.entries(counts)) {
      const prev = before?.[table];
      const delta = prev === undefined ? "" : n === prev ? "（不变）" : `（${n > prev ? "+" : ""}${n - prev}）`;
      console.log(`    ${table.padEnd(26)} ${String(n).padStart(7)} ${delta}`);
    }
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  process.exit(new DailyRefresh(argv.includes("--force"), argv.includes("--dry-run")).run());
}

void main();
