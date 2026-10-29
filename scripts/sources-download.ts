/**
 * Download every catalogued endpoint, archive it, and load what the database
 * consumes.
 *
 * ## The three layers, and why they are separate
 *
 *   download  → an HTTP body, possibly 69 MB, possibly gated by a login
 *   archive   → that body, dated, hashed, pruned on a schedule
 *   load      → the subset of it the query paths need, in SQLite
 *
 * Collapsing them is tempting and wrong: the archive has to keep bodies the
 * database deliberately ignores (`cdm_public`, `satcat/details`), and the loaders
 * have to be re-runnable against an archived body when an importer is fixed.
 * Keeping them apart is what makes "re-process yesterday without re-downloading
 * 250 MB" a one-line command.
 *
 * ## Scheduling
 *
 * `--loop` re-checks every few minutes and downloads only what is due, so one
 * process can serve all fifteen endpoints at their own cadences. The due test
 * lives in `downloads.ts` and is driven by `source_fetches`, not by a timer:
 * restarting the process must not re-download 250 MB, and a failed fetch must
 * stay due.
 *
 *   npm run sources:download                 # whatever is due
 *   npm run sources:download -- --force      # everything, now
 *   npm run sources:download -- --only spacebook-satcat-details
 *   npm run sources:download -- --loop       # keep running, honour cadences
 *   npm run sources:download -- --list       # show the catalogue and sizes
 */

import { readFile } from "node:fs/promises";

