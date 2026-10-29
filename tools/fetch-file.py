#!/usr/bin/env python3
"""
Resumable downloader for the Starlink public files.

Two things about this host force a non-obvious implementation:

1. **A plain GET can be truncated.** Two `curl` GETs of the same manifest
   returned 524 288 and 765 047 bytes, neither complete, and `content-length`
   in the small `Range` probe reports 76 725 while the real size is 823 468.
   What *is* reliable is a single explicit Range that spans far past the end:
   the server answers 206 and sends the whole resource.

2. **The proxy cannot reach starlink.com.** `CONNECT` succeeds and then TLS is
   cut (`UNEXPECTED_EOF_WHILE_READING`), and when a proxy does answer it can be
   an intercept page. Routes are therefore tried in order, an intercept page is
   rejected by inspecting the first bytes, and a route that stalls is dropped.

Usage:
  python3 tools/fetch-file.py <url> <out> [--expect N]
"""

import argparse
import os
import sys
import time

import requests

TEXT_HEADS = {b" ", b"\t", b"\n", b"\r", b"-", b"C", b"M", b"c", b"m", b"0", b"1", b"2", b"3", b"4", b"5", b"6", b"7", b"8", b"9"}


def make_session(proxy):
    s = requests.Session()
    s.headers["user-agent"] = "SpaceEyes/0.1 (orbit-safety replica)"
    if proxy:
        s.proxies = {"http": proxy, "https": proxy}
    return s


def try_route(url, proxy):
    """Download with a single over-long Range. Returns (bytes, note)."""
    s = make_session(proxy)
    r = s.get(url, headers={"Range": "bytes=0-999999999"}, timeout=300, stream=True)
    if r.status_code not in (200, 206):
        raise RuntimeError(f"HTTP {r.status_code}")

    body = r.content
    r.close()

    if not body:
        raise RuntimeError("empty body")

    first = body[:1]
    if first not in TEXT_HEADS:
        # A '<' or '{' here means an error or intercept page, not the resource.
        raise RuntimeError(f"not the file (starts with {first!r})")

    total = 0
    content_range = r.headers.get("content-range") or ""
    if "/" in content_range:
        try:
            total = int(content_range.rsplit("/", 1)[1])
        except ValueError:
            total = 0

    # The advertised total is not trustworthy on this host: `content-range` and
    # `content-length` both claim 76 725 bytes while a full read yields 823 468.
    # Only a reply *longer* than advertised proves the body was cut short; a
    # longer body is the normal case and is accepted as-is.
    if total and len(body) < total:
        raise RuntimeError(f"short read {len(body)} of {total}")
    return body, len(body)


def download(url, out, expect):
    routes = []
    env_proxy = os.environ.get("PROXY", "http://127.0.0.1:20171")
    if env_proxy:
        routes.append(env_proxy)
    routes.append(None)

    last = None
    for proxy in routes:
        label = "proxy" if proxy else "direct"
        for attempt in range(1, 4):
            try:
                body, total = try_route(url, proxy)
                with open(out, "wb") as fh:
                    fh.write(body)
                print(f"  route: {label}  {len(body)} bytes", flush=True)
                return
            except Exception as exc:  # noqa: BLE001
                last = f"{label}: {exc}"
                print(f"  {label} attempt {attempt}: {exc}", flush=True)
                time.sleep(1.5 * attempt)
        print(f"  dropping {label}", flush=True)

    raise SystemExit(f"failed to download {url}: {last}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("out")
    ap.add_argument("--expect", type=int, default=None)
    args = ap.parse_args()

    download(args.url, args.out, args.expect)

    size = os.path.getsize(args.out)
    if args.expect is not None:
        # Count entries, not newlines: the manifest has no trailing newline, so
        # `wc -l` reports one fewer than the number of entries.
        with open(args.out, "rb") as fh:
            text = fh.read().decode("utf-8", "replace")
        entries = sum(1 for line in text.splitlines() if line.strip())
        if entries != args.expect:
            raise SystemExit(f"entry count mismatch: got {entries}, expected {args.expect}")
        print(f"  verified: {entries} entries, {size} bytes", flush=True)
    else:
        print(f"  done: {size} bytes", flush=True)


if __name__ == "__main__":
    main()
