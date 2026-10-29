#!/usr/bin/env python3
"""Fetch the Starlink Space Safety Platform docs into local Markdown.

The documentation site is a client-rendered SPA whose page bodies are stored in
hashed JS chunks and are not available as static HTML or as a public OpenAPI
file. We therefore render every page with headless Chrome and convert the
resulting <article> element to Markdown.

Usage:
    python3 tools/fetch_docs.py [--out docs/starlink-space-safety]
"""

from __future__ import annotations

import argparse
import html
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BASE = "https://space-safety.starlink.com"
SITEMAP = f"{BASE}/docs/sitemap.xml"

# Pages we deliberately skip: category landing pages (content is just a list of
# links already captured by the index) and docusaurus internals.
SKIP_PREFIXES = ("/docs/category/",)

CHROME_CANDIDATES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")


def find_chrome() -> str:
    import shutil

    for name in CHROME_CANDIDATES:
        path = shutil.which(name)
        if path:
            return path
    sys.exit("error: no Chrome/Chromium binary found on PATH")


def list_pages() -> list[str]:
    """Return doc paths in sitemap order."""
    raw = subprocess.run(
        ["curl", "-sS", SITEMAP], capture_output=True, text=True, check=True
    ).stdout
    paths = re.findall(r"https://space-safety\.starlink\.com(/docs/[^\s<\"']*)", raw)
    seen: set[str] = set()
    ordered: list[str] = []
    for p in paths:
        p = p.rstrip("/")
        if p in seen or p.startswith(SKIP_PREFIXES) or p in ("/docs", "/docs/sitemap.xml"):
            continue
        seen.add(p)
        ordered.append(p)
    return ordered


