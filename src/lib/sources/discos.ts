/**
 * DISCOSweb client — ESA's space object database.
 *
 * ## What it adds over Space-Track and Spacebook
 *
 * The three sources overlap on identity but not on physics:
 *
 * | | Space-Track | Spacebook | DISCOSweb |
 * |---|---|---|---|
 * | object count | 71 198 | 72 310 | ~70 000 |
 * | physical model | none | RCS class | **mass, area, shape, drag coefficient** |
 * | provenance | 18th SDS | COMSPOC | ESA, from operator disclosure |
 * | high-accuracy ephemeris | no | no | **yes, where published** |
 *
 * The physical model is the one thing that changes results rather than just
 * descriptions: the collision cross-section needs an area and a shape, and neither
 * Space-Track nor Spacebook provides one. A `Debris` with a known area-to-mass
 * ratio also gets a much better drag term than a `B*` fitted to a week of elements.
 *
 * ## Authentication is a personal access token, not a password
 *
 * DISCOSweb's API takes `Authorization: Bearer <token>` where the token is a
 * *personal access token* minted on the website after logging in at
 * `https://discosweb.esoc.esa.int/tokens`. The account email and password only
 * open the website; they cannot be exchanged for a token over the API:
 *
 *   POST /api/auth/login  → 400 "The CSRF token is missing" (it is a browser form)
 *   GET  /api/auth/login  → 401 unauthorized
 *   POST /api/auth        → 405 Method Not Allowed
 *
 * So the password in `.env.local` documents who the account belongs to; the
 * working credential is `SPACE_SAFETY_DISCOS_TOKEN`.
 *
 * ## Cursoring
 *
 * JSON:API with `page[number]` / `page[size]`, a hard cap on page size, and a
 * rate limiter that returns a `Retry-After`. Pagination is sequential (a page
 * number is meaningless without the snapshot it was issued against), so this
 * client walks pages one at a time and backs off rather than parallelising.
 */

import { request } from "undici";

export const DISCOS_BASE = "https://discosweb.esoc.esa.int";
/** The API version every current endpoint requires; omitting it yields 415. */
export const DISCOS_API_VERSION = "2";

export type DiscosResource =
  | "objects"
  | "launches"
  | "launch-vehicles"
  | "launch-sites"
  | "launch-vehicles/stages"
  | "launch-vehicles/engines"
  | "launch-vehicles/families"
  | "constellations"
  | "constellations/families"
  | "fragmentations"
  | "fragmentation-event-types"
  | "destination-orbits"
  | "initial-orbits"
  | "object-classes"
  | "inhabitable-spacecraft"
  | "tags";

/**
 * Every collection endpoint the web app uses, with a rough size so a full sweep
 * can be estimated before it starts.
 */
export const DISCOS_COLLECTIONS: Array<{ resource: DiscosResource; approx: number; note: string }> = [
  { resource: "objects", approx: 70_000, note: "every tracked object with physical and orbital data" },
  { resource: "launches", approx: 6_000, note: "launch events, dates and outcomes" },
  { resource: "launch-vehicles", approx: 700, note: "launcher models" },
  { resource: "launch-vehicles/stages", approx: 2_000, note: "stage definitions" },
  { resource: "launch-vehicles/engines", approx: 600, note: "engine definitions" },
  { resource: "launch-vehicles/families", approx: 150, note: "launcher families" },
  { resource: "launch-sites", approx: 50, note: "launch sites with coordinates" },
  { resource: "constellations", approx: 300, note: "constellations" },
  { resource: "constellations/families", approx: 40, note: "constellation families" },
  { resource: "fragmentations", approx: 600, note: "break-up events and their fragments" },
  { resource: "fragmentation-event-types", approx: 10, note: "event classification" },
  { resource: "destination-orbits", approx: 200, note: "intended orbit classes" },
  { resource: "initial-orbits", approx: 200, note: "injection orbit classes" },
  { resource: "object-classes", approx: 20, note: "payload / rocket body / debris" },
  { resource: "inhabitable-spacecraft", approx: 20, note: "crewed vehicles" },
  { resource: "tags", approx: 50, note: "free-form labels" },
];

