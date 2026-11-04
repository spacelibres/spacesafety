/**
 * Keep the data scheduler resident, and report whether it is.
 *
 * ## Why this exists
 *
 * `npm run data:schedule -- --loop` honours each source's own frequency, and it had
 * been running for a day and then stopped without a trace: `data-schedule.log`
 * shows a cycle every ten minutes until 2026-11-02 18:11 and nothing after, while
 * by the next morning all 23 endpoints were past their interval. A resident process
 * with no supervisor is one crash away from the data going stale with nobody told.
 *
 * This is that supervisor. It is idempotent — running it when the scheduler is
 * already alive does nothing — so cron can call it every minute.
 *
 * ## Why not a systemd unit
 *
 * The unit file would live in `~/.config/systemd/user`, outside this repository, so
 * it could not be reviewed, versioned or restored with the code it supervises.
 * A tool in `tools/` plus one cron line keeps both halves in one place.
 *
 *   npm run schedule:keepalive              # start if not running (cron calls this)
 *   npm run schedule:keepalive -- --status  # is it running?
 *   npm run schedule:keepalive -- --install # write the cron line
 */

import { execFileSync, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG = "/tmp/scheduler.log";
const PATTERN = "tools/data-schedule.ts --loop";

/**
 * PIDs that are actually running the resident loop.
 *
 * `pgrep -f` alone is not enough, and was the reason this supervisor never started
 * anything. `-f` matches the whole command line; the supervisor is launched by
 * `npm run schedule:keepalive`, whose shell therefore carries the string
 * `tools/data-schedule.ts --loop` in its own command line — as does any shell that
 * mentions it, including the one running `pgrep`. The supervisor found itself,
 * concluded the scheduler was alive, and exited silently, while `ps` showed zero
 * schedulers the whole time.
 *
 * Candidates are filtered twice: `pgrep -f` for the substring, then the real
 * command line must be a node process running that entry point.
 */
function schedulerPids(): number[] {
  let out = "";
  try {
    out = execFileSync("pgrep", ["-f", PATTERN], { encoding: "utf8" });
  } catch {
    // pgrep exits 1 when nothing matched; that is the answer, not an error.
    return [];
  }
  return out
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid)
    .filter((pid) => {
      try {
        const cmd = execFileSync("ps", ["-o", "cmd=", "-p", String(pid)], { encoding: "utf8" });
        return cmd.includes("node") && cmd.includes(PATTERN) && !cmd.includes("pgrep") && !cmd.includes("sh -i");
      } catch {
        return false;
      }
    });
}

function start(): void {
  const fd = openSync(LOG, "a");
  const child = spawn("npm", ["run", "data:schedule", "--", "--loop"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  console.log(`已启动调度器 pid ${child.pid}，日志 ${LOG}`);
}

const CRON_LINE = `* * * * * cd ${ROOT} && /usr/bin/env npm run --silent schedule:keepalive >/dev/null 2>&1`;

function install(): void {
  let current = "";
  try {
    current = execFileSync("crontab", ["-l"], { encoding: "utf8" });
  } catch {
    current = "";
  }
  if (current.includes("schedule:keepalive")) {
    console.log("cron 里已有 keepalive 条目，未改动。");
    return;
  }
  const joined = `${current}${current && !current.endsWith("\n") ? "\n" : ""}${CRON_LINE}\n`;
  execFileSync("crontab", ["-"], { input: joined });
  console.log(`已写入 cron：\n  ${CRON_LINE}`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const pids = schedulerPids();

  if (argv.includes("--status")) {
    if (pids.length === 0) {
      console.log("\n  调度器：未运行\n");
      process.exit(1);
    }
    console.log(`\n  调度器：运行中  pid ${pids.join(", ")}`);
    console.log(`  日志：${LOG}\n`);
    return;
  }

  if (argv.includes("--install")) {
    install();
    return;
  }

  if (pids.length > 0) {
    console.log(`调度器已在运行（pid ${pids.join(", ")}），未重复启动。`);
    return;
  }
  start();
}

main();
