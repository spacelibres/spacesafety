#!/usr/bin/env python3
"""
Download Starlink public ephemerides concurrently over SOCKS nodes.

## Why SOCKS, and why several nodes

A single connection to starlink.com is throttled to ~27 KB/s through the HTTP
proxy, so one 5 MB OCM takes three minutes. The local SOCKS pool exposes
independent nodes on 20200..20212, each of which delivers ~1 MB/s and returns the
complete file. Spreading files across nodes is therefore both faster and more
reliable than raising concurrency against one node.

Verified: `STARLINK-3614` via 20200-20202 = 5 026 653 bytes, complete, ~1 s/file.

## Truncation is the failure to guard against

The host does not signal a short body. A 206 or a dropped connection still looks
like success, and a truncated OCM *parses fine* as a shorter arc — so every
downstream number silently degrades. Each file is therefore checked for
`TRAJ_STOP` before it is kept, and a failed check is retried on a different node.

Usage:
  python3 tools/download-starlink.py --count 50
  python3 tools/download-starlink.py --objects STARLINK-35000,STARLINK-38128
  python3 tools/download-starlink.py --count 100 --nodes 20200,20201,20202
"""

import argparse
import concurrent.futures
import datetime
import os
import random
import re
import sys
import threading
import time

import requests

BASE = "https://www.starlink.com/public-files/ephemerides"
MANIFEST_URL = "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt"
OUT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "ephemeris-cache"
)

UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

DEFAULT_NODES = [f"127.0.0.1:{p}" for p in range(20200, 20213)]

_print_lock = threading.Lock()


def log(msg):
    with _print_lock:
        print(msg, flush=True)


def make_session(node):
    s = requests.Session()
    s.headers.update({
        "user-agent": UA,
        "accept": "text/html,application/xhtml+xml,text/plain,*/*",
        "accept-language": "en-US,en;q=0.9",
    })
    if node:
        s.proxies = {"http": f"socks5h://{node}", "https": f"socks5h://{node}"}
    adapter = requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=4, max_retries=0)
    s.mount("https://", adapter)
    # SOCKS needs its own adapter class from requests[socks].
    return s


def tail_of(path, size=8192):
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        n = min(size, fh.tell())
        fh.seek(-n, os.SEEK_END)
        return fh.read().decode("utf-8", "replace")


def is_complete(path):
    """True when the file is a whole OCM.

    `TRAJ_STOP` cannot be found by reading the *tail*: it sits at roughly line
    10 000 of a 5 MB file, followed by the covariance section (`COV_START`) and
    the manoeuvre plan (`MAN_START`/`MAN_STOP`). Checking the last few kilobytes
    therefore rejects perfectly good files -- which is exactly the bug that made
    a 20-file batch report 0 successes while every file was already complete.

    The terminator markers are searched over the whole file; the trailing `MAN_`
    section proves the read reached the end rather than stopping early.
    """
    try:
        with open(path, "rb") as fh:
            head = fh.read(64)
            if head[:1] in (b"<", b"{"):
                return False
            fh.seek(0)
            has_traj_stop = False
            has_cov = False
            for raw in fh:
                line = raw.lstrip()
                if line.startswith(b"TRAJ_STOP"):
                    has_traj_stop = True
                elif line.startswith(b"COV_START"):
                    has_cov = True
                elif has_traj_stop and has_cov and line.startswith(b"MAN_STOP"):
                    return True
            # Some files carry no manoeuvre section; a trajectory plus covariance
            # is still a complete, usable OCM.
            return has_traj_stop and has_cov
    except OSError:
        return False


def is_complete_itc(path):
    """True when the file is a whole Modified ITC body.

    An ITC has no terminator line. Its header states the epoch span and step, so
    the expected number of state blocks is known; a short body ends before it.
    Checking the span instead of the byte count keeps this independent of the
    unreliable `content-length`.
    """
    try:
        with open(path, "rb") as fh:
            head = fh.read(4096).decode("utf-8", "replace")
        if not re.search(r"^ephemeris_start:", head, re.M):
            return False
        m = re.search(
            r"ephemeris_start:(\S+ \S+) UTC ephemeris_stop:(\S+ \S+) UTC step_size:(\d+)",
            head,
        )
        if not m:
            return False
        start = parse_stamp(m.group(1))
        stop = parse_stamp(m.group(2))
        step = int(m.group(3))
        if not start or not stop or step <= 0:
            return False
        expected = int((stop - start) / step) + 1

        # Count state lines: they begin with the DOY timestamp (13 digits).
        states = 0
        with open(path, "rb") as fh:
            for raw in fh:
                if len(raw) > 13 and raw[:13].isdigit() and raw[13:14] == b".":
                    states += 1
        # Allow a couple of missing trailing blocks for rounding at the ends.
        return states >= expected - 2
    except OSError:
        return False


