#!/usr/bin/env python3
"""Start (or restart) the Space Safety web UI detached from any terminal.

The dev server is started under its own session so closing the terminal or the
agent that launched it cannot take it down, and its output goes to a log file
rather than a pipe that would block once the reader is gone.
"""

import os
import signal
import subprocess
import sys
import time
import urllib.request

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = "/tmp/spacesafety-web.log"
PIDFILE = "/tmp/spacesafety-web.pid"
PORT = int(os.environ.get("SPACE_SAFETY_PORT", "3000"))

ENV = {
    **os.environ,
    "SPACE_SAFETY_DEMO": "1",
    "SPACE_SAFETY_ALLOW_X_OPERATOR": "1",
    "NODE_OPTIONS": "--max-old-space-size=8192",
}


def running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def stop() -> None:
    if not os.path.exists(PIDFILE):
        return
    try:
        pid = int(open(PIDFILE).read().strip())
    except ValueError:
        return
    # The pid is the process group leader (start_new_session), so this reaches the
    # Next.js worker children too.
    if running(pid):
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            pass
        for _ in range(40):
            if not running(pid):
                break
            time.sleep(0.25)
    os.remove(PIDFILE)


def healthy() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/", timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def main() -> int:
    stop()
    logf = open(LOG, "ab", buffering=0)
    logf.write(f"\n===== start {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n".encode())
    proc = subprocess.Popen(
        ["npm", "run", "dev", "--", "--port", str(PORT)],
        cwd=PROJECT,
        env=ENV,
        stdout=logf,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    with open(PIDFILE, "w") as f:
        f.write(str(proc.pid))
    print(f"started npm run dev as pid {proc.pid} (log: {LOG})")

    # Next.js has to compile the first route before it answers, so wait rather
    # than reporting success on a process that is about to fail its first build.
    deadline = time.time() + 180
    while time.time() < deadline:
        if proc.poll() is not None:
            print(f"server exited early with code {proc.returncode}")
            print(open(LOG, errors="replace").read()[-3000:])
            return 1
        if healthy():
            print(f"ready on http://127.0.0.1:{PORT}/")
            return 0
        time.sleep(2)
    print("timed out waiting for the server to answer")
    return 1


if __name__ == "__main__":
    sys.exit(main())
