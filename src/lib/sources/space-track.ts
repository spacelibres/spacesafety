/**
 * Space-Track.org GP (General Perturbations) data source.
 *
 * Space-Track is the 18th Space Defense Squadron's public distribution point for
 * the catalogue, and the authoritative source of NORAD catalogue numbers. It
 * requires an authenticated session:
 *
 *   POST https://www.space-track.org/ajaxauth/login
 *        identity=<email>&password=<password>   → sets a session cookie
 *   GET  https://www.space-track.org/basicspacedata/query/class/gp/...
 *
 * ## Why an authenticated session is handled here, not in the caller
 *
 * Space-Track permits a small number of logins per account per day, and treats the
 * session cookie as the unit of cost. Logging in per request would exhaust the
 * allowance within minutes during a catalogue sweep, so the session is cached and
 * shared, refreshed only when a request comes back unauthenticated.
 *
 * ## Credentials
 *
 * Read from the environment, never hard-coded:
 *   SPACE_SAFETY_SPACETRACK_USER
 *   SPACE_SAFETY_SPACETRACK_PASS
 *
 * The module reports a structured "not configured" result rather than throwing,
 * so the application runs without credentials and simply has no catalogue.
 */

import { parseTleFile, type Tle, type TleParseError } from "../orbit/tle";
import { download } from "../net/download";

export const SPACETRACK_BASE = "https://www.space-track.org";

/** Path prefixes for the query API. */
export const SPACETRACK_QUERY = `${SPACETRACK_BASE}/basicspacedata/query`;

export interface SpaceTrackConfig {
  user: string;
  pass: string;
  base?: string;
  timeoutMs?: number;
}

export interface SpaceTrackSession {
  cookie: string;
  /** When the session was established, ms. */
  establishedAt: number;
}

export interface SpaceTrackResult<T> {
  ok: boolean;
  data: T | null;
  /** Present when `ok` is false. */
  error?: string;
  /** True when the failure is a configuration problem, not a network one. */
  notConfigured?: boolean;
}

export class SpaceTrackError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SpaceTrackError";
  }
}

/** Space-Track returns every scalar as a string, including empty for null. */
function num(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === "" || value === "null") return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Read credentials from the environment. */
export function spaceTrackConfig(): SpaceTrackConfig | null {
  const user = process.env.SPACE_SAFETY_SPACETRACK_USER?.trim();
  const pass = process.env.SPACE_SAFETY_SPACETRACK_PASS;
  if (!user || !pass) return null;
  return {
    user,
    pass,
    timeoutMs: Number(process.env.SPACE_SAFETY_SPACETRACK_TIMEOUT_MS ?? 45_000),
  };
}

/**
 * Session cache.
 *
 * Keyed by account so switching credentials in a long-running process does not
 * reuse the wrong cookie. Space-Track sessions expire after a couple of hours of
 * inactivity; a 401 triggers a refresh rather than a retry loop.
 */
const sessions = new Map<string, SpaceTrackSession>();

/** Extract the `Set-Cookie` pairs a login response needs to be replayed. */
function cookieFrom(response: Response): string {
  const raw = response.headers.getSetCookie?.() ?? [];
  return raw.map((c) => c.split(";")[0]).join("; ");
}

