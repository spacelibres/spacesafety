"""
Download every image the documentation site embeds.

The docs pages are the closest thing to a published UI reference: each tutorial
page carries annotated screenshots of the Space Safety web app (operator
details, object details, trajectory upload, conjunction views). Our earlier
Markdown conversion dropped <img> tags, so we re-render each page with headless
Chrome and harvest the real asset URLs.

Usage:
    python3 tools/fetch_screenshots.py
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urljoin, urlparse

BASE = "https://space-safety.starlink.com"
OUT = Path("docs/reference-screenshots")

PAGES = [
    "/docs/quick-start",
    "/docs/tutorial-basics/operators",
    "/docs/tutorial-basics/objects",
    "/docs/tutorial-basics/trajectories",
    "/docs/tutorial-basics/cdms",
    "/docs/tutorial-basics/events",
    "/docs/tutorial-basics/architecture",
    "/docs/tutorial-basics/stargaze",
    "/docs/space-safety-articles/best_practices",
    "/docs/space-safety-articles/constellation_altitudes",
    "/docs/space-safety-articles/launch_cola",
    "/docs/space-safety-articles/starlink_cola_conops",
    "/docs/api-keys",
    "/docs/api-patterns",
]

IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg")


def find_chrome() -> str:
    for name in ("google-chrome", "google-chrome-stable", "chromium"):
        p = subprocess.run(["which", name], capture_output=True, text=True).stdout.strip()
        if p:
            return p
    sys.exit("no chrome found")


def render(chrome: str, url: str) -> str:
    proc = subprocess.run(
        [
            chrome,
            "--headless",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--virtual-time-budget=12000",
            "--dump-dom",
            url,
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    return proc.stdout


def harvest(dom: str) -> list[str]:
    urls: set[str] = set()
    for attr in ("src", "data-src"):
        for m in re.finditer(rf'{attr}="([^"]+)"', dom):
            u = m.group(1)
            if u.lower().endswith(IMAGE_EXT):
                urls.add(u)
    for m in re.finditer(r'srcset="([^"]+)"', dom):
        for part in m.group(1).split(","):
            u = part.strip().split(" ")[0]
            if u.lower().endswith(IMAGE_EXT):
                urls.add(u)
    for m in re.finditer(r"url\(([\"']?)([^)\"']+\.(?:png|jpg|jpeg|webp|gif))\1\)", dom):
        urls.add(m.group(2))
    return sorted(urls)


def main() -> None:
    chrome = find_chrome()
    OUT.mkdir(parents=True, exist_ok=True)

    seen: set[str] = set()
    rows: list[tuple[str, str, str]] = []

    for page in PAGES:
        url = BASE + page
        print(f"scan {page}", file=sys.stderr)
        try:
            dom = render(chrome, url)
        except subprocess.TimeoutExpired:
            print("  timeout", file=sys.stderr)
            continue

        found = harvest(dom)
        print(f"  {len(found)} image(s)", file=sys.stderr)

        for raw in found:
            absolute = urljoin(url, raw)
            if "/img/logo" in absolute or "favicon" in absolute:
                continue
            if absolute in seen:
                continue

            digest = hashlib.sha1(absolute.encode()).hexdigest()[:8]
            ext = Path(urlparse(absolute).path).suffix.lower()
            slug = Path(page).name or "index"
            name = f"{slug}__{digest}{ext}"
            target = OUT / name

            try:
                subprocess.run(
                    ["curl", "-sSL", "-m", "60", "-o", str(target), absolute],
                    check=True,
                    capture_output=True,
                )
            except subprocess.CalledProcessError:
                print(f"  failed {absolute}", file=sys.stderr)
                continue

            if not target.exists() or target.stat().st_size == 0:
                target.unlink(missing_ok=True)
                continue

            seen.add(absolute)
            rows.append((page, absolute, name))

    lines = [
        "# 官方界面参考截图",
        "",
        "从 `space-safety.starlink.com/docs` 各教程页面自动抓取的图片资源。",
        "这些是官方 Web 界面（operator / object / trajectory / event 详情页）",
        "的带标注截图，用作重建 UI 时的视觉参考。",
        "",
        f"共 {len(rows)} 张。",
        "",
        "| 来源页面 | 文件 | 原始地址 |",
        "|---|---|---|",
    ]
    for page, absolute, name in rows:
        lines.append(f"| `{page}` | [`{name}`]({name}) | {absolute} |")

    (OUT / "MANIFEST.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\ndone: {len(rows)} images -> {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
