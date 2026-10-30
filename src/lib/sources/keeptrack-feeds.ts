/**
 * The KeepTrack v4 endpoints this project uses, and why each one.
 *
 * ## What the probe established
 *
 * All 86 endpoints were called once (`tools/keeptrack-probe.ts`). This file is the
 * result of that measurement, not of reading the spec: an endpoint that is listed
 * may still return nothing, and two of them (`/launch-history`, `/text-data`) return
 * HTTP 400 without parameters that the document does not mention.
 *
 * ## The three that add something the catalogue did not have
 *
 *   /socrates/latest   CelesTrak's conjunction screening — every event, with TCA,
 *                      minimum range, relative velocity and max probability. This is
 *                      the same class of data the space-safety service we are
 *                      reproducing publishes, and we had none of it.
 *   /reentries         Predicted re-entry: epoch, window, lat/lon, direction.
 *   /launch-history/*  Launch totals by year, month, vehicle and site — the context
 *                      a catalogue needs to say "this constellation grew 30% this
 *                      year" rather than just listing objects.
 *
 * ## What is deliberately not taken
 *
 *   /sat/{id}/eci|lla|...   Instantaneous positions. We propagate locally with the
 *                           ephemeris we already hold; taking them would give a
 *                           second, differently-converged answer to the same
 *                           question.
 *   /sats/celestrak|satnogs|vimpel
 *                           TLE feeds we already ingest from Space-Track and
 *                           Spacebook. A fourth copy would make `master_element_set`
 *                           ambiguous without adding coverage.
 *   /text-data/*            Pipe-delimited exports of the same rows as /sats.
 *   /radiopasses, /channels, /trivia, /news
 *                           Not orbital safety.
 */

import type Database from "better-sqlite3";

import { ACCEPT_ENCODING } from "../net/encoding";

const BASE = "https://api.keeptrack.space/v4";

function key(): string {
  return process.env.SPACE_SAFETY_KEEPTRACK_KEY ?? "";
}

async function get<T>(path: string): Promise<{ data: T | null; note?: string }> {
  if (!key()) return { data: null, note: "未配置 API key" };
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { "X-API-Key": key(), Accept: "application/json", "accept-encoding": ACCEPT_ENCODING },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return { data: null, note: `HTTP ${res.status}` };
    return { data: (await res.json()) as T, note: undefined };
  } catch (err) {
    return { data: null, note: (err as Error).message };
  }
}

// ------------------------------------------------------------- conjunctions

/** One SOCRATES screening event. */
export interface SocratesEvent {
  id: number;
  sat1Norad: number;
  sat1Name: string | null;
  sat1Status: string | null;
  sat2Norad: number;
  sat2Name: string | null;
  sat2Status: string | null;
  /** Age of each element set at screening time, days. */
  sat1TleAgeDays: number | null;
  sat2TleAgeDays: number | null;
  /** Time of closest approach, ISO 8601. */
  tca: string | null;
  /** Minimum range, km. */
  minRangeKm: number | null;
  /** Relative velocity, km/s. */
  relSpeedKmS: number | null;
  /** Maximum collision probability over the event. */
  maxProb: number | null;
  dilutionThreshold: number | null;
}

interface RawSocrates {
  ID?: number;
  SAT1?: string;
  SAT1_NAME?: string;
  SAT1_STATUS?: string;
  SAT2?: string;
  SAT2_NAME?: string;
  SAT2_STATUS?: string;
  SAT1_AGE_OF_TLE?: number;
  SAT2_AGE_OF_TLE?: number;
  TOCA?: string;
  MIN_RNG?: number;
  REL_SPEED?: number;
  MAX_PROB?: number;
  DILUTION_THRESHOLD?: number;
}

/**
 * SOCRATES events.
 *
 * `MAX_PROB: 1` is not a probability of one — CelesTrak reports a sentinel when the
 * screen could not compute a value, and storing it as 1.0 would make every such
 * event look like a certain collision. Values ≥ 1 are treated as "not computed".
 */