def render(chrome: str, url: str) -> str:
    """Render a URL with headless Chrome and return the DOM."""
    for attempt in range(3):
        proc = subprocess.run(
            [
                chrome,
                "--headless",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--virtual-time-budget=10000",
                "--dump-dom",
                url,
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
        dom = proc.stdout
        if "<article" in dom:
            return dom
        time.sleep(2 + attempt * 2)
    raise RuntimeError(f"failed to render {url} (no <article> in DOM)")


def extract_article(dom: str) -> str:
    """Slice out the <article>...</article> body, tolerating nesting."""
    start = dom.find("<article")
    if start == -1:
        raise ValueError("no <article> found")
    depth = 0
    tag_re = re.compile(r"<(/?)article\b[^>]*>", re.IGNORECASE)
    for m in tag_re.finditer(dom, start):
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return dom[start : m.end()]
    return dom[start:]


def expand_collapsed(article_html: str) -> str:
    """Force every <details> panel open.

    The OpenAPI reference keeps request bodies, parameter tables and response
    schemas inside collapsed ``<details>`` panels. Chrome's ``--dump-dom``
    preserves their markup, so we only need to mark them open; the converter
    then walks their children like any other block.
    """
    return re.sub(r"<details\b([^>]*)>", lambda m: f"<details open{m.group(1)}>", article_html)


# --------------------------------------------------------------------------
# HTML -> Markdown
# --------------------------------------------------------------------------

BLOCK_TAGS = {
    "p", "div", "section", "article", "header", "footer", "figure",
    "figcaption", "details", "summary", "dl", "dt", "dd", "address",
}


class Converter:
    def __init__(self) -> None:
        self.out: list[str] = []

    def emit(self, text: str) -> None:
        self.out.append(text)

    def newline(self) -> None:
        if not self.out or not self.out[-1].endswith("\n\n"):
            self.out.append("\n")

    def block(self, text: str) -> None:
        self.newline()
        self.emit(text.strip())
        self.newline()

    def convert_children(self, node, skip: set[int] | None = None) -> None:
        skip = skip or set()
        for child in node.children:
            if id(child) in skip:
                continue
            self.convert(child)

    def convert(self, node) -> None:
        from bs4 import NavigableString, Tag

        if isinstance(node, NavigableString):
            text = str(node)
            if text.strip() or " " in text:
                self.emit(re.sub(r"\s+", " ", text))
            return
        if not isinstance(node, Tag):
            return

        name = node.name.lower()
        classes = " ".join(node.get("class", []))

        if name in ("script", "style", "nav", "button", "svg"):
            return

        # Docusaurus anchors/headings/lists/tables.
        if name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = int(name[1])
            self.block("#" * level + " " + node.get_text(" ", strip=True))
            return

        if name == "pre":
            code = node.get_text()
            lang = ""
            code_el = node.find("code")
            if code_el is not None:
                for cls in code_el.get("class", []):
                    if cls.startswith("language-"):
                        lang = cls[len("language-"):]
            if not lang:
                span = node.find("span", class_=re.compile(r"token"))
                if span is not None:
                    for cls in span.get("class", []):
                        if cls.startswith("language-"):
                            lang = cls[len("language-"):]
            if not code.strip():
                return
            # Use a longer fence than any backtick run inside the payload so
            # documentation snippets that themselves contain ``` stay intact.
            longest = max((len(m) for m in re.findall(r"`+", code)), default=0)
            fence = "`" * max(3, longest + 1)
            self.block(f"{fence}{lang}\n{code.rstrip()}\n{fence}")
            return

        if name == "code":
            text = node.get_text()
            if text.strip():
                self.emit(f"`{text}`")
            return

        if name == "a":
            href = node.get("href", "")
            text = node.get_text(" ", strip=True)
            if not text:
                return
            if href.startswith("#"):
                return
            if href.startswith("/"):
                href = BASE + href
            self.emit(f"[{text}]({href})")
            return

        if name == "strong" or name == "b":
            self.emit(f"**{node.get_text(' ', strip=True)}**")
            return
        if name == "em" or name == "i":
            self.emit(f"*{node.get_text(' ', strip=True)}*")
            return

        if name == "br":
            self.emit("\n")
            return

        if name == "hr":
            self.block("---")
            return

        if name == "blockquote":
            text = node.get_text(" ", strip=True)
            self.block("\n".join("> " + line for line in text.splitlines()))
            return

        if name in ("ul", "ol"):
            items = node.find_all("li", recursive=False)
            if not items:
                # Schema keyword lists use <ul><div class="openapi-schema__list-item">.
                items = node.find_all(class_="openapi-schema__list-item", recursive=False)
            if not items:
                self.convert_children(node)
                return
            self.newline()
            for idx, li in enumerate(items):
                marker = f"{idx + 1}." if name == "ol" else "-"
                body = " ".join(li.get_text(" ", strip=True).split())
                if body:
                    self.emit(f"{marker} {body}\n")
            self.newline()
            return

        if name == "table":
            self.convert_table(node)
            return

        if name in BLOCK_TAGS:
            self.newline()
            self.convert_children(node)
            self.newline()
            return

        self.convert_children(node)

    def convert_table(self, node) -> None:
        rows = []
        for tr in node.find_all("tr"):
            cells = [c.get_text(" ", strip=True).replace("|", "\\|") for c in tr.find_all(["th", "td"])]
            if cells:
                rows.append(cells)
        if not rows:
            return
        width = max(len(r) for r in rows)
        rows = [r + [""] * (width - len(r)) for r in rows]
        lines = ["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
        for r in rows[1:]:
            lines.append("| " + " | ".join(r) + " |")
        self.block("\n".join(lines))

    def result(self) -> str:
        text = "".join(self.out)
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip() + "\n"


def to_markdown(article_html: str) -> str:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(expand_collapsed(article_html), "html.parser")
    # Drop SPA chrome that lives inside the article (breadcrumbs, TOC, prev/next).
    for sel in ("nav", "footer", "script", "style"):
        for tag in soup.find_all(sel):
            tag.decompose()
    for tag in soup.find_all(class_=re.compile(r"^(pagination-nav|tableOfContents)")):
        tag.decompose()
    conv = Converter()
    conv.convert_children(soup.find("article") or soup)
    return conv.result()


def slug_to_filename(path: str) -> str:
    rel = path.removeprefix("/docs/")
    return rel.replace("/", "__") + ".md"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="docs/starlink-space-safety")
    args = parser.parse_args()

    chrome = find_chrome()
    pages = list_pages()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"found {len(pages)} pages", file=sys.stderr)
    index_lines = ["# Starlink Space Safety Platform — Documentation Snapshot", ""]
    index_lines.append(f"Source: {BASE}/docs/  ")
    index_lines.append(f"Pages: {len(pages)}")
    index_lines.append("")
    index_lines.append("| # | Page | Local file |")
    index_lines.append("|---|---|---|")

    failures: list[str] = []
    for i, path in enumerate(pages, 1):
        url = BASE + path
        filename = slug_to_filename(path)
        try:
            dom = render(chrome, url)
            md = to_markdown(extract_article(dom))
        except Exception as exc:  # noqa: BLE001 - report and continue
            print(f"[{i}/{len(pages)}] FAIL {path}: {exc}", file=sys.stderr)
            failures.append(path)
            continue

        header = f"<!-- source: {url} -->\n\n"
        (out_dir / filename).write_text(header + md, encoding="utf-8")
        title = next((ln[2:].strip() for ln in md.splitlines() if ln.startswith("# ")), path)
        index_lines.append(f"| {i} | [{title}]({path}) | [`{filename}`]({filename}) |")
        print(f"[{i}/{len(pages)}] ok   {path} -> {filename}", file=sys.stderr)

    (out_dir / "INDEX.md").write_text("\n".join(index_lines) + "\n", encoding="utf-8")
    print(f"\ndone: {len(pages) - len(failures)} ok, {len(failures)} failed", file=sys.stderr)
    if failures:
        print("failed pages:\n  " + "\n  ".join(failures), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
