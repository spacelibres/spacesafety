/**
 * Viewport audit — does every page fit the screen without a scrollbar?
 *
 * ## What this asserts
 *
 * The product is an application shell: the document itself must never scroll, at
 * any screen size. Content that does not fit scrolls *inside* the shell, with the
 * scrollbar hidden. That is a layout claim no unit test can check — it needs a
 * real browser and a real layout engine — so it lives here and runs against the
 * dev or production server.
 *
 * It also reports any element whose scrollbars are visible (`offsetWidth` exceeds
 * `clientWidth`, or `offsetHeight` exceeds `clientHeight`, while the element is
 * allowed to scroll), because "no scrollbars" means exactly that.
 *
 *   npm run audit:viewport                       # against http://127.0.0.1:3000
 *   npm run audit:viewport -- http://host:3001   # against another origin
 *
 * Exit code 0 means every page fit at every viewport; 1 means something did not,
 * and the offending page/viewport is printed.
 */

import puppeteer from "puppeteer-core";

const PAGES = [
  "/",
  "/catalogue",
  "/browse",
  "/statistics",
  "/models",
  "/objects",
  "/operators",
  "/trajectories",
  "/conjunctions",
  "/reentry",
  "/environment",
  "/launches",
  "/screening/socrates",
  "/keys",
  "/docs",
  "/users",
  "/feedback",
];

/** Desktop down to the narrowest phone the shell is expected to serve. */
const VIEWPORTS: Array<[number, number, string]> = [
  [1920, 1080, "1920x1080"],
  [1440, 900, "1440x900"],
  [1280, 800, "1280x800"],
  [1024, 768, "1024x768"],
  [820, 700, "820x700"],
  [480, 800, "480x800"],
  [360, 720, "360x720"],
];

interface Measurement {
  docX: number;
  docY: number;
  visibleScrollbars: string[];
}

export class ViewportAudit {
  constructor(private readonly base: string) {}

  async run(): Promise<number> {
    const browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    let failures = 0;

    try {
      for (const [width, height, label] of VIEWPORTS) {
        await page.setViewport({ width, height });
        const bad: string[] = [];

        for (const path of PAGES) {
          try {
            await page.goto(`${this.base}${path}`, { waitUntil: "load", timeout: 120_000 });
            await new Promise((r) => setTimeout(r, 400));
            const m = await measure(page);
            if (!m) {
              bad.push(`${path} 无法测量`);
              continue;
            }
            if (m.docX > 0 || m.docY > 0) bad.push(`${path} 文档滚动 ${m.docX}x${m.docY}`);
            for (const el of m.visibleScrollbars) bad.push(`${path} 可见滚动条 ${el}`);
          } catch (err) {
            bad.push(`${path} 失败: ${(err as Error).message.slice(0, 60)}`);
          }
        }

        if (bad.length === 0) {
          console.log(`  ok   ${label}`);
        } else {
          failures += 1;
          console.log(`  FAIL ${label}`);
          for (const line of bad.slice(0, 8)) console.log(`       ${line}`);
        }
      }
    } finally {
      await browser.close();
    }

    return failures === 0 ? 0 : 1;
  }
}

async function measure(page: import("puppeteer-core").Page): Promise<Measurement | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.evaluate(() => {
        const de = document.documentElement;
        const visibleScrollbars: string[] = [];

        // An element shows a scrollbar when it is allowed to scroll and its
        // content is larger than its box. The shell hides scrollbars with
        // `scrollbar-width: none`, which does not change these measurements, so
        // the check looks at the computed style instead: a hidden bar is fine, a
        // visible one is the defect.
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
          const cs = getComputedStyle(el);
          const scrollsY = /auto|scroll/.test(cs.overflowY);
          const scrollsX = /auto|scroll/.test(cs.overflowX);
          if (!scrollsY && !scrollsX) continue;
          const hidden =
            cs.scrollbarWidth === "none" || cs.getPropertyValue("-ms-overflow-style") === "none";
          if (hidden) continue;
          const barY = scrollsY && el.offsetHeight - el.clientHeight > 2 && el.clientHeight > 0;
          const barX = scrollsX && el.offsetWidth - el.clientWidth > 2 && el.clientWidth > 0;
          if (!barY && !barX) continue;
          const id = el.id ? `#${el.id}` : `.${(el.className || "").toString().split(" ")[0] || el.tagName}`;
          visibleScrollbars.push(`${id}${barY ? "(y)" : ""}${barX ? "(x)" : ""}`);
          if (visibleScrollbars.length >= 5) break;
        }

        return {
          docX: de.scrollWidth - de.clientWidth,
          docY: de.scrollHeight - de.clientHeight,
          visibleScrollbars,
        };
      });
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return null;
}

async function main(): Promise<void> {
  const base = process.argv[2] ?? "http://127.0.0.1:3000";
  console.log(`\n视口审计 — ${base}\n`);
  const code = await new ViewportAudit(base).run();
  console.log(code === 0 ? "\n全部视口无滚动条。\n" : "\n存在溢出，见上。\n");
  process.exit(code);
}

void main();
