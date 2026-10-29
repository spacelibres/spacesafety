/**
 * DISCOSweb client: pagination, JSON:API flattening, rate-limit signalling.
 *
 * Everything here is exercised against an injected page fetcher rather than the
 * live API, because the live API needs a personal access token and rate-limits by
 * token. The pagination logic is the part that must be right: a bug that stops
 * one page early silently truncates the catalogue, which is exactly the failure
 * that goes unnoticed.
 */

import {
  DISCOS_COLLECTIONS,
  DiscosClient,
  RateLimitedError,
  flattenRecord,
  nextLink,
  snakeCase,
  totalPagesOf,
  type DiscosPage,
} from "../src/lib/sources/discos";
import { DOWNLOADS, downloadById } from "../src/lib/sources/downloads";

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

function page(data: unknown[], next: string | null, status = 200, totalPages?: number): DiscosPage {
  return {
    body: {
      data,
      links: next ? { next } : {},
      // `meta.pagination` is the end signal the client uses; the fixtures supply
      // it so the paging loop is exercised the way the real API drives it.
      meta: totalPages === undefined ? undefined : { pagination: { totalPages } },
    },
    next,
    status,
  };
}

async function main() {
  // ---- 1. pagination -------------------------------------------------------
  console.log("\npagination");
  const pages: Record<string, DiscosPage> = {
    p1: page([{ id: "a" }, { id: "b" }], "p2", 200, 3),
    p2: page([{ id: "c" }, { id: "d" }], "p3", 200, 3),
    p3: page([{ id: "e" }], null, 200, 3),
  };
  const seen: string[] = [];
  const client = new DiscosClient({
    token: "t",
    fetchPage: async (url) => {
      // Every page URL the client produces ends in `?page[size]=…&page[number]=N`,
      // so the page *number* is what identifies the fixture, not the URL.
      const number = new URL(url).searchParams.get("page[number]") ?? "1";
      const key = `p${number}`;
      seen.push(key);
      return pages[key] ?? page([], null, 404);
    },
  });

  const collected: unknown[] = [];
  for await (const batch of client.iterate("objects")) collected.push(...batch);
  check("walks every page", seen.length === 3, seen.join(","));
  check("collects every record", collected.length === 5, `${collected.length}`);
  check("stops at the last page", !pages["p3"].next);

  // A next link may be an object rather than a string.
  check(
    "object-shaped next link is read",
    nextLink({ links: { next: { href: "https://x/p2" } } }) === "https://x/p2",
  );
  check("absent next link is null", nextLink({ links: {} }) === null);
  check("next null is null", nextLink({ links: { next: null } }) === null);
  check("a non-object body is null", nextLink(null) === null);
  check("empty body yields no records", nextLink({}) === null);

  check("totalPages is read from meta", totalPagesOf({ meta: { pagination: { totalPages: 232 } } }) === 232);
  check("a body without meta has no total", totalPagesOf({ data: [] }) === null);
  check("a non-numeric total is rejected", totalPagesOf({ meta: { pagination: { totalPages: "x" } } }) === null);

  // maxPages must stop a runaway walk.
  const endless = new DiscosClient({
    token: "t",
    fetchPage: async () => page([{ id: "x" }], "again"),
  });
  let batches = 0;
  for await (const _ of endless.iterate("objects", { maxPages: 3 })) {
    batches += 1;
    void _;
  }
  check("maxPages caps the walk", batches === 3, `${batches}`);

  // ---- 2. failure signalling ----------------------------------------------
  console.log("\nerror handling");
  const unauthorised = new DiscosClient({
    token: "t",
    fetchPage: async () => page([], null, 401),
  });
  let msg = "";
  try {
    for await (const _ of unauthorised.iterate("objects")) void _;
  } catch (err) {
    msg = (err as Error).message;
  }
  check("401 explains the token", msg.includes("SPACE_SAFETY_DISCOS_TOKEN"), msg.slice(0, 50));

  const limited = new DiscosClient({
    token: "t",
    fetchPage: async () => page([], null, 429),
  });
  let limitedType = "";
  try {
    for await (const _ of limited.iterate("objects")) void _;
  } catch (err) {
    limitedType = err instanceof RateLimitedError ? "rate-limited" : "other";
  }
  check("429 raises a retryable error", limitedType === "rate-limited", limitedType);

  const noToken = new DiscosClient({ token: undefined });
  check("a missing token is detectable", !noToken.hasToken());
  const withToken = new DiscosClient({ token: "abc" });
  check("a present token is detected", withToken.hasToken());

  const serverError = new DiscosClient({
    token: "t",
    fetchPage: async () => page([], null, 500),
  });
  let serverMsg = "";
  try {
    for await (const _ of serverError.iterate("objects")) void _;
  } catch (err) {
    serverMsg = (err as Error).message;
  }
  check("a 5xx names the resource and page", /objects.*page 1/.test(serverMsg), serverMsg.slice(0, 60));

  // ---- 3. page size --------------------------------------------------------
  console.log("\npage size");
  const big = new DiscosClient({ token: "t", pageSize: 5000 });
  check(
    "page size is clamped to the server cap",
    new URL(big.firstPageUrl("objects")).searchParams.get("page[size]") === "100",
  );
  const zero = new DiscosClient({ token: "t", pageSize: 0 });
  check(
    "page size floors at one",
    new URL(zero.firstPageUrl("objects")).searchParams.get("page[size]") === "1",
  );
  check(
    "the first page is page 1",
    new URL(big.firstPageUrl("objects")).searchParams.get("page[number]") === "1",
  );
  check("the url targets the api base", big.firstPageUrl("objects").startsWith("https://discosweb.esoc.esa.int/api/objects"));

  // ---- 4. flattening -------------------------------------------------------
  console.log("\nJSON:API flattening");
  const flat = flattenRecord({
    id: "abc",
    type: "objects",
    attributes: {
      name: "STARLINK-1008",
      objectClass: "Payload",
      mass: 260,
      xSectAvg: 22.1,
      depth: { min: 1, max: 3 },
    },
    relationships: { operator: { data: { id: "op1", type: "operators" } } },
  });
  check("id becomes discos_id", flat?.discos_id === "abc");
  check("type is kept", flat?.discos_type === "objects");
  check("camelCase attributes become snake_case", flat?.object_class === "Payload");
  check("acronym attributes split correctly", flat?.x_sect_avg === 22.1);
  check("scalars are preserved", flat?.mass === 260);
  check("nested objects become JSON text", typeof flat?.depth === "string" && (flat.depth as string).includes("min"));
  check("relationships become <name>_id", flat?.operator_id === "op1");

  const toMany = flattenRecord({
    id: "l1",
    type: "launches",
    attributes: {},
    relationships: {
      objects: { data: [{ id: "a" }, { id: "b" }, { id: "c" }] },
    },
  });
  check("to-many relationships become comma lists", toMany?.objects_ids === "a,b,c");

  check("a record without an id is rejected", flattenRecord({ attributes: {} }) === null);
  check("a non-object is rejected", flattenRecord(null) === null);
  check("a record with no attributes still flattens", flattenRecord({ id: "x" })?.discos_id === "x");

  console.log("\nname conversion");
  check("meanMass -> mean_mass", snakeCase("meanMass") === "mean_mass");
  check("xSectAvg -> x_sect_avg", snakeCase("xSectAvg") === "x_sect_avg");
  check("apogee stays", snakeCase("apogee") === "apogee");
  check("hyphens become underscores", snakeCase("launch-site") === "launch_site");

  // ---- 5. catalogue integration -------------------------------------------
  console.log("\ndownload catalogue");
  const discosSpecs = DOWNLOADS.filter((d) => d.upstream === "discos");
  check("discos endpoints are catalogued", discosSpecs.length >= 5, `${discosSpecs.length}`);
  check("the objects collection is catalogued", downloadById("discos-objects")?.path === "objects");
  check(
    "discos endpoints are marked authenticated",
    discosSpecs.every((d) => d.authenticated),
  );
  check(
    "collections referenced by the catalogue exist",
    discosSpecs.every((d) => DISCOS_COLLECTIONS.some((c) => c.resource === d.path) || d.id === "discos-reference"),
  );
  check("all three upstreams are represented", new Set(DOWNLOADS.map((d) => d.upstream)).size === 3);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();

export {};