export async function fetchSocrates(): Promise<{ events: SocratesEvent[]; note?: string }> {
  const { data, note } = await get<RawSocrates[]>("/socrates/latest");
  if (!data) return { events: [], note };

  const events: SocratesEvent[] = [];
  for (const r of data) {
    const sat1 = Number(r.SAT1);
    const sat2 = Number(r.SAT2);
    if (!Number.isInteger(sat1) || !Number.isInteger(sat2)) continue;
    const prob = typeof r.MAX_PROB === "number" && r.MAX_PROB >= 0 && r.MAX_PROB < 1 ? r.MAX_PROB : null;
    events.push({
      id: Number(r.ID ?? 0),
      sat1Norad: sat1,
      sat1Name: r.SAT1_NAME ?? null,
      sat1Status: r.SAT1_STATUS ?? null,
      sat2Norad: sat2,
      sat2Name: r.SAT2_NAME ?? null,
      sat2Status: r.SAT2_STATUS ?? null,
      sat1TleAgeDays: typeof r.SAT1_AGE_OF_TLE === "number" ? r.SAT1_AGE_OF_TLE : null,
      sat2TleAgeDays: typeof r.SAT2_AGE_OF_TLE === "number" ? r.SAT2_AGE_OF_TLE : null,
      tca: r.TOCA ?? null,
      minRangeKm: typeof r.MIN_RNG === "number" ? r.MIN_RNG : null,
      relSpeedKmS: typeof r.REL_SPEED === "number" ? r.REL_SPEED : null,
      maxProb: prob,
      dilutionThreshold:
        typeof r.DILUTION_THRESHOLD === "number" ? r.DILUTION_THRESHOLD : null,
    });
  }
  return { events };
}

// ---------------------------------------------------------------- reentries

export interface PredictedReentry {
  noradId: number;
  name: string | null;
  decayEpoch: string | null;
  windowHours: number | null;
  msgEpoch: string | null;
  lat: number | null;
  lon: number | null;
  inclinationDeg: number | null;
  direction: string | null;
  highInterest: boolean;
}

/** Predicted re-entries, which the three catalogues do not provide at all. */
export async function fetchReentries(): Promise<{
  entries: PredictedReentry[];
  note?: string;
}> {
  const { data, note } = await get<
    Array<{
      noradId?: number;
      name?: string;
      decayEpoch?: string;
      windowHours?: number;
      msgEpoch?: string;
      lat?: number;
      lon?: number;
      incl?: number;
      direction?: string;
      highInterest?: boolean;
    }>
  >("/reentries");
  if (!data) return { entries: [], note };

  const entries: PredictedReentry[] = [];
  for (const r of data) {
    const id = Number(r.noradId);
    if (!Number.isInteger(id) || id <= 0) continue;
    entries.push({
      noradId: id,
      name: r.name ?? null,
      decayEpoch: r.decayEpoch ?? null,
      windowHours: typeof r.windowHours === "number" ? r.windowHours : null,
      msgEpoch: r.msgEpoch ?? null,
      lat: typeof r.lat === "number" ? r.lat : null,
      lon: typeof r.lon === "number" ? r.lon : null,
      inclinationDeg: typeof r.incl === "number" ? r.incl : null,
      direction: r.direction ?? null,
      highInterest: r.highInterest === true,
    });
  }
  return { entries };
}

// ----------------------------------------------------------- launch history

export interface LaunchYear {
  year: number;
  launches: number;
  successes: number;
  failures: number;
}

export interface LaunchByVehicle {
  year: number;
  vehicle: string;
  launches: number;
  successes: number;
  failures: number;
}

export interface LaunchBySite {
  year: number;
  site: string;
  launches: number;
  successes: number;
  failures: number;
}

export interface LaunchByMonth {
  ym: string;
  launches: number;
}

export interface UpcomingLaunch {
  id: number | string | null;
  name: string | null;
  net: string | null;
  status: string | null;
  vehicle: string | null;
  pad: string | null;
}

export async function fetchLaunchYears(): Promise<LaunchYear[]> {
  const { data } = await get<LaunchYear[]>("/launch-history/years");
  return Array.isArray(data) ? data : [];
}

export async function fetchLaunchByVehicle(): Promise<LaunchByVehicle[]> {
  const { data } = await get<LaunchByVehicle[]>("/launch-history/by-vehicle");
  return Array.isArray(data) ? data : [];
}

export async function fetchLaunchBySite(): Promise<LaunchBySite[]> {
  const { data } = await get<LaunchBySite[]>("/launch-history/by-site");
  return Array.isArray(data) ? data : [];
}