async function main(): Promise<void> {
  const { loadEnvLocal } = await import("./env");
  loadEnvLocal();

  const { getDb, nextSeq } = await import("../src/db");
  const { DOWNLOADS, downloadById, dueForRefresh, totalSizeMB } = await import(
    "../src/lib/sources/downloads"
  );
  const { SourceArchive } = await import("../src/lib/sources/archive");
  const { SourceLedger } = await import("../src/lib/sources/ledger");
  const { SpacebookAuth } = await import("../src/lib/sources/spacebook-auth");
  const { download } = await import("../src/lib/net/download");
  const { spaceTrackGet } = await import("../src/lib/sources/space-track");

  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const force = argv.includes("--force");
  const loop = argv.includes("--loop");
  const only = flag("--only")?.split(",").map((s) => s.trim());
  const concurrency = Number(flag("--concurrency") ?? 3);

  if (argv.includes("--list")) {
    console.log(`\n  ${DOWNLOADS.length} endpoint(s), ${totalSizeMB().toFixed(1)} MB per full sweep\n`);
    for (const spec of DOWNLOADS) {
      console.log(
        `  ${spec.id.padEnd(32)} ${String(spec.approxMB).padStart(6)} MB  ` +
          `${spec.refreshMinutes} min  ${spec.authenticated ? "auth " : "anon "}  ${spec.load}`,
      );
      console.log(`    ${spec.purpose}`);
    }
    console.log();
    return;
  }

  const specs = (only ? only.map((id) => downloadById(id)).filter(Boolean) : [...DOWNLOADS]) as typeof DOWNLOADS;
  if (specs.length === 0) {
    console.error("\n  no matching endpoint; try --list\n");
    process.exit(1);
  }

  const { sqlite } = getDb();
  const ledger = new SourceLedger(sqlite);
  ledger.seedRegistry();

  const archive = new SourceArchive();
  const auth = new SpacebookAuth();

  /** Fetch one endpoint's raw body. */
  async function fetchBody(spec: (typeof DOWNLOADS)[number]): Promise<Buffer> {
    if (spec.upstream === "space-track") {
      // `spaceTrackGet` returns text and owns the session cookie; the archive
      // stores the bytes it produced rather than re-encoding JSON.
      const res = await spaceTrackGet(`/${spec.path}`);
      if (!res.ok) throw new Error(res.error ?? "space-track request failed");
      return Buffer.from(res.data ?? "", "utf8");
    }

    if (spec.upstream === "discos") {
      return fetchDiscos(spec);
    }

    // Spacebook is fetched by URL, not through `SpacebookClient`: the client is
    // typed to a fixed feed list and cannot express `satcat/details` or the CSV
    // and XML encodings, which are the endpoints most likely to be missed.
    const token = await auth.accessToken().catch(() => null);
    const headers: Record<string, string> = {};
    if (token && spec.authenticated) headers.authorization = `Bearer ${token}`;

    const result = await download(
      `https://spacebook.com/${spec.path}`,
      (body) => body.length > 1024 && !body.subarray(0, 15).toString().trimStart().startsWith("<!"),
      { timeoutMs: 600_000, retries: 3, headers },
    );
    if (result.status === 0) throw new Error("download failed");
    if (result.status >= 400) throw new Error(`HTTP ${result.status}`);
    if (!result.complete) throw new Error(`incomplete body (${result.body.length} bytes)`);
    return result.body;
  }

  /**
   * Walk a DISCOSweb collection and reassemble it as one JSON:API document.
   *
   * The API is paged, so there is no single body to archive. Reassembling into the
   * same `{ data: [...] }` shape every other endpoint returns keeps the archive
   * comparable: the same differ works on a DISCOS capture and a Spacebook one.
   *
   * `discos-reference` is a composite of the small enumeration tables, which are
   * too small to justify an endpoint each but matter for decoding the ids.
   */
  /**
   * Download a DISCOSweb collection with concurrent, resumable paging.
   *
   * The collections are enormous — `objects` is 93 692 pages at 100 rows each —
   * so this does not walk a collection sequentially. `PagedCrawler` caches every
   * page on disk and resumes from the first missing one, which turns a six-hour
   * download from "all-or-nothing" into "costs one page per interruption".
   *
   * Pages are assembled into a single `{data:[…]}` document so the archive holds
   * the same shape every other endpoint produces.
   */
  async function fetchDiscos(spec: (typeof DOWNLOADS)[number]): Promise<Buffer> {
    const { PagedCrawler } = await import("../src/lib/sources/paged-crawl");
    const token = process.env.SPACE_SAFETY_DISCOS_TOKEN;
    if (!token) {
      throw new Error(
        "SPACE_SAFETY_DISCOS_TOKEN is not set; create a personal access token at " +
          "https://discosweb.esoc.esa.int/tokens",
      );
    }

    const resources =
      spec.id === "discos-reference"
        ? [
            "object-classes",
            "launch-sites",
            "tags",
            "fragmentation-event-types",
            "constellations/families",
            "launch-vehicles/families",
            "inhabitable-spacecraft",
          ]
        : spec.id === "discos-orbits"
          ? ["destination-orbits", "initial-orbits"]
          : [spec.path];

    const crawler = new PagedCrawler({
      cacheDir: "data/discos-cache",
      token,
      concurrency: Number(process.env.SPACE_SAFETY_DISCOS_CONCURRENCY ?? 8),
      log: (line) => console.log(line),
    });

    const merged: unknown[] = [];

    for (const resource of resources) {
      const result = await crawler.crawl(resource, (done, total) => {
        // A 93 000-page crawl must be visibly alive without printing 93 000 lines.
        if (total > 500 && done % 500 !== 0 && done !== total) return;
        console.log(`    ${resource}: ${done}/${total} page(s)`);
      });

      // An incomplete crawl is not an error to swallow: the cache survives, so the
      // next run resumes. Failing here is what stops a partial catalogue from
      // being archived as though it were complete.
      if (!result.complete) {
        throw new Error(
          `${resource}: ${result.pages} page(s) cached, incomplete — rerun to resume`,
        );
      }

      const body = await crawler.assemble(resource, result.pages);
      const parsed = JSON.parse(body.toString("utf8")) as { data: unknown[] };
      for (const record of parsed.data) {
        const r = record as { type?: unknown };
        // Stamp the resource when the record does not name its own type, so one
        // flat archive stays decodable without knowing which endpoint produced it.
        merged.push(r.type === undefined ? { ...(record as object), type: resource } : record);
      }

      console.log(
        `    ${resource}: ${result.records} record(s) in ${(result.ms / 1000).toFixed(1)}s ` +
          `(${result.fetched} fetched, ${result.reused} resumed)`,
      );

      // Keep the page cache: it is the resume point if the process dies before the
      // next archive run, and it is pruned by the archive's own retention.
    }

    return Buffer.from(JSON.stringify({ data: merged }), "utf8");
  }

  async function runOnce(): Promise<void> {
    const lastSuccess = ledger.lastSuccess();
    const due = force ? [...specs] : dueForRefresh(lastSuccess, Date.now(), specs);

    if (due.length === 0) {
      if (!loop) console.log("\n  nothing due\n");
      return;
    }

    console.log(
      `\n  ${due.length} endpoint(s) due, ~${due.reduce((s, d) => s + d.approxMB, 0).toFixed(1)} MB\n`,
    );

    // Bounded concurrency: the providers rate-limit, and 69 MB bodies in parallel
    // saturate the proxy long before they saturate the CPU.
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= due.length) return;
        const spec = due[index];
        await capture(spec);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
  }

  async function capture(spec: (typeof DOWNLOADS)[number]): Promise<void> {
    const started = Date.now();
    const fetchId = ledger.begin(spec.id, nextSeq(sqlite, "source_fetches"));
    const previousPath = await archive.latest(spec.id);
    const previousHash = previousPath ? hashOfName(previousPath) : null;

    try {
      const body = await fetchBody(spec);
      const stored = await archive.store(
        spec,
        body,
        previousPath && previousHash ? { sha256: previousHash, path: previousPath } : undefined,
      );

      ledger.finish(fetchId, {
        sourceId: spec.id,
        status: "ok",
        bytes: stored.bytes,
        records: countRecords(body, spec.format),
        path: stored.path,
        sha256: stored.sha256,
      });

      const removed = await archive.prune(spec.id);
      const age = ((Date.now() - started) / 1000).toFixed(1);
      const tag = stored.unchanged ? "unchanged" : `${(stored.bytes / 1e6).toFixed(1)} MB`;
      console.log(
        `  ${spec.id.padEnd(32)} ${tag.padStart(12)}  ${age}s` +
          (removed.length ? `  pruned ${removed.length}` : ""),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ledger.finish(fetchId, { sourceId: spec.id, status: "failed", error: message });
      console.log(`  ${spec.id.padEnd(32)} FAILED  ${message}`);
    }
  }

  if (loop) {
    console.log("\n  loop mode: checking cadences every 5 minutes, Ctrl-C to stop\n");
    // Never exit: a single failed sweep must not take the scheduler down.
    for (;;) {
      await runOnce().catch((err) => console.error(`  sweep failed: ${(err as Error).message}`));
      await new Promise((r) => setTimeout(r, 5 * 60_000));
    }
  }

  await runOnce();
  await report(archive, sqlite);
}

