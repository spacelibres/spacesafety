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

/**
 * Kill the resident loop and any process matching `filter`.
 *
 * Signalled politely first: `data-schedule` holds the database between rebuilds, and
 * SIGKILL mid-write is how a checkpoint gets left behind.
 */
function stop(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

/**
 * Epoch seconds when the code the loop is interpreting last changed.
 *
 * Two signals, and the *later* of them wins:
 *
 *   - the working tree's most recent mtime under `tools/` and `src/`
 *   - `HEAD`'s commit time
 *
 * The working tree alone is not enough: `git checkout` rewrites files with the
 * checkout time, which is right, but a commit made after a file was written leaves
 * the file's mtime older than the commit that describes it. HEAD alone is not
 * enough either: an uncommitted edit under `src/` is a change the loop has not seen.
 */
function codeChangedAt(): number {
  let tree = 0;
  try {
    // `-printf '%T@\n'` is what we want, but the format string goes through a shell
    // quoting layer that a plain `execFileSync` array does not provide, so the `\n`
    // arrives escaped and every value parses as garbage. `stat` per file avoids
    // format strings entirely.
    const files = execFileSync("find", ["tools", "src", "-name", "*.ts", "-type", "f"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    if (files.length > 0) {
      const out = execFileSync("stat", ["-c", "%Y", ...files], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      });
      for (const line of out.split("\n")) {
        const v = Number.parseInt(line, 10);
        if (Number.isFinite(v) && v > tree) tree = v;
      }
    }
  } catch {
    // find/stat are present everywhere this runs; if not, HEAD is still an answer.
  }

  let head = 0;
  try {
    head = Number(
      execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: ROOT, encoding: "utf8" }).trim(),
    );
  } catch {
    head = 0;
  }

  return Math.max(tree, head);
}

/**
 * Epoch seconds when a process started.
 *
 * Read from `/proc/<pid>/stat` field 22 (starttime, in clock ticks since boot)
 * plus the kernel's boot time, rather than from `ps -o lstart=`, whose output is a
 * localised human date that this module would then have to parse.
 */
function startedAt(pid: number): number | null {
  try {
    const stat = execFileSync("cat", [`/proc/${pid}/stat`], { encoding: "utf8" });
    // Field 22, but field 2 (comm) may contain spaces, so split after the last ')':
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(after[19]);
    const btime = Number(
      execFileSync("grep", ["^btime", "/proc/stat"], { encoding: "utf8" }).split(" ")[1],
    );
    if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
    // CLK_TCK is 100 on every Linux build this runs on.
    return btime + ticks / 100;
  } catch {
    return null;
  }
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
    // Alive is not the same as current. On 2026-11-04 this supervisor saw a live
    // scheduler and did nothing, while that scheduler had been started 3.5 hours
    // before the commit that changed the ingest steps it runs — so a whole night
    // of cycles kept calling the old commands. The check below is what would have
    // caught it.
    const changed = codeChangedAt();
    const started = pids.map(startedAt).filter((v): v is number => v !== null);
    const stale = started.length > 0 && started.every((s) => s < changed);

    if (!stale) {
      console.log(`调度器已在运行（pid ${pids.join(", ")}），未重复启动。`);
      return;
    }

    const minutes = Math.round((changed - Math.min(...started)) / 60);
    console.log(
      `调度器（pid ${pids.join(", ")}）早于代码 ${minutes} 分钟启动，重启以加载新逻辑。`,
    );
    stop(pids);
    // The port/db handles are closed on SIGTERM, but not synchronously. Give the
    // old process a moment before the new one opens the same database.
    execFileSync("sleep", ["2"]);
    const remaining = schedulerPids();
    if (remaining.length > 0) stop(remaining);
    start();
    return;
  }
  start();
}

main();