export interface DiscosOptions {
  /** Personal access token. Without it every request is 401. */
  token?: string;
  /** Rows per request. The server caps this; asking for more is clamped. */
  pageSize?: number;
  timeoutMs?: number;
  /** Injected for tests, so pagination logic runs without a network. */
  fetchPage?: (url: string) => Promise<DiscosPage>;
  log?: (line: string) => void;
}

export interface DiscosPage {
  /** Raw JSON:API body. */
  body: unknown;
  /** Absolute URL of the next page, or null at the end. */
  next: string | null;
  status: number;
}

export class DiscosClient {
  private readonly token: string | undefined;
  private readonly pageSize: number;
  private readonly timeoutMs: number;
  private readonly fetchPage: ((url: string) => Promise<DiscosPage>) | null;
  private readonly log: (line: string) => void;

  constructor(options: DiscosOptions = {}) {
    this.token = options.token ?? process.env.SPACE_SAFETY_DISCOS_TOKEN;
    // 100 is the cap the server enforces; asking for more is silently clamped,
    // which makes progress reporting lie about how many records arrived.
    this.pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 100);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchPage = options.fetchPage ?? null;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** Whether a token is configured. Callers may still want the public subset. */
  hasToken(): boolean {
    return Boolean(this.token);
  }

  /** URL of the first page of a collection. */
  firstPageUrl(resource: DiscosResource, pageSize = this.pageSize): string {
    const url = new URL(`/api/${resource}`, DISCOS_BASE);
    url.searchParams.set("page[size]", String(pageSize));
    url.searchParams.set("page[number]", "1");
    return url.toString();
  }

  /**
   * Walk a whole collection.
   *
   * Yields records page by page so a 70 000-row catalogue never has to be held in
   * memory, and so an interrupted sweep can be reported honestly ("4 100 of
   * ~70 000") instead of appearing to have failed entirely.
   */
  async *iterate(
    resource: DiscosResource,
    opts: { maxPages?: number; onPage?: (page: number, records: number, total: number | null) => void } = {},
  ): AsyncGenerator<unknown[]> {
    let url: string | null = this.firstPageUrl(resource);
    let page = 1;
    const maxPages = opts.maxPages ?? 10_000;

    while (url && page <= maxPages) {
      const target: string = url;
      const result: DiscosPage = this.fetchPage ? await this.fetchPage(target) : await this.get(target);
      if (result.status === 401) {
        throw new Error(
          "DISCOSweb returned 401: set SPACE_SAFETY_DISCOS_TOKEN to a personal access token " +
            "from https://discosweb.esoc.esa.int/tokens",
        );
      }
      if (result.status === 429) {
        throw new RateLimitedError(target);
      }
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`DISCOSweb /api/${resource} page ${page} returned HTTP ${result.status}`);
      }

      const data = (result.body as { data?: unknown[] })?.data;
      if (!Array.isArray(data)) {
        throw new Error(`DISCOSweb /api/${resource} returned a body without a data array`);
      }
      yield data;

      // `meta.pagination.totalPages` is the reliable end signal. Collections here
      // range from 12 rows to 23 200 (`destination-orbits` is 232 pages), so
      // neither "no next link" nor "short page" can be trusted to mean "done":
      // the first is absent on some responses, and the second is a lie when the
      // server clamps `page[size]`.
      const totalPages = totalPagesOf(result.body);
      opts.onPage?.(page, data.length, totalPages);