function hashOfName(path: string): string | null {
  const match = /-([0-9a-f]{12})\.[a-z]+$/.exec(path);
  return match ? match[1] : null;
}

/** Spacebook endpoint id → the client's feed name. */
function spacebookFeedFor(id: string):
  | "entity-tle"
  | "xp-tle"
  | "omm"
  | "satcat"
  | "satcat-supplemental"
  | "spaceweather"
  | "eop"
  | null {
  switch (id) {
    case "spacebook-entity-tle":
      return "entity-tle";
    case "spacebook-xp-tle":
      return "xp-tle";
    case "spacebook-omm-json":
    case "spacebook-omm-kvn":
    case "spacebook-omm-xml":
      // One download covers all three encodings' cadence; the client fetches JSON.
      return "omm";
    case "spacebook-satcat":
    case "spacebook-satcat-csv":
      return "satcat";
    case "spacebook-satcat-supplemental":
      return "satcat-supplemental";
    case "spacebook-spaceweather":
      return "spaceweather";
    case "spacebook-eop":
      return "eop";
    default:
      // `satcat/details`, `details/csv` have no SpacebookClient feed yet.
      return null;
  }
}

/** Cheap record count by format, for the fetch history. */
function countRecords(body: Buffer, format: string): number {
  const text = body.toString("utf8");
  if (format === "3le") {
    // Element sets are two lines each; the name line is optional.
    return text.split("\n").filter((l) => l.startsWith("1 ")).length;
  }
  if (format === "json") {
    const trimmed = text.trimStart();
    if (trimmed.startsWith("[")) {
      // Counting `{` at depth 0 would need a parser; the array element count is
      // what matters and every Spacebook body is a flat array of objects.
      return (trimmed.match(/\{"[A-Za-z_]/g) ?? []).length;
    }
    return 1;
  }
  return text.split("\n").filter((l) => l.trim() !== "").length;
}

async function report(
  archive: InstanceType<typeof import("../src/lib/sources/archive").SourceArchive>,
  sqlite: import("better-sqlite3").Database,
): Promise<void> {
  const rows = sqlite
    .prepare(
      `SELECT source_id AS id,
              (SELECT COUNT(*) FROM source_fetches f WHERE f.source_id = x.source_id) AS fetches,
              MAX(started_at) AS last
         FROM source_fetches x GROUP BY source_id ORDER BY source_id`,
    )
    .all() as Array<{ id: string; fetches: number; last: string }>;

  console.log("\n  fetches recorded:");
  for (const row of rows) {
    const usage = await archive.usage(row.id);
    console.log(
      `    ${row.id.padEnd(32)} ${String(row.fetches).padStart(4)} fetch(es)  ` +
        `${(usage.bytes / 1e6).toFixed(1).padStart(8)} MB archived  last ${row.last.slice(0, 19)}`,
    );
  }
  console.log();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
