/**
 * KeepTrack API v4 as a fourth catalogue source.
 *
 * ## Why a source and not a supplement
 *
 * The supplement layer exists for values that cannot be attributed. KeepTrack is
 * different: it is a registered service that returns the same record for the same
 * NORAD id to anyone who asks, it names the catalogue each value came from in
 * `source`, and for the records it has researched it also lists the URLs in
 * `sources`. That is auditable in the same way Space-Track is — by re-requesting it.
 *
 * So it becomes a fourth column in the wide table, next to Space-Track, Spacebook and
 * DISCOS, and a user can choose it per field. It is **not** silently merged.
 *
 * ## The measured shape of the data
 *
 * One `/v4/sats` call returns all 50 539 objects in 24 MB:
 *
 *   name           99.8%      manufacturer   47.6%      shape    42.4%
 *   bus            41.7%      launchMass     42.4%      span     42.8%
 *   owner          67.1%      country        68.0%
 *   source         99.8%   (which catalogue the record came from)
 *   sources         0.2%   (URLs — most records have none)
 *
 * The low `sources` coverage is why this cannot be treated as a primary source of
 * truth: it is a compiled index whose values mostly trace back to Space-Track and
 * CelesTrak, which we already have. Its value is the physical fields those two do not
 * carry — manufacturer, bus, shape, dimensions — where Spacebook is also thin.
 *
 * ## Zero is not a value
 *
 * `launchMass: "0"` appears as a placeholder. Storing it would put a zero-kilogram
 * satellite into the catalogue, so zeros and empty strings are dropped.
 */

import type Database from "better-sqlite3";

const BASE = "https://api.keeptrack.space/v4";

export function keepTrackApiKey(): string {
  return process.env.SPACE_SAFETY_KEEPTRACK_KEY ?? "";
}

/** One row of `/v4/sats`, reduced to the fields this project uses. */
export interface KeepTrackRecord {
  /** 0 when the object has no NORAD id yet; `cosparId` is then the only key. */
  noradId: number;
  cosparId: string | null;
  name: string | null;
  altName: string | null;
  /** KeepTrack's object type code: 1 payload, 2 rocket body, 3 debris, 4 unknown. */
  type: number | null;
  launchDate: string | null;
  country: string | null;
  owner: string | null;
  launchSite: string | null;
  launchVehicle: string | null;
  manufacturer: string | null;
  bus: string | null;
  configuration: string | null;
  shape: string | null;
  launchMassKg: number | null;
  dryMassKg: number | null;
  lengthM: number | null;
  diameterM: number | null;
  spanM: number | null;
  motor: string | null;
  rcsM2: number | null;
  purpose: string | null;
  /** Which catalogue this record was compiled from, e.g. `spacetrack`. */
  source: string | null;
  /** URLs, when the record was researched. Mostly absent. */
  sourceUrls: string[];
  tle1: string | null;
  tle2: string | null;
}

interface RawSats {
  tle1?: string;
  tle2?: string;
  type?: number;
  name?: string;
  altName?: string;
  launchDate?: string;
  country?: string;
  owner?: string;
  launchSite?: string;
  launchVehicle?: string;
  manufacturer?: string;
  bus?: string;
  configuration?: string;
  shape?: string;
  launchMass?: string | number;
  dryMass?: string | number;
  length?: string | number;
  diameter?: string | number;
  span?: string | number;
  motor?: string;
  rcs?: string | number;
  purpose?: string;
  source?: string;
  sources?: string | string[];
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "" || t === "0" || t === "0.0") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Parse `sources`, which arrives as a JSON-looking string inside a JSON string.
 *
 * `"['https://a', 'https://b']"` uses single quotes, so `JSON.parse` fails; splitting
 * on the quote characters is what actually works.
 */
function parseUrls(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => parseUrls(x));
  if (typeof v !== "string") return [];
  const out: string[] = [];
  const re = /https?:\/\/[^\s'",\]]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v)) !== null) out.push(m[0]);
  return [...new Set(out)];
}

