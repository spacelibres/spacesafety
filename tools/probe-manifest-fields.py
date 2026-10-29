#!/usr/bin/env python3
"""
What does the manifest's first numeric field mean?

Compares it against `OBJECT_DESIGNATOR` from the object's own OCM file, which is
the authoritative catalogue number. Downloads go through the proxy, because the
direct route truncates.
"""

import os
import re
import sys
import time

import requests

PROXY = os.environ.get("PROXY", "http://127.0.0.1:20171")
BASE = "https://www.starlink.com/public-files/ephemerides"
MANIFEST = "/tmp/manifest.txt"


def session():
    s = requests.Session()
    s.headers["user-agent"] = "SpaceEyes/0.1 (orbit-safety replica)"
    if PROXY:
        s.proxies = {"http": PROXY, "https": PROXY}
    return s


def fetch(s, url, tries=4):
    last = None
    for attempt in range(1, tries + 1):
        try:
            r = s.get(url, headers={"Range": "bytes=0-999999999"}, timeout=180)
            r.raise_for_status()
            body = r.content.decode("utf-8", "replace")
            # A truncated reply ends mid-line; a complete OCM ends with the last
            # state vector's last value. Retry rather than silently comparing
            # against half a file.
            if "TRAJ_STOP" not in body:
                raise RuntimeError(f"truncated ({len(body)} bytes, no TRAJ_STOP)")
            return body
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.0 * attempt)
    raise RuntimeError(str(last))


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    step = int(sys.argv[2]) if len(sys.argv) > 2 else 1373

    with open(MANIFEST) as fh:
        lines = [l.strip() for l in fh if l.strip()]
    print(f"manifest entries: {len(lines)}")

    s = session()
    match = 0
    diff = 0
    shown = 0

    for i in range(0, len(lines), step):
        if shown >= count:
            break
        parts = lines[i].split("_")
        f1, name, f3 = parts[1], parts[2], parts[3]
        try:
            body = fetch(s, f"{BASE}/{name}.txt")
        except Exception as exc:  # noqa: BLE001
            print(f"{name:<18} download failed: {exc}")
            continue

        m = re.search(r"^OBJECT_DESIGNATOR\s*=\s*(\S+)", body, re.M)
        m2 = re.search(r"^OBJECT_NAME\s*=\s*(\S+)", body, re.M)
        designator = m.group(1) if m else "(none)"
        obj = m2.group(1) if m2 else "(none)"

        verdict = "MATCH" if f1 == designator else "DIFF"
        if f1 == designator:
            match += 1
        else:
            diff += 1
        shown += 1
        print(f"{name:<18} f1={f1:<10} f3={f3:<10} designator={designator:<10} name={obj:<18} {verdict}")

    print(f"\nmatch={match} diff={diff}")


if __name__ == "__main__":
    main()
