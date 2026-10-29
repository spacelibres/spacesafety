/**
 * Harvest the vendor documentation into local Markdown.
 *
 * The docs site is a client-rendered SPA (see `lib/chrome.ts`), so every page is
 * rendered in headless Chrome and its `<article>` converted to Markdown. The
 * local snapshot is the implementation reference for the API contract.
 *
 *   npm run fetch:docs                 into docs/starlink-space-safety
 *   npm run fetch:docs -- --out DIR
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ChromeRenderer, htmlToText } from "./lib/chrome";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = "https://space-safety.starlink.com";
const SITEMAP = `${BASE}/docs/sitemap.xml`;

/** Landing pages whose content is just a list of links already indexed. */
const SKIP_PREFIXES = ["/docs/category/"];

/** Doc URLs from the sitemap, minus the landing pages. */
export function parseSitemap(xml: string): string[] {
  const urls: string[] = [];
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const url = match[1];
    if (!url.startsWith(BASE)) continue;
    const path = url.slice(BASE.length);
    if (SKIP_PREFIXES.some((p) => path.startsWith(p))) continue;
    urls.push(url);
  }
  return [...new Set(urls)];
}

/** Extract the page body, preferring `<article>` and falling back to `<main>`. */
export function extractArticle(dom: string): string | null {
  const article = dom.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (article) return article[1];
  const main = dom.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  return main ? main[1] : null;
}

/** `a/b/c` to `a__b__c.md`, matching the existing snapshot's naming. */
export function slugToFilename(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "").replace(/^docs\//, "");
  return `${(trimmed || "index").replace(/\//g, "__")}.md`;
}

export class DocsHarvester {
  private readonly outDir: string;

  constructor(outDir: string) {
    this.outDir = outDir;
  }

  async run(): Promise<number> {
    await mkdir(this.outDir, { recursive: true });
    const renderer = await ChromeRenderer.create();
    try {
      const response = await fetch(SITEMAP, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        console.error(`sitemap returned HTTP ${response.status}`);
        return 1;
      }
      const pages = parseSitemap(await response.text());
      console.log(`${pages.length} documentation page(s)\n`);

      let written = 0;
      for (const [index, url] of pages.entries()) {
        const path = url.slice(BASE.length);
        const dom = await renderer.dump(url);
        if (dom === null) {
          console.log(`  [${index + 1}/${pages.length}] FAILED ${path}`);
          continue;
        }
        const body = extractArticle(dom);
        if (!body) {
          console.log(`  [${index + 1}/${pages.length}] no <article> in ${path}`);
          continue;
        }
        const title = (dom.match(/<title>([^<]*)<\/title>/i)?.[1] ?? path).trim();
        const markdown = [
          `# ${title}`,
          "",
          `> Source: ${url}`,
          "",
          htmlToText(body),
          "",
        ].join("\n");

        const file = join(this.outDir, slugToFilename(path));
        await writeFile(file, markdown, "utf8");
        written += 1;
        console.log(`  [${index + 1}/${pages.length}] ${slugToFilename(path)}`);
      }
      console.log(`\n${written}/${pages.length} page(s) written to ${this.outDir}`);
      return written > 0 ? 0 : 1;
    } finally {
      await renderer.close();
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf("--out");
  const out =
    outIndex === -1
      ? join(ROOT, "docs", "starlink-space-safety")
      : join(ROOT, argv[outIndex + 1] ?? "docs/starlink-space-safety");
  if (!existsSync(ROOT)) {
    console.error("run from the project root");
    process.exit(1);
  }
  process.exit(await new DocsHarvester(out).run());
}

void main();
