/**
 * Start, restart or stop the web UI detached from any terminal.
 *
 * A dev server launched from a shell dies with that shell's session, which is
 * why the server kept disappearing mid-investigation. This spawns it in its own
 * session with output redirected to a file, then waits until the port actually
 * answers — "process started" is not the same as "ready to serve", and reporting
 * the former as success sends the reader to a dead port.
 *
 *   npm run serve          start (restarts if already running)
 *   npm run serve -- stop  stop
 *   npm run serve -- status
 */

import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG = "/tmp/spacesafety-web.log";
const PIDFILE = "/tmp/spacesafety-web.pid";
const PORT = Number(process.env.SPACE_SAFETY_PORT ?? 3000);

/** Command-line tool: one class, `run()` returns the process exit code. */
export class ServeCommand {
  private async readPid(): Promise<number | null> {
    if (!existsSync(PIDFILE)) return null;
    const raw = (await readFile(PIDFILE, "utf8")).trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }

  private alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async healthy(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    const pid = await this.readPid();
    if (pid === null || !this.alive(pid)) {
      await rm(PIDFILE, { force: true });
      return;
    }
    // The pid is the session leader, so the negative pid reaches the npm and
    // Next.js children too; killing only the parent leaves the port bound.
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
    for (let i = 0; i < 40; i += 1) {
      if (!this.alive(pid)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await rm(PIDFILE, { force: true });
    console.log(`stopped pid ${pid}`);
  }

  async start(): Promise<number> {
    await this.stop();

    const logFd = openSync(LOG, "a");
    const stamp = new Date().toISOString();
    const child = spawn("npm", ["run", "dev", "--", "--port", String(PORT)], {
      cwd: ROOT,
      env: {
        ...process.env,
        SPACE_SAFETY_DEMO: "1",
        SPACE_SAFETY_ALLOW_X_OPERATOR: "1",
        NODE_OPTIONS: "--max-old-space-size=8192",
      },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    child.unref();
    if (child.pid === undefined) {
      console.error("failed to spawn the dev server");
      return 1;
    }
    await writeFile(PIDFILE, String(child.pid));
    console.log(`started npm run dev as pid ${child.pid} (log: ${LOG})`);
    console.log(`  ${stamp}`);

    // Next.js has to compile the first route before it answers, so wait for a
    // real HTTP 200 rather than for the process to exist.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (!this.alive(child.pid)) {
        console.error(`server exited early; last lines of ${LOG}:`);
        const log = await readFile(LOG, "utf8").catch(() => "");
        console.error(log.split("\n").slice(-30).join("\n"));
        return 1;
      }
      if (await this.healthy()) {
        console.log(`ready on http://127.0.0.1:${PORT}/`);
        return 0;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.error("timed out waiting for the server to answer");
    return 1;
  }

  async status(): Promise<number> {
    const pid = await this.readPid();
    const running = pid !== null && this.alive(pid);
    const ready = await this.healthy();
    console.log(`pid:     ${running ? pid : "not running"}`);
    console.log(`port:    ${PORT}`);
    console.log(`answer:  ${ready ? "yes" : "no"}`);
    return ready ? 0 : 1;
  }

  async run(argv: string[]): Promise<number> {
    const action = argv[0] ?? "start";
    switch (action) {
      case "start":
        return this.start();
      case "stop":
        await this.stop();
        return 0;
      case "restart":
        return this.start();
      case "status":
        return this.status();
      default:
        console.error(`unknown action "${action}"; use start | stop | restart | status`);
        return 2;
    }
  }
}

async function main(): Promise<void> {
  const code = await new ServeCommand().run(process.argv.slice(2));
  process.exit(code);
}

void main();
