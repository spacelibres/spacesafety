/**
 * Download every image the documentation site embeds.
 *
 * The tutorial pages carry annotated screenshots of the Space Safety web app —
 * operator details, object details, trajectory upload, conjunction views — and
 * they are the closest thing to a published UI reference. A Markdown conversion
 * drops `<img>` tags, so each page is rendered in headless Chrome and the real
 * asset URLs harvested from the rendered DOM.
 *
 *   npm run fetch:screenshots
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ChromeRenderer } from "./lib/chrome";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = "https://space-safety.starlink.com";

const PAGES = [
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
];

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg)$/i;

/** Absolute image URLs in a rendered DOM, in document order. */
export function extractImageUrls(dom: string, pageUrl: string): string[] {
  const urls: string[] = [];
  for (const match of dom.matchAll(/<img[^>]+src="([^"]+)"/gi)) {
    const raw = match[1];
    let absolute: URL;
    try {
      absolute = new URL(raw, pageUrl);
    } catch {
      continue;
    }
    if (!/(^|\.)starlink\.com$/.test(absolute.hostname)) continue;
    if (!IMAGE_EXT.test(absolute.pathname)) continue;
    urls.push(absolute.toString());
  }
  return [...new Set(urls)];
}

/** Stable filename: the page slug plus a short content-address of the URL. */
export function imageFilename(pagePath: string, imageUrl: string): string {
  const slug = (pagePath.replace(/^\/docs\//, "").replace(/\//g, "_") || "index").replace(
    /[^a-z0-9_-]/gi,
    "",
  );
  const hash = createHash("sha1").update(imageUrl).digest("hex").slice(0, 8);
  const ext = new URL(imageUrl).pathname.split(".").pop()?.toLowerCase() ?? "png";
  return `${slug}__${hash}.${ext}`;
}

export class ScreenshotHarvester {
  private readonly outDir: string;

  constructor(outDir: string) {
    this.outDir = outDir;
  }

  async run(): Promise<number> {
    await mkdir(this.outDir, { recursive: true });
    const renderer = await ChromeRenderer.create();
    const seen = new Set<string>();
    let saved = 0;
    let failed = 0;

    try {
      for (const [index, pagePath] of PAGES.entries()) {
        const url = `${BASE}${pagePath}`;
        const dom = await renderer.dump(url);
        if (dom === null) {
          console.log(`  [${index + 1}/${PAGES.length}] no DOM for ${pagePath}`);
          continue;
        }
        const images = extractImageUrls(dom, url);
        console.log(`  [${index + 1}/${PAGES.length}] ${pagePath}: ${images.length} image(s)`);

        for (const imageUrl of images) {
          if (seen.has(imageUrl)) continue;
          seen.add(imageUrl);
          try {
            const response = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = Buffer.from(await response.arrayBuffer());
            const file = join(this.outDir, imageFilename(pagePath, imageUrl));
            await writeFile(file, body);
            saved += 1;
          } catch (err) {
            failed += 1;
            console.log(`      failed ${imageUrl}: ${(err as Error).message}`);
          }
        }
      }
    } finally {
      await renderer.close();
    }

    console.log(`\n${saved} image(s) saved to ${this.outDir}${failed ? `, ${failed} failed` : ""}`);
    return saved > 0 ? 0 : 1;
  }
}

async function main(): Promise<void> {
  const out = join(ROOT, "docs", "reference-screenshots");
  process.exit(await new ScreenshotHarvester(out).run());
}

void main();