export async function fetchLaunchByMonth(): Promise<LaunchByMonth[]> {
  const { data } = await get<LaunchByMonth[]>("/launch-history/months");
  return Array.isArray(data) ? data : [];
}

export async function fetchUpcomingLaunches(): Promise<UpcomingLaunch[]> {
  const { data } = await get<Array<Record<string, unknown>>>("/launches");
  if (!Array.isArray(data)) return [];
  return data.map((r) => ({
    id: (r.id as number | string | undefined) ?? null,
    name: (r.name as string | undefined) ?? null,
    net: (r.net as string | undefined) ?? null,
    status: (r.status as { abbrev?: string } | string | undefined)
      ? typeof r.status === "string"
        ? r.status
        : ((r.status as { abbrev?: string }).abbrev ?? null)
      : null,
    vehicle:
      ((r.rocket as { configuration?: { name?: string } } | undefined)?.configuration?.name as
        | string
        | undefined) ?? null,
    pad: ((r.pad as { name?: string } | undefined)?.name as string | undefined) ?? null,
  }));
}

// ------------------------------------------------------------------ metrics

export interface CatalogueMetrics {
  activePayloads: number | null;
  inactivePayloads: number | null;
  payloads: number | null;
  debris: number | null;
  totalSatellites: number | null;
  noradSatellites: number | null;
  orbitingSatellites: number | null;
  reenteredSatellites: number | null;
}

export async function fetchMetrics(): Promise<CatalogueMetrics> {
  const [active, inactive, payload, debris, health] = await Promise.all([
    get<{ count?: number }>("/metrics/active/count"),
    get<{ count?: number }>("/metrics/inactive/count"),
    get<{ count?: number }>("/metrics/payload/count"),
    get<{ count?: number }>("/metrics/debris/count"),
    get<Record<string, number>>("/health"),
  ]);
  const c = (v: { count?: number } | null): number | null =>
    v && typeof v.count === "number" ? v.count : null;
  return {
    activePayloads: c(active.data),
    inactivePayloads: c(inactive.data),
    payloads: c(payload.data),
    debris: c(debris.data),
    totalSatellites: health.data?.totalSatellites ?? null,
    noradSatellites: health.data?.noradSatellites ?? null,
    orbitingSatellites: health.data?.orbitingSatellites ?? null,
    reenteredSatellites: health.data?.reenteredSatellites ?? null,
  };
}

// ------------------------------------------------------------------ storage

/**
 * Tables for the derived KeepTrack feeds.
 *
 * Separate from `keeptrack_object`: that table is one row per object and is replaced
 * wholesale, while these are time-series (a conjunction event is a moment, not an
 * attribute) and accumulate across runs.
 */
export const KEEPTRACK_FEEDS_DDL = `
CREATE TABLE IF NOT EXISTS keeptrack_conjunction (
  id              INTEGER PRIMARY KEY,
  sat1_norad      INTEGER NOT NULL,
  sat1_name       TEXT,
  sat1_status     TEXT,
  sat2_norad      INTEGER NOT NULL,
  sat2_name       TEXT,
  sat2_status     TEXT,
  sat1_tle_age_d  REAL,
  sat2_tle_age_d  REAL,
  tca             TEXT,
  min_range_km    REAL,
  rel_speed_kms   REAL,
  max_prob        REAL,
  fetched_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ktc_tca_idx ON keeptrack_conjunction(tca);
CREATE INDEX IF NOT EXISTS ktc_sat1_idx ON keeptrack_conjunction(sat1_norad);
CREATE INDEX IF NOT EXISTS ktc_sat2_idx ON keeptrack_conjunction(sat2_norad);

CREATE TABLE IF NOT EXISTS keeptrack_reentry (
  norad_id        INTEGER PRIMARY KEY,
  name            TEXT,
  decay_epoch     TEXT,
  window_hours    REAL,
  msg_epoch       TEXT,
  lat             REAL,
  lon             REAL,
  inclination_deg REAL,
  direction       TEXT,
  high_interest   INTEGER NOT NULL DEFAULT 0,
  fetched_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ktr_decay_idx ON keeptrack_reentry(decay_epoch);

CREATE TABLE IF NOT EXISTS keeptrack_launch_stat (
  kind    TEXT NOT NULL,
  key1    TEXT NOT NULL,
  key2    TEXT,
  launches INTEGER NOT NULL,
  successes INTEGER,
  failures  INTEGER,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (kind, key1, key2)
);

CREATE TABLE IF NOT EXISTS keeptrack_upcoming_launch (
  id        TEXT PRIMARY KEY,
  name      TEXT,
  net       TEXT,
  status    TEXT,
  vehicle   TEXT,
  pad       TEXT,
  fetched_at TEXT NOT NULL
);
`;

