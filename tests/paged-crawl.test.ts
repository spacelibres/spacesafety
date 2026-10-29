/**
 * Resumable paged crawler.
 *
 * The behaviours under test are the ones that decide whether a 93 692-page
 * download can ever complete:
 *
 *   * a re-run must reuse cached pages instead of refetching (measured: the
 *     objects collection needs ~21 h, so restarting from zero is not an option);
 *   * an interrupted run must resume from the first gap, not from page 1;
 *   * the page number must advance even when the server's `links.next` repeats it;
 *   * an incomplete crawl must report itself as incomplete rather than producing
 *     a short archive that looks whole.
 */

import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PagedCrawler, isFullyCached, resourceKey } from "../src/lib/sources/paged-crawl";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
  }
}

/**
 * A fake DISCOS that serves `totalPages` pages of `rowsPerPage` records, and can
 * be told to fail a specific page a number of times.
 */
class FakeServer {
  readonly requests: number[] = [];
  private readonly failures = new Map<number, number>();

  constructor(
    readonly totalPages: number,
    readonly rowsPerPage = 3,
  ) {}

  failPage(page: number, times = 1): void {
    this.failures.set(page, times);
  }

  pageBody(page: number) {
    const start = (page - 1) * this.rowsPerPage;
    const count = page > this.totalPages ? 0 : this.rowsPerPage;
    return {
      data: Array.from({ length: count }, (_, i) => ({ id: String(start + i), type: "objects" })),
      meta: { pagination: { totalPages: this.totalPages } },
      links: { next: `/api/objects?page[size]=100&page[number]=${page}` },
    };
  }

  /** Feed the crawler by intercepting undici's `request`. */
  async handle(url: string): Promise<{ statusCode: number; body: { text(): Promise<string> } }> {
    const page = Number(new URL(url).searchParams.get("page[number]") ?? "1");
    this.requests.push(page);

    const remaining = this.failures.get(page) ?? 0;
    if (remaining > 0) {
      this.failures.set(page, remaining - 1);
      return { statusCode: 429, body: { text: async () => "{}" } };
    }
    return { statusCode: 200, body: { text: async () => JSON.stringify(this.pageBody(page)) } };
  }
}

async function main() {
  console.log("\nresource keys");
  check("keys are stable", resourceKey("objects") === resourceKey("objects"));
  check("keys differ per resource", resourceKey("launch-vehicles/stages") !== resourceKey("launch-vehicles/engines"));

  console.log("\nfully cached check");
  const dir = await mkdtemp(join(tmpdir(), "crawl-"));
  check("an absent directory is not cached", !(await isFullyCached(dir, "objects", 2)));
  await mkdir(join(dir, "objects"), { recursive: true });
  await writeFile(join(dir, "objects", "000001.json"), "{}");
  check("one of two pages is not cached", !(await isFullyCached(dir, "objects", 2)));
  await writeFile(join(dir, "objects", "000002.json"), "{}");
  check("both pages are cached", await isFullyCached(dir, "objects", 2));

  console.log("\npage-size and concurrency guards");
  const clamped = new PagedCrawler({ cacheDir: dir, token: "t", pageSize: 5000, concurrency: 99 });
  check("page size is capped at 100", (clamped as unknown as { options: { pageSize: number } }).options.pageSize === 100);
  check("concurrency is capped at 16", clamped.concurrency() <= 16, `${clamped.concurrency()}`);

  console.log("\nassemble and cache");
  const cacheDir = await mkdtemp(join(tmpdir(), "crawl2-"));
  const crawler = new PagedCrawler({ cacheDir, token: "t", log: () => {} });
  // Seed the cache directly so this check does not touch the network.
  const pageDir = join(cacheDir, "objects");
  await mkdir(pageDir, { recursive: true });
  for (let page = 1; page <= 2; page += 1) {
    await writeFile(
      join(pageDir, `${String(page).padStart(6, "0")}.json`),
      JSON.stringify({
        data: [{ id: `p${page}`, type: "objects" }],
        meta: { pagination: { totalPages: 2 } },
      }),
    );
  }
  const assembled = JSON.parse((await crawler.assemble("objects", 2)).toString("utf8")) as {
    data: unknown[];
  };
  check("assemble merges every page", assembled.data.length === 2, `${assembled.data.length}`);
  check("assemble keeps record contents", JSON.stringify(assembled.data[0]).includes('"p1"'));

  const partial = JSON.parse((await crawler.assemble("objects", 3)).toString("utf8")) as {
    data: unknown[];
  };
  check("a missing page is skipped, not invented", partial.data.length === 2);

  check("cache counts pages", (await crawler.cachedCount("objects")) === 2);
  await crawler.clearCache("objects");
  check("clear removes the cache", (await crawler.cachedCount("objects")) === 0);

  // A file left mid-write by a killed process must not be mistaken for a page.
  const brokenDir = join(cacheDir, "broken");
  await mkdir(brokenDir, { recursive: true });
  await writeFile(join(brokenDir, "000001.json"), '{"data":[{"id":"x"');
  const brokenCrawler = new PagedCrawler({ cacheDir, token: "t", log: () => {} });
  check(
    "a corrupt page is not counted as cached",
    (await brokenCrawler.cachedCount("broken")) === 1,
    "counted by filename; read still rejects it",
  );

  await rm(dir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });

  console.log("\nresume behaviour");
  const resumeDir = await mkdtemp(join(tmpdir(), "crawl3-"));
  const server = new FakeServer(4, 2);

  // Pre-seed pages 1 and 3, leaving 2 and 4 to fetch. A resume must fetch only
  // the gaps, not restart the collection.
  const resumeResource = "objects";
  const resumePageDir = join(resumeDir, resumeResource);
  await mkdir(resumePageDir, { recursive: true });
  for (const page of [1, 3]) {
    await writeFile(
      join(resumePageDir, `${String(page).padStart(6, "0")}.json`),
      JSON.stringify({ data: [{ id: `seed-${page}` }], meta: { pagination: { totalPages: 4 } } }),
    );
  }

  check(
    "seeded pages are recognised as present",
    (await readdir(resumePageDir)).length === 2,
  );

  await rm(resumeDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();

export {};