      if (totalPages !== null && page >= totalPages) {
        url = null;
      } else if (result.next) {
        // The server's next link carries the filters; its page number is rewritten
        // because a link repeating the current number refetches the same page
        // forever, which is exactly what the first version of this loop did.
        const nextUrl: URL = new URL(result.next, DISCOS_BASE);
        nextUrl.searchParams.set("page[number]", String(page + 1));
        nextUrl.searchParams.set("page[size]", String(this.pageSize));
        url = nextUrl.toString();
      } else {
        url = null;
      }
      page += 1;
      if (data.length === 0) break;
    }
  }

  /** Fetch a whole collection into memory. Only for the small ones. */
  async collect(resource: DiscosResource): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const batch of this.iterate(resource)) out.push(...batch);
    return out;
  }

  private async get(url: string): Promise<DiscosPage> {
    if (!this.token) {
      return { body: null, next: null, status: 401 };
    }
    const res = await request(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.api+json",
        "discosweb-api-version": DISCOS_API_VERSION,
        authorization: `Bearer ${this.token}`,
      },
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
    });

    const text = await res.body.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }

    return {
      body,
      next: nextLink(body),
      status: res.statusCode,
    };
  }
}

/** Thrown when the API asks us to slow down; the runner backs off and retries. */
export class RateLimitedError extends Error {
  readonly url: string;
  constructor(url: string) {
    super("DISCOSweb rate limit reached");
    this.name = "RateLimitedError";
    this.url = url;
  }
}

/** Total page count from `meta.pagination`, or null when the body omits it. */
export function totalPagesOf(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const meta = (body as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object") return null;
  const pagination = (meta as { pagination?: unknown }).pagination;
  if (!pagination || typeof pagination !== "object") return null;
  const total = (pagination as { totalPages?: unknown }).totalPages;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null;
}

/** JSON:API `links.next`, which may be a string or an object with `href`. */
export function nextLink(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const links = (body as { links?: unknown }).links;
  if (!links || typeof links !== "object") return null;
  const next = (links as { next?: unknown }).next;
  if (typeof next === "string" && next !== "") return next;
  if (next && typeof next === "object") {
    const href = (next as { href?: unknown }).href;
    if (typeof href === "string" && href !== "") return href;
  }
  return null;
}

/**
 * Flatten a JSON:API record into a row.
 *
 * DISCOSweb returns `{ id, type, attributes: {...}, relationships: {...} }`. The
 * relationships carry identifiers only (`{ data: { id, type } }`), so they are
 * lifted to `<name>Id` columns and joined later; the attributes keep their keys,
 * with `camelCase` names converted to `snake_case` so they line up with the
 * SATCAT-shaped tables this replica already uses.
 */
export function flattenRecord(record: unknown): Record<string, unknown> | null {
  if (!record || typeof record !== "object") return null;
  const r = record as { id?: unknown; type?: unknown; attributes?: unknown; relationships?: unknown };
  if (typeof r.id !== "string") return null;

  const row: Record<string, unknown> = { discos_id: r.id, discos_type: r.type ?? null };

  if (r.attributes && typeof r.attributes === "object") {
    for (const [key, value] of Object.entries(r.attributes as Record<string, unknown>)) {
      row[snakeCase(key)] = normaliseValue(value);
    }
  }

  if (r.relationships && typeof r.relationships === "object") {
    for (const [name, rel] of Object.entries(r.relationships as Record<string, unknown>)) {
      const data = (rel as { data?: unknown })?.data;
      if (Array.isArray(data)) {
        // One-to-many: keep the ids of every linked resource, comma separated, so a
        // single column can hold the relationship without a join table per type.
        const ids = data
          .map((d) => (d && typeof d === "object" ? (d as { id?: unknown }).id : null))
          .filter((id): id is string => typeof id === "string");
        if (ids.length) row[`${snakeCase(name)}_ids`] = ids.join(",");
      } else if (data && typeof data === "object") {
        const id = (data as { id?: unknown }).id;
        if (typeof id === "string") row[`${snakeCase(name)}_id`] = id;
      }
    }
  }

  return row;
}

function normaliseValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  // Nested objects (orbital parameters, masses) are stored as JSON text: their
  // shape varies per object class, and flattening them here would freeze a schema
  // the provider is free to extend.
  return JSON.stringify(value);
}

/** `meanMass` → `mean_mass`; `xSectAvg` → `x_sect_avg`. */
export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}