/** NORAD from a TLE line 1, columns 3–7. */
function noradFromTle(tle1: string | null): number | null {
  if (!tle1 || tle1.length < 7) return null;
  const n = Number(tle1.slice(2, 7).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** COSPAR designator from a TLE line 1, columns 10–17, e.g. `26067CY` → `2026-067CY`. */
function cosparFromTle(tle1: string | null): string | null {
  if (!tle1 || tle1.length < 17) return null;
  const raw = tle1.slice(9, 17).trim();
  if (!/^\d{5}[A-Z]{1,3}$/.test(raw)) return null;
  const yy = Number(raw.slice(0, 2));
  // TLE uses a two-digit year; 57 is the conventional pivot (Sputnik onward).
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return `${year}-${raw.slice(2)}`;
}

export interface FetchResult {
  records: KeepTrackRecord[];
  total: number;
  errors: number;
  /** Rows carrying only a COSPAR designator and no NORAD id. */
  provisional?: number;
  note?: string;
}

/**
 * Fetch the whole KeepTrack catalogue.
 *
 * One request for all 50 539 objects takes about 8 s and 24 MB, so there is no
 * reason to page. If the endpoint ever refuses a bulk read, `fetchOne` is the
 * per-object fallback.
 */
export async function fetchAllKeepTrack(): Promise<FetchResult> {
  const key = keepTrackApiKey();
  if (!key) return { records: [], total: 0, errors: 0, note: "未配置 KeepTrack API key" };

  let res: Response;
  try {
    res = await fetch(`${BASE}/sats`, {
      headers: { "X-API-Key": key, Accept: "application/json" },
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    return { records: [], total: 0, errors: 0, note: `请求失败：${(err as Error).message}` };
  }

  if (!res.ok) {
    return { records: [], total: 0, errors: 0, note: `HTTP ${res.status}` };
  }

  let raw: RawSats[];
  try {
    raw = (await res.json()) as RawSats[];
  } catch {
    return { records: [], total: 0, errors: 0, note: "返回不是 JSON 数组" };
  }

  const records: KeepTrackRecord[] = [];
  let errors = 0;
  let provisional = 0;

  for (const r of raw) {
    const noradId = noradFromTle(r.tle1 ?? null);
    if (noradId === null) {
      // KeepTrack assigns provisional ids (`A0000`) to newly tracked objects that
      // have not been catalogued yet — 16 429 of the 50 539 on the day of writing,
      // including most of the newest Starlink batch. They carry almost no physical
      // data (2 had a manufacturer, none a shape), so there is nothing to attach to
      // the catalogue by NORAD, and their COSPAR is the only usable key.
      provisional += 1;
      const cospar = cosparFromTle(r.tle1 ?? null);
      if (!cospar) {
        errors += 1;
        continue;
      }
      records.push({
        noradId: 0,
        cosparId: cospar,
        name: str(r.name),
        altName: str(r.altName),
        type: typeof r.type === "number" ? r.type : null,
        launchDate: str(r.launchDate),
        country: str(r.country),
        owner: str(r.owner),
        launchSite: str(r.launchSite),
        launchVehicle: str(r.launchVehicle),
        manufacturer: str(r.manufacturer),
        bus: str(r.bus),
        configuration: str(r.configuration),
        shape: str(r.shape),
        launchMassKg: num(r.launchMass),
        dryMassKg: num(r.dryMass),
        lengthM: num(r.length),
        diameterM: num(r.diameter),
        spanM: num(r.span),
        motor: str(r.motor),
        rcsM2: num(r.rcs),
        purpose: str(r.purpose),
        source: str(r.source),
        sourceUrls: parseUrls(r.sources),
        tle1: str(r.tle1),
        tle2: str(r.tle2),
      });
      continue;
    }
    records.push({
      noradId,
      cosparId: cosparFromTle(r.tle1 ?? null),
      name: str(r.name),
      altName: str(r.altName),
      type: typeof r.type === "number" ? r.type : null,
      launchDate: str(r.launchDate),
      country: str(r.country),
      owner: str(r.owner),
      launchSite: str(r.launchSite),
      launchVehicle: str(r.launchVehicle),
      manufacturer: str(r.manufacturer),
      bus: str(r.bus),
      configuration: str(r.configuration),
      shape: str(r.shape),
      launchMassKg: num(r.launchMass),
      dryMassKg: num(r.dryMass),
      lengthM: num(r.length),
      diameterM: num(r.diameter),
      spanM: num(r.span),
      motor: str(r.motor),
      rcsM2: num(r.rcs),
      purpose: str(r.purpose),
      source: str(r.source),
      sourceUrls: parseUrls(r.sources),
      tle1: str(r.tle1),
      tle2: str(r.tle2),
    });
  }

  return { records, total: raw.length, errors, note: undefined, provisional };
}

/** Per-object fallback, used when the bulk endpoint is unavailable. */
export async function fetchOneKeepTrack(noradId: number): Promise<KeepTrackRecord | null> {
  const key = keepTrackApiKey();
  if (!key) return null;
  const res = await fetch(`${BASE}/sat/${noradId}`, {
    headers: { "X-API-Key": key, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as Record<string, unknown>;
  return {
    noradId,
    cosparId: cosparFromTle(str(j.TLE_LINE_1)),
    name: str(j.NAME),
    altName: str(j.ALT_NAME),
    type: null,
    launchDate: str(j.LAUNCH_DATE),
    country: str(j.COUNTRY),
    owner: str(j.OWNER),
    launchSite: str(j.LAUNCH_SITE),
    launchVehicle: str(j.LAUNCH_VEHICLE),
    manufacturer: str(j.MANUFACTURER),
    bus: str(j.BUS),
    configuration: str(j.CONFIGURATION),
    shape: str(j.SHAPE),
    launchMassKg: num(j.LAUNCH_MASS),
    dryMassKg: num(j.DRY_MASS),
    lengthM: num(j.LENGTH),
    diameterM: num(j.DIAMETER),
    spanM: num(j.SPAN),
    motor: str(j.MOTOR),
    rcsM2: num(j.RCS),
    purpose: str(j.PURPOSE),
    source: str(j.ELSET_SOURCE),
    sourceUrls: parseUrls(j.reference_urls),
    tle1: str(j.TLE_LINE_1),
    tle2: str(j.TLE_LINE_2),
  };
}

/** Storage for the localised KeepTrack catalogue. */
export const KEEPTRACK_DDL = `
CREATE TABLE IF NOT EXISTS keeptrack_object (
  norad_id       INTEGER,
  cospar_id      TEXT,
  name           TEXT,
  alt_name       TEXT,
  kt_type        INTEGER,
  launch_date    TEXT,
  country        TEXT,
  owner          TEXT,
  launch_site    TEXT,
  launch_vehicle TEXT,
  manufacturer   TEXT,
  bus            TEXT,
  configuration  TEXT,
  shape          TEXT,
  launch_mass_kg REAL,
  dry_mass_kg    REAL,
  length_m       REAL,
  diameter_m     REAL,
  span_m         REAL,
  motor          TEXT,
  rcs_m2         REAL,
  purpose        TEXT,
  source         TEXT,
  source_urls    TEXT,
  tle_epoch      TEXT,
  fetched_at     TEXT NOT NULL,
  PRIMARY KEY (norad_id, cospar_id)
);
CREATE INDEX IF NOT EXISTS kt_manufacturer_idx ON keeptrack_object(manufacturer);
CREATE INDEX IF NOT EXISTS kt_shape_idx ON keeptrack_object(shape);
CREATE INDEX IF NOT EXISTS kt_cospar_idx ON keeptrack_object(cospar_id);
`;

export class KeepTrackStore {
  private readonly insert: Database.Statement;

  constructor(private readonly sqlite: Database.Database) {
    // The first version of this table was keyed on NORAD alone and had no
    // `cospar_id`. `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so
    // the column has to be added explicitly before the index that uses it.
    const existing = sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='keeptrack_object'").get() as { n: number };
    if (existing.n > 0) {
      const cols = sqlite.pragma("table_info(keeptrack_object)") as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "cospar_id")) {
        // Rows from the old schema cannot satisfy the new primary key, and they are
        // a previous full fetch that the next one replaces anyway.
        sqlite.exec("DROP TABLE keeptrack_object");
      }
    }
    this.sqlite.exec(KEEPTRACK_DDL);
    this.insert = sqlite.prepare(
      `INSERT OR REPLACE INTO keeptrack_object
         (norad_id, cospar_id, name, alt_name, kt_type, launch_date, country, owner, launch_site,
          launch_vehicle, manufacturer, bus, configuration, shape, launch_mass_kg,
          dry_mass_kg, length_m, diameter_m, span_m, motor, rcs_m2, purpose, source,
          source_urls, tle_epoch, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /** Replace the whole table: a full fetch supersedes every earlier row. */
  replaceAll(records: KeepTrackRecord[]): number {
    const now = new Date().toISOString();
    const tx = this.sqlite.transaction((rows: KeepTrackRecord[]) => {
      this.sqlite.prepare("DELETE FROM keeptrack_object").run();
      for (const r of rows) {
        this.insert.run(
          r.noradId,
          r.cosparId,
          r.name,
          r.altName,
          r.type,
          r.launchDate,
          r.country,
          r.owner,
          r.launchSite,
          r.launchVehicle,
          r.manufacturer,
          r.bus,
          r.configuration,
          r.shape,
          r.launchMassKg,
          r.dryMassKg,
          r.lengthM,
          r.diameterM,
          r.spanM,
          r.motor,
          r.rcsM2,
          r.purpose,
          r.source,
          r.sourceUrls.length ? JSON.stringify(r.sourceUrls) : null,
          null,
          now,
        );
      }
    });
    tx(records);
    return records.length;
  }

  count(): number {
    return (this.sqlite.prepare("SELECT COUNT(*) AS n FROM keeptrack_object").get() as { n: number }).n;
  }

  /** Field coverage, for the build report. */
  coverage(): Array<{ field: string; n: number; pct: number }> {
    const total = this.count();
    const fields = [
      "name",
      "manufacturer",
      "bus",
      "shape",
      "launch_mass_kg",
      "dry_mass_kg",
      "length_m",
      "diameter_m",
      "span_m",
      "motor",
      "owner",
      "country",
      "launch_date",
      "source_urls",
    ];
    const out: Array<{ field: string; n: number; pct: number }> = [];
    for (const f of fields) {
      const row = this.sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM keeptrack_object
            WHERE ${f} IS NOT NULL AND ${f} <> ''`,
        )
        .get() as { n: number };
      out.push({ field: f, n: row.n, pct: total ? (row.n / total) * 100 : 0 });
    }
    return out;
  }
}