export class KeepTrackFeeds {
  constructor(private readonly sqlite: Database.Database) {
    this.sqlite.exec(KEEPTRACK_FEEDS_DDL);
  }

  replaceConjunctions(events: SocratesEvent[]): number {
    const now = new Date().toISOString();
    const stmt = this.sqlite.prepare(
      `INSERT OR REPLACE INTO keeptrack_conjunction
         (id, sat1_norad, sat1_name, sat1_status, sat2_norad, sat2_name, sat2_status,
          sat1_tle_age_d, sat2_tle_age_d, tca, min_range_km, rel_speed_kms, max_prob, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.sqlite.transaction((rows: SocratesEvent[]) => {
      this.sqlite.prepare("DELETE FROM keeptrack_conjunction").run();
      for (const e of rows) {
        stmt.run(
          e.id,
          e.sat1Norad,
          e.sat1Name,
          e.sat1Status,
          e.sat2Norad,
          e.sat2Name,
          e.sat2Status,
          e.sat1TleAgeDays,
          e.sat2TleAgeDays,
          e.tca,
          e.minRangeKm,
          e.relSpeedKmS,
          e.maxProb,
          now,
        );
      }
    })(events);
    return events.length;
  }

  replaceReentries(entries: PredictedReentry[]): number {
    const now = new Date().toISOString();
    const stmt = this.sqlite.prepare(
      `INSERT OR REPLACE INTO keeptrack_reentry
         (norad_id, name, decay_epoch, window_hours, msg_epoch, lat, lon,
          inclination_deg, direction, high_interest, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.sqlite.transaction((rows: PredictedReentry[]) => {
      this.sqlite.prepare("DELETE FROM keeptrack_reentry").run();
      for (const r of rows) {
        stmt.run(
          r.noradId,
          r.name,
          r.decayEpoch,
          r.windowHours,
          r.msgEpoch,
          r.lat,
          r.lon,
          r.inclinationDeg,
          r.direction,
          r.highInterest ? 1 : 0,
          now,
        );
      }
    })(entries);
    return entries.length;
  }

  replaceLaunchStats(
    years: LaunchYear[],
    byVehicle: LaunchByVehicle[],
    bySite: LaunchBySite[],
    byMonth: LaunchByMonth[],
  ): number {
    const now = new Date().toISOString();
    const stmt = this.sqlite.prepare(
      `INSERT OR REPLACE INTO keeptrack_launch_stat
         (kind, key1, key2, launches, successes, failures, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let n = 0;
    this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM keeptrack_launch_stat").run();
      for (const y of years) {
        stmt.run("year", String(y.year), null, y.launches, y.successes, y.failures, now);
        n += 1;
      }
      for (const v of byVehicle) {
        stmt.run("vehicle", String(v.year), v.vehicle, v.launches, v.successes, v.failures, now);
        n += 1;
      }
      for (const s of bySite) {
        stmt.run("site", String(s.year), s.site, s.launches, s.successes, s.failures, now);
        n += 1;
      }
      for (const m of byMonth) {
        stmt.run("month", m.ym, null, m.launches, null, null, now);
        n += 1;
      }
    })();
    return n;
  }

  replaceUpcoming(launches: UpcomingLaunch[]): number {
    const now = new Date().toISOString();
    const stmt = this.sqlite.prepare(
      `INSERT OR REPLACE INTO keeptrack_upcoming_launch
         (id, name, net, status, vehicle, pad, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.sqlite.transaction((rows: UpcomingLaunch[]) => {
      this.sqlite.prepare("DELETE FROM keeptrack_upcoming_launch").run();
      for (const r of rows) {
        if (r.id === null) continue;
        stmt.run(String(r.id), r.name, r.net, r.status, r.vehicle, r.pad, now);
      }
    })(launches);
    return launches.length;
  }
}
