#!/usr/bin/env python3
"""
Ingest every pre-downloaded OCM, in batches.

`npm run ingest:starlink -- --objects A,B,...` takes the object list on the
command line, which is fine for a handful and hopeless for 11 000: the argument
list alone is 164 KB and the shell rejects it. This driver walks the cache
directory and invokes the existing script in batches, so the ingestion code stays
in one place (TypeScript) and only the batching lives here.

Progress is appended to the log so a run can be interrupted and resumed: the
ingest is idempotent (unchanged files are detected by content hash).
"""

import glob
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "data", "ephemeris-cache")
BATCH = 150

def main() -> int:
    names = sorted(
        os.path.basename(p)[:-4] for p in glob.glob(os.path.join(CACHE, "*.txt"))
    )
    if not names:
        print("no OCM files in the cache", flush=True)
        return 1

    # Optional resume: start after the last name already ingested, passed as argv[1].
    start_after = sys.argv[1] if len(sys.argv) > 1 else None
    if start_after and start_after in names:
        names = names[names.index(start_after) + 1 :]

    print(f"ingesting {len(names)} object(s) in batches of {BATCH}", flush=True)
    started = time.time()
    done = 0
    failed = 0

    for i in range(0, len(names), BATCH):
        batch = names[i : i + BATCH]
        cmd = [
            "npm",
            "run",
            "ingest:starlink",
            "--",
            "--objects",
            ",".join(batch),
            "--ocm-only",
        ]
        result = subprocess.run(
            cmd, cwd=ROOT, capture_output=True, text=True, timeout=3600
        )
        out = result.stdout + result.stderr

        batch_failed = out.count("FAILED")
        batch_ok = out.count("OCM:")
        done += batch_ok
        failed += batch_failed

        elapsed = time.time() - started
        rate = done / elapsed if elapsed > 0 else 0
        remaining = (len(names) - done) / rate / 60 if rate > 0 else 0
        print(
            f"  [{i + len(batch)}/{len(names)}] ok={batch_ok} failed={batch_failed} "
            f"total={done} rate={rate:.1f}/s eta={remaining:.0f}min",
            flush=True,
        )
        if batch_failed:
            for line in out.splitlines():
                if "FAILED" in line:
                    print(f"    {line.strip()}", flush=True)

    elapsed = time.time() - started
    print(
        f"\n{done} ingested, {failed} failed in {elapsed / 60:.1f} min",
        flush=True,
    )
    return 0 if failed == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