async function login(cfg: SpaceTrackConfig): Promise<string> {
  const body = new URLSearchParams({ identity: cfg.user, password: cfg.pass });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 45_000);

  try {
    const res = await fetch(`${cfg.base ?? SPACETRACK_BASE}/ajaxauth/login`, {
      method: "POST",
      body,
      signal: controller.signal,
      headers: {
        "user-agent": "SpaceSafety/0.1 (orbit-safety replica)",
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    // A successful login answers 200 with an empty JSON body. A failed one returns
    // 200 too, but with a `Failed` string — so the status alone is not enough.
    const text = await res.text();
    if (!res.ok) {
      throw new SpaceTrackError(`Space-Track login failed: HTTP ${res.status}`, res.status);
    }
    if (/failed/i.test(text)) {
      throw new SpaceTrackError(
        "Space-Track rejected the credentials (check SPACE_SAFETY_SPACETRACK_USER/PASS)",
        res.status,
      );
    }
    const cookie = cookieFrom(res);
    if (!cookie) {
      throw new SpaceTrackError("Space-Track login returned no session cookie", res.status);
    }
    return cookie;
  } finally {
    clearTimeout(timer);
  }
}

async function sessionCookie(cfg: SpaceTrackConfig, forceRefresh = false): Promise<string> {
  const key = `${cfg.base ?? SPACETRACK_BASE}|${cfg.user}`;
  const hit = sessions.get(key);
  if (hit && !forceRefresh) return hit.cookie;

  const cookie = await login(cfg);
  sessions.set(key, { cookie, establishedAt: Date.now() });
  return cookie;
}

/** Drop a cached session, e.g. after a 401. */
export function clearSession(): void {
  sessions.clear();
}

/**
 * Run one authenticated query.
 *
 * `path` is appended to the query prefix and must already be URL-encoded.
 * Returns the raw text, which for `format/tle` is a TLE file.
 */
export async function spaceTrackGet(
  path: string,
  cfg: SpaceTrackConfig = spaceTrackConfig() ?? ({} as SpaceTrackConfig),
): Promise<SpaceTrackResult<string>> {
  if (!cfg.user || !cfg.pass) {
    return { ok: false, data: null, notConfigured: true, error: "Space-Track credentials not configured" };
  }

  const url = `${cfg.base ?? SPACETRACK_BASE}/basicspacedata/query/${path}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cookie = await sessionCookie(cfg, attempt > 0);

    try {
      // Routed through the shared downloader so the request takes the same proxy
      // as the vendor ephemeris fetches. Space-Track answers with plain text (a
      // KVN/JSON array); an HTML error page means the session or the route broke.
      const res = await download(
        url,
        (body) => {
          if (!body) return true; // an empty result is a valid "no such object"
          const first = body.subarray(0, 1).toString();
          if (first === "<" || first === "{") return false;
          // TLE text, JSON, or KVN: any non-markup response is a real answer.
          return true;
        },
        {
          timeoutMs: cfg.timeoutMs ?? 45_000,
          retries: 1,
          headers: { cookie, accept: "text/plain,*/*" },
          // TLE text is tiny (one 3LE entry is ~160 bytes), so the generic
          // "large enough" heuristic must not apply here.
        },
      );

      if (res.status === 401 || res.status === 403) {
        // Session expired mid-sweep; the next iteration re-authenticates.
        clearSession();
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, data: null, error: `Space-Track returned HTTP ${res.status}` };
      }
      if (!res.complete) {
        return { ok: false, data: null, error: "Space-Track returned an incomplete or non-text body" };
      }
      return { ok: true, data: res.body.toString("utf8") };
    } catch (err) {
      if (attempt === 1) {
        return {
          ok: false,
          data: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  return { ok: false, data: null, error: "Space-Track request failed after re-authenticating" };
}

export interface GpFetchOptions {
  /** Restrict to specific NORAD catalogue numbers. */
  noradIds?: number[];
  /** Substring match on the object name. */
  objectName?: string;
  /** Restrict to an explicit object type, e.g. `PAYLOAD`. */
  objectType?: "PAYLOAD" | "ROCKET BODY" | "DEBRIS" | "UNKNOWN";
  /** Maximum records, newest elements first. */
  limit?: number;
  /** `gp` (latest per object) or `gp_history`. */
  className?: "gp" | "gp_history";
  /** Only elements with `EPOCH` at or after this instant. */
  minEpochMs?: number;
}

export interface GpFetchResult {
  tles: Tle[];
  errors: TleParseError[];
  /** Diagnostic message when nothing was fetched. */
  error?: string;
  notConfigured?: boolean;
}

/**
 * Fetch GP elements and parse them.
 *
 * Space-Track orders results by `NORAD_CAT_ID` by default; `orderby` is set
 * explicitly so paging is stable.
 */
export async function fetchGp(
  opts: GpFetchOptions = {},
  cfg?: SpaceTrackConfig,
): Promise<GpFetchResult> {
  const parts: string[] = [];

  if (opts.noradIds?.length) {
    parts.push(`NORAD_CAT_ID/${opts.noradIds.join(",")}`);
  }
  if (opts.objectName) {
    // Space-Track's name predicate is literal-prefix unless decorated. `~~` makes
    // it a contains-match, which is what a human typing "STARLINK-1007" expects;
    // without it, a bare `OBJECT_NAME/X` returns nothing for names that exist.
    parts.push(`OBJECT_NAME/~~${encodeURIComponent(opts.objectName)}`);
  }
  if (opts.objectType) {
    parts.push(`OBJECT_TYPE/${encodeURIComponent(opts.objectType)}`);
  }
  if (opts.minEpochMs) {
    parts.push(`EPOCH/%3E${new Date(opts.minEpochMs).toISOString().slice(0, 19)}`);
  }

  parts.push("orderby/NORAD_CAT_ID");
  if (opts.limit && opts.limit > 0) parts.push(`limit/${Math.floor(opts.limit)}`);
  // `3le` is TLE plus a name line. `tle` omits names, and the name is what links a
  // catalogue entry to an object the operator recognises, so prefer `3le`.
  parts.push("format/3le");

  const path = `/class/${opts.className ?? "gp"}/${parts.join("/")}`;
  const res = await spaceTrackGet(path, cfg);

  if (!res.ok) {
    return { tles: [], errors: [], error: res.error, notConfigured: res.notConfigured };
  }

  const parsed = parseTleFile(res.data ?? "");
  return { tles: parsed.tles, errors: parsed.errors };
}

/** Fetch one object's latest elements by NORAD id. */
export async function fetchGpByNorad(
  noradId: number,
  cfg?: SpaceTrackConfig,
): Promise<{ tle: Tle | null; error?: string; notConfigured?: boolean }> {
  const res = await fetchGp({ noradIds: [noradId], limit: 1 }, cfg);
  if (res.error) return { tle: null, error: res.error, notConfigured: res.notConfigured };
  return { tle: res.tles[0] ?? null };
}

/** One row from the `satcat` (satellite catalogue) class. */
export interface SatCatEntry {
  noradId: number;
  name: string;
  intlDesignator: string;
  objectType: string;
  country: string;
  launchDate: string | null;
  /** Set when the object has re-entered; the date of decay. */
  decayDate: string | null;
  periodMin: number | null;
  inclinationDeg: number | null;
  apogeeKm: number | null;
  perigeeKm: number | null;
  rcsM2: number | null;
  /** "Operational", "Nonoperational", "Decayed", "Unknown", ... */
  status: string;
}

interface SatCatRow {
  NORAD_CAT_ID: string;
  SATNAME: string;
  INTLDES?: string;
  OBJECT_TYPE?: string;
  COUNTRY?: string;
  LAUNCH?: string;
  DECAY?: string | null;
  PERIOD?: string;
  INCLINATION?: string;
  APOGEE?: string;
  PERIGEE?: string;
  RCSVALUE?: string;
  CURRENT?: string;
}

/**
 * Look up catalogue metadata.
 *
 * `satcat` is the descriptive class — it answers "what is this object, is it still
 * up there, and when was it launched" — as opposed to `gp`, which carries the
 * elements. Both are needed to attach a NORAD id to an object with any confidence:
 * `gp` gives the orbit, `satcat` gives the identity and the decay date.
 */
export async function fetchSatCat(
  opts: { noradIds?: number[]; objectName?: string; limit?: number },
  cfg?: SpaceTrackConfig,
): Promise<{ entries: SatCatEntry[]; error?: string; notConfigured?: boolean }> {
  const parts: string[] = [];
  if (opts.noradIds?.length) parts.push(`NORAD_CAT_ID/${opts.noradIds.join(",")}`);
  // Same `~~` decoration as `gp`: without it the predicate returns nothing.
  if (opts.objectName) parts.push(`OBJECT_NAME/~~${encodeURIComponent(opts.objectName)}`);
  if (opts.limit && opts.limit > 0) parts.push(`limit/${Math.floor(opts.limit)}`);
  parts.push("format/json");

  const res = await spaceTrackGet(`/class/satcat/${parts.join("/")}`, cfg);
  if (!res.ok) {
    return { entries: [], error: res.error, notConfigured: res.notConfigured };
  }

  let rows: SatCatRow[];
  try {
    rows = JSON.parse(res.data ?? "[]") as SatCatRow[];
  } catch {
    return { entries: [], error: "satcat response was not JSON" };
  }

  return {
    entries: rows.map((r) => ({
      noradId: Number.parseInt(r.NORAD_CAT_ID, 10),
      name: r.SATNAME,
      intlDesignator: r.INTLDES ?? "",
      objectType: r.OBJECT_TYPE ?? "UNKNOWN",
      country: r.COUNTRY ?? "",
      launchDate: r.LAUNCH || null,
      // An empty DECAY field means the object is still in orbit.
      decayDate: r.DECAY || null,
      periodMin: num(r.PERIOD),
      inclinationDeg: num(r.INCLINATION),
      apogeeKm: num(r.APOGEE),
      perigeeKm: num(r.PERIGEE),
      rcsM2: num(r.RCSVALUE),
      status: r.CURRENT ?? "Unknown",
    })),
  };
}

/**
 * One OMM record as Space-Track emits it.
 *
 * **This is not a trajectory.** Every record has `REF_FRAME: TEME` and
 * `MEAN_ELEMENT_THEORY: SGP4`, i.e. it is a mean-element set at a single epoch —
 * the same information a TLE carries, in JSON instead of fixed columns. It is
 * worth having because the fields are named and typed (and it arrives with
 * `OBJECT_TYPE`, `LAUNCH_DATE`, `DECAY_DATE` and a derived apogee/perigee), but it
 * does not improve accuracy over a TLE and it carries no covariance.
 *
 * Genuine trajectory data comes from the operator: Starlink publishes OCM/OEM at
 * `starlink.com/public-files/ephemerides/`, and those are what screening should
 * use for their objects.
 */
export interface OmmRecord {
  noradId: number;
  objectName: string;
  objectId: string;
  /** Always `TEME` for Space-Track data. */
  refFrame: string;
  /** Always `SGP4` for Space-Track data. */
  meanElementTheory: string;
  /** ISO-8601, UTC. */
  epoch: string;
  epochMs: number;
  meanMotionRevPerDay: number;
  eccentricity: number;
  inclinationDeg: number;
  raanDeg: number;
  argPericenterDeg: number;
  meanAnomalyDeg: number;
  bstar: number;
  meanMotionDot: number;
  meanMotionDdot: number;
  semimajorAxisKm: number | null;
  periodMin: number | null;
  apogeeKm: number | null;
  perigeeKm: number | null;
  objectType: string | null;
  rcsSize: string | null;
  launchDate: string | null;
  /** Non-null when the object has re-entered. */
  decayDate: string | null;
  ephemerisType: number;
  elementSetNo: number;
  revAtEpoch: number;
  /** Original JSON, for callers that need a field this shape omits. */
  raw: Record<string, string>;
}

/**
 * Fetch GP data as OMM.
 *
 * Parsed by hand rather than with a schema library: Space-Track returns every
 * value as a string, including numbers and `null`s, so a validator would mostly be
 * numeric coercion. The function is explicit about that instead.
 */
export async function fetchOmm(
  opts: { noradIds?: number[]; objectName?: string; limit?: number } = {},
  cfg?: SpaceTrackConfig,
): Promise<{ records: OmmRecord[]; error?: string; notConfigured?: boolean }> {
  const parts: string[] = [];
  if (opts.noradIds?.length) parts.push(`NORAD_CAT_ID/${opts.noradIds.join(",")}`);
  if (opts.objectName) parts.push(`OBJECT_NAME/~~${encodeURIComponent(opts.objectName)}`);
  if (opts.limit && opts.limit > 0) parts.push(`limit/${Math.floor(opts.limit)}`);
  parts.push("format/json");

  const res = await spaceTrackGet(`/class/gp/${parts.join("/")}`, cfg);
  if (!res.ok) {
    return { records: [], error: res.error, notConfigured: res.notConfigured };
  }

  let rows: Array<Record<string, string>>;
  try {
    rows = JSON.parse(res.data ?? "[]") as Array<Record<string, string>>;
  } catch {
    return { records: [], error: "gp response was not JSON" };
  }

  const records: OmmRecord[] = [];
  for (const r of rows) {
    const norad = Number.parseInt(r.NORAD_CAT_ID ?? "", 10);
    // Space-Track has begun issuing Alpha-5 ids; a record with one cannot be read
    // as a plain integer, so skip rather than store NaN.
    if (!Number.isFinite(norad)) continue;

    // Space-Track omits the trailing Z and can emit a space instead of T.
    const epochText = (r.EPOCH ?? "").replace(" ", "T");
    const epochMs = Date.parse(epochText.endsWith("Z") ? epochText : `${epochText}Z`);

    records.push({
      noradId: norad,
      objectName: r.OBJECT_NAME ?? "",
      objectId: r.OBJECT_ID ?? "",
      refFrame: r.REF_FRAME ?? "",
      meanElementTheory: r.MEAN_ELEMENT_THEORY ?? "",
      epoch: r.EPOCH ?? "",
      epochMs: Number.isFinite(epochMs) ? epochMs : 0,
      meanMotionRevPerDay: num(r.MEAN_MOTION) ?? 0,
      eccentricity: num(r.ECCENTRICITY) ?? 0,
      inclinationDeg: num(r.INCLINATION) ?? 0,
      raanDeg: num(r.RA_OF_ASC_NODE) ?? 0,
      argPericenterDeg: num(r.ARG_OF_PERICENTER) ?? 0,
      meanAnomalyDeg: num(r.MEAN_ANOMALY) ?? 0,
      bstar: num(r.BSTAR) ?? 0,
      meanMotionDot: num(r.MEAN_MOTION_DOT) ?? 0,
      meanMotionDdot: num(r.MEAN_MOTION_DDOT) ?? 0,
      semimajorAxisKm: num(r.SEMIMAJOR_AXIS),
      periodMin: num(r.PERIOD),
      apogeeKm: num(r.APOAPSIS),
      perigeeKm: num(r.PERIAPSIS),
      objectType: r.OBJECT_TYPE ?? null,
      rcsSize: r.RCS_SIZE ?? null,
      launchDate: r.LAUNCH_DATE || null,
      decayDate: r.DECAY_DATE || null,
      ephemerisType: Number.parseInt(r.EPHEMERIS_TYPE ?? "0", 10) || 0,
      elementSetNo: Number.parseInt(r.ELEMENT_SET_NO ?? "0", 10) || 0,
      revAtEpoch: Number.parseInt(r.REV_AT_EPOCH ?? "0", 10) || 0,
      raw: r,
    });
  }

  return { records };
}