def parse_stamp(text):
    """Parse `YYYY-MM-DD HH:MM:SS` from an ITC header into seconds."""
    try:
        dt = datetime.datetime.strptime(text.strip(), "%Y-%m-%d %H:%M:%S")
        return dt.replace(tzinfo=datetime.timezone.utc).timestamp()
    except ValueError:
        return None


def fetch(url, path, nodes, itc=False, tries=4):
    """Download to `path`, rotating nodes on failure. Returns (ok, bytes, secs, node)."""
    started = time.time()
    order = list(nodes)
    random.shuffle(order)
    last = None
    used = None

    for attempt in range(tries):
        node = order[attempt % len(order)]
        used = node
        try:
            s = make_session(node)
            # No Range: on this host a Range request returns a 206 prefix, which is
            # a silent truncation.
            r = s.get(url, timeout=180, stream=True)
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}")

            tmp = f"{path}.part"
            with open(tmp, "wb") as fh:
                for chunk in r.iter_content(1 << 16):
                    if chunk:
                        fh.write(chunk)
            r.close()

            complete = is_complete_itc(tmp) if itc else is_complete(tmp)
            if not complete:
                size = os.path.getsize(tmp)
                os.remove(tmp)
                raise RuntimeError(f"incomplete ({size} bytes)")

            os.replace(tmp, path)
            return True, os.path.getsize(path), time.time() - started, node
        except Exception as exc:  # noqa: BLE001
            last = exc
            for leftover in (f"{path}.part",):
                if os.path.exists(leftover):
                    os.remove(leftover)
            time.sleep(min(6, 1.0 * (attempt + 1)) + random.random())

    log(f"  FAIL {os.path.basename(path)}: {last}")
    return False, 0, time.time() - started, used


def load_manifest(entries=False):
    s = make_session(None)
    r = s.get(MANIFEST_URL, timeout=180)
    r.raise_for_status()
    names = []
    full = []
    for line in r.text.splitlines():
        line = line.strip()
        parts = line.split("_")
        if len(parts) >= 3:
            names.append(parts[2])
            full.append((parts[2], line))
    return full if entries else names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", "--manifest", dest="count", type=int, default=None)
    ap.add_argument("--objects", default=None)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--nodes", default=None, help="comma-separated host:port SOCKS nodes")
    ap.add_argument(
        "--itc",
        action="store_true",
        help="download the Modified ITC files instead of the OCMs (names come from --objects)",
    )
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    nodes = args.nodes.split(",") if args.nodes else DEFAULT_NODES

    if args.objects:
        names = [n.strip() for n in args.objects.split(",") if n.strip()]
    else:
        if not args.count:
            ap.error("give --count N or --objects A,B")
        log("fetching manifest…")
        all_names = load_manifest()
        log(f"manifest: {len(all_names)} objects")
        names = all_names[: args.count]

    todo = []
    if args.itc:
        # ITC files are only reachable through the manifest's own file name, and
        # they are stored beside the OCM as `<name>.itc` so both feeds for one
        # object sit together.
        manifest = load_manifest(entries=True)
        by_name = {e[0]: e[1] for e in manifest}
        missing = [n for n in names if n not in by_name]
        if missing:
            log(f"  no manifest entry for: {', '.join(missing[:5])}")
        for name in names:
            if name not in by_name:
                continue
            path = os.path.join(OUT_DIR, f"{name}.itc")
            if os.path.exists(path) and is_complete_itc(path):
                log(f"  skip {name}.itc (complete)")
                continue
            if os.path.exists(path):
                os.remove(path)
            todo.append((name, path, f"{BASE}/{by_name[name]}", True))
    else:
        for name in names:
            path = os.path.join(OUT_DIR, f"{name}.txt")
            if os.path.exists(path) and is_complete(path):
                log(f"  skip {name} (complete)")
                continue
            if os.path.exists(path):
                os.remove(path)
            todo.append((name, path, f"{BASE}/{name}.txt", False))

    log(f"\ndownloading {len(todo)} file(s), {args.workers} workers, {len(nodes)} nodes\n")
    started = time.time()
    ok = 0
    total_bytes = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(fetch, url, path, nodes, itc): name
            for name, path, url, itc in todo
        }
        for i, fut in enumerate(concurrent.futures.as_completed(futures), 1):
            name = futures[fut]
            success, size, secs, node = fut.result()
            if success:
                ok += 1
                total_bytes += size
                log(
                    f"  [{i}/{len(todo)}] ok   {name:<20} {size/1e6:5.2f} MB "
                    f"{secs:5.1f}s  via {node}"
                )
            else:
                log(f"  [{i}/{len(todo)}] FAIL {name}")

    elapsed = time.time() - started
    log(
        f"\n{ok}/{len(todo)} complete, {total_bytes/1e6:.1f} MB in {elapsed:.1f}s "
        f"({total_bytes/1e6/max(elapsed,0.001):.2f} MB/s)"
    )
    return 0 if ok == len(todo) else 1


if __name__ == "__main__":
    sys.exit(main())
