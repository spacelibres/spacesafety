import "server-only";

import { getDb } from "@/db";

/**
 * Queries for the event / environment / launch feeds.
 *
 * ## Why this is separate from `queries.ts`
 *
 * `queries.ts` reads the tables the application itself writes — operators,
 * objects, trajectories, CDMs. This module reads the tables **loaders** write
 * from archived source files (`event-feeds.ts`, `keeptrack-feeds.ts`), which have
 * no drizzle schema and a different lifecycle: they are replaced wholesale from a
 * capture, never edited by the app.
 *
 * Keeping them apart makes the provenance obvious at the call site: anything from
 * here is a vendor's statement, not ours.
 *
 * ## The two conventions every reader must know
 *
 * 1. **`space_track_decay` is a union of four feeds.** `source` says which, and
 *    `msg_type` decides the meaning: `Historical` is when 18 SDS stopped tracking
 *    the object, `Prediction` is a forecast. Mixing them reports predictions as
 *    history. Everything here filters on one or the other explicitly.
 * 2. **`space_track_tip` is mostly history.** 26 184 of its 26 189 rows predict a
 *    decay epoch that has already passed. A "re-entry predictions" list must
 *    filter on the epoch, not show the newest messages.
 *
 * See `docs/DATA-INVENTORY.md` for the measured shapes.
 */

// ------------------------------------------------------------------ re-entry

export interface ReentrySummary {
  /** TIP messages in total (predictions, mostly historical). */
  tipMessages: number;
  /** TIP rows whose predicted epoch has not yet arrived. */
  tipUpcoming: number;
  /** Every `space_track_decay` row, both message types. */
  decayRows: number;
  /** Rows that record a completed re-entry. */
  decayHistorical: number;
  /** Rows that are forecasts — excluded from the "recent" list. */
  decayPrediction: number;
  /** Distinct objects that have re-entered (historical rows). */
  decayedObjects: number;
  /** KeepTrack's own re-entry feed. */
  keepTrackRows: number;
}

export function reentrySummary(now: Date = new Date()): ReentrySummary {
  const { sqlite } = getDb();
  const nowIso = now.toISOString();
  const tip = sqlite
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN decay_epoch >= @now THEN 1 ELSE 0 END) AS upcoming
         FROM space_track_tip`,
    )
    .get({ now: nowIso }) as { total: number; upcoming: number | null };
  const decay = sqlite
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN msg_type = 'Historical' THEN 1 ELSE 0 END) AS historical,
              SUM(CASE WHEN msg_type = 'Prediction' THEN 1 ELSE 0 END) AS prediction,
              COUNT(DISTINCT CASE WHEN msg_type = 'Historical' THEN norad_id END) AS objects
         FROM space_track_decay`,
    )
    .get() as {
    total: number;
    historical: number | null;
    prediction: number | null;
    objects: number | null;
  };
  const keep = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM keeptrack_reentry`)
    .get() as { n: number };

  return {
    tipMessages: tip.total,
    tipUpcoming: tip.upcoming ?? 0,
    decayRows: decay.total,
    decayHistorical: decay.historical ?? 0,
    decayPrediction: decay.prediction ?? 0,
    decayedObjects: decay.objects ?? 0,
    keepTrackRows: keep.n,
  };
}

export interface UpcomingReentryRow {
  noradId: number;
  name: string | null;
  /** Predicted re-entry instant. */
  decayIso: string | null;
  windowMinutes: number | null;
  direction: string | null;
  latDeg: number | null;
  lonDeg: number | null;
  highInterest: boolean;
  /** `space-track` (TIP) or `keeptrack`. */
  source: "space-track" | "keeptrack";
  /** When the prediction was issued. */
  issuedIso: string | null;
}

/**
 * Re-entries that have not happened yet, soonest first.
 *
 * Both sources are listed side by side rather than merged: they are independent
 * predictions of the same event, and averaging two forecasts of a re-entry would
 * invent an answer neither source gave.
 *
 * Object names come from the catalogue where the id resolves; TIP itself carries
 * only the NORAD number.
 */
export function listUpcomingReentries(limit = 100, now: Date = new Date()): UpcomingReentryRow[] {
  const { sqlite } = getDb();
  const nowIso = now.toISOString();
  return sqlite
    .prepare(
      `SELECT t.norad_id       AS noradId,
              c.name           AS name,
              t.decay_epoch    AS decayIso,
              t.window_min     AS windowMinutes,
              t.direction      AS direction,
              t.lat_deg        AS latDeg,
              t.lon_deg        AS lonDeg,
              t.high_interest  AS highInterest,
              'space-track'    AS source,
              t.msg_epoch      AS issuedIso
         FROM space_track_tip t
         LEFT JOIN master_object c ON c.norad_id = t.norad_id
        WHERE t.decay_epoch >= @now
        UNION ALL
       SELECT k.norad_id,
              COALESCE(c.name, k.name),
              k.decay_epoch,
              CAST(ROUND(k.window_hours * 60) AS INTEGER),
              k.direction,
              k.lat,
              k.lon,
              k.high_interest,
              'keeptrack',
              k.msg_epoch
         FROM keeptrack_reentry k
         LEFT JOIN master_object c ON c.norad_id = k.norad_id
        WHERE k.decay_epoch >= @now
        ORDER BY decayIso ASC
        LIMIT @limit`,
    )
    .all({ now: nowIso, limit }) as UpcomingReentryRow[];
}

export interface RecentReentryRow {
  noradId: number;
  name: string | null;
  decayIso: string | null;
  country: string | null;
  rcsSize: string | null;
  /** Which of the four merged feeds this row came from. */
  feed: string | null;
}

/**
 * The most recent completed re-entries.
 *
 * `msg_type = 'Historical'` only: the same table carries forecasts, and a list
 * headed "recent re-entries" must not include something that has not happened.
 * One row per object: an object can have several historical messages (the epoch
 * is revisable), and the newest message is the settled answer.
 */
export function listRecentReentries(limit = 100): RecentReentryRow[] {
  const { sqlite } = getDb();
  return sqlite
    .prepare(
      `WITH ranked AS (
         SELECT norad_id, name, decay_epoch, country, rcs_size, source,
                ROW_NUMBER() OVER (PARTITION BY norad_id ORDER BY msg_epoch DESC) AS rn
           FROM space_track_decay
          WHERE msg_type = 'Historical'
       )
       SELECT norad_id AS noradId,
              name,
              decay_epoch AS decayIso,
              country,
              rcs_size AS rcsSize,
              source AS feed
         FROM ranked
        WHERE rn = 1
        ORDER BY decay_epoch DESC
        LIMIT @limit`,
    )
    .all({ limit }) as RecentReentryRow[];
}

/** Completed re-entries per calendar year, newest year first. */
export function reentriesByYear(years = 20): Array<{ year: string; reentries: number }> {
  const { sqlite } = getDb();
  return sqlite
    .prepare(
      `WITH ranked AS (
         SELECT norad_id, decay_epoch,
                ROW_NUMBER() OVER (PARTITION BY norad_id ORDER BY msg_epoch DESC) AS rn
           FROM space_track_decay
          WHERE msg_type = 'Historical'
       )
       SELECT substr(decay_epoch, 1, 4) AS year, COUNT(*) AS reentries
         FROM ranked
        WHERE rn = 1
        GROUP BY year
        ORDER BY year DESC
        LIMIT @years`,
    )
    .all({ years }) as Array<{ year: string; reentries: number }>;
}

// ------------------------------------------------------------- environment

export interface SpaceWeatherRow {
  day: string;
  f107Obs: number | null;
  f107Adj: number | null;
  kpSum: number | null;
  apAvg: number | null;
  cp: number | null;
  sunspot: number | null;
}

export function listSpaceWeather(days = 30): SpaceWeatherRow[] {
  const { sqlite } = getDb();
  return sqlite
    .prepare(
      `SELECT day,
              f107_obs           AS f107Obs,
              f107_adj_ctr81     AS f107Adj,
              kp_sum             AS kpSum,
              ap_avg             AS apAvg,
              cp,
              isn                AS sunspot
         FROM space_weather
        ORDER BY day DESC
        LIMIT @days`,
    )
    .all({ days }) as SpaceWeatherRow[];
}

export interface SpaceWeatherSummary {
  rows: number;
  firstDay: string | null;
  lastDay: string | null;
  /** Days between the first and last observation, minus the rows: must be 0. */
  gaps: number;
  latest: SpaceWeatherRow | null;
}

export function spaceWeatherSummary(): SpaceWeatherSummary {
  const { sqlite } = getDb();
  const span = sqlite
    .prepare(
      `SELECT COUNT(*) AS rows,
              MIN(day) AS firstDay,
              MAX(day) AS lastDay,
              CAST(julianday(MAX(day)) - julianday(MIN(day)) + 1 AS INTEGER) AS days
         FROM space_weather`,
    )
    .get() as { rows: number; firstDay: string | null; lastDay: string | null; days: number };
  const latest = listSpaceWeather(1)[0] ?? null;
  return {
    rows: span.rows,
    firstDay: span.firstDay,
    lastDay: span.lastDay,
    gaps: Math.max(0, span.days - span.rows),
    latest,
  };
}

export interface EopRow {
  mjd: number;
  /** ISO date derived from the MJD — the file stores only days, not instants. */
  day: string;
  xArcsec: number | null;
  yArcsec: number | null;
  ut1MinusUtc: number | null;
  lod: number | null;
}

/** MJD → ISO date. MJD 0 is 1858-11-17; 40587 is 1970-01-01. */
export function mjdToDay(mjd: number): string {
  return new Date((mjd - 40587) * 86_400_000).toISOString().slice(0, 10);
}

export function listEop(days = 30): EopRow[] {
  const { sqlite } = getDb();
  const rows = sqlite
    .prepare(
      `SELECT mjd, x_arcsec AS xArcsec, y_arcsec AS yArcsec,
              ut1_utc_s AS ut1MinusUtc, lod_s AS lod
         FROM earth_orientation
        ORDER BY mjd DESC
        LIMIT @days`,
    )
    .all({ days }) as Array<Omit<EopRow, "day">>;
  return rows.map((r) => ({ ...r, day: mjdToDay(r.mjd) }));
}

export interface EopSummary {
  rows: number;
  firstMjd: number | null;
  lastMjd: number | null;
  gaps: number;
  latest: EopRow | null;
}

export function eopSummary(): EopSummary {
  const { sqlite } = getDb();
  const span = sqlite
    .prepare(
      `SELECT COUNT(*) AS rows, MIN(mjd) AS firstMjd, MAX(mjd) AS lastMjd,
              MAX(mjd) - MIN(mjd) + 1 AS days
         FROM earth_orientation`,
    )
    .get() as { rows: number; firstMjd: number | null; lastMjd: number | null; days: number };
  const latest = listEop(1)[0] ?? null;
  return {
    rows: span.rows,
    firstMjd: span.firstMjd,
    lastMjd: span.lastMjd,
    gaps: Math.max(0, span.days - span.rows),
    latest,
  };
}

// ---------------------------------------------------- launches & break-ups

export interface UpcomingLaunchRow {
  id: string;
  name: string | null;
  /** No Earlier Than — the planned instant, not a promise. */
  netIso: string | null;
  status: string | null;
  vehicle: string | null;
  pad: string | null;
}

export function listUpcomingLaunches(limit = 100): UpcomingLaunchRow[] {
  const { sqlite } = getDb();
  return sqlite
    .prepare(
      `SELECT id, name, net AS netIso, status, vehicle, pad
         FROM keeptrack_upcoming_launch
        ORDER BY net ASC
        LIMIT @limit`,
    )
    .all({ limit }) as UpcomingLaunchRow[];
}

export interface LaunchYearRow {
  year: number;
  launches: number;
  successes: number | null;
  failures: number | null;
}

/** Global launch counts per year, newest first. */
export function launchStatsByYear(limit = 30): LaunchYearRow[] {
  const { sqlite } = getDb();
  return sqlite
    .prepare(
      `SELECT CAST(key1 AS INTEGER) AS year, launches, successes, failures
         FROM keeptrack_launch_stat
        WHERE kind = 'year'
        ORDER BY year DESC
        LIMIT @limit`,
    )
    .all({ limit }) as LaunchYearRow[];
}

export interface LaunchVehicleRow {
  year: number;
  vehicle: string;
  launches: number;
  successes: number | null;
  failures: number | null;
}

/** Launch counts per vehicle-year, busiest first. */
export function launchStatsByVehicle(limit = 20): LaunchVehicleRow[] {
  const { sqlite } = getDb();
  return sqlite
    .prepare(
      `SELECT CAST(key1 AS INTEGER) AS year, key2 AS vehicle, launches, successes, failures
         FROM keeptrack_launch_stat
        WHERE kind = 'vehicle' AND key2 IS NOT NULL
        ORDER BY launches DESC, year DESC
        LIMIT @limit`,
    )
    .all({ limit }) as LaunchVehicleRow[];
}

export interface BoxscoreRow {
  country: string;
  orbitalPayload: number | null;
  orbitalRocketBody: number | null;
  orbitalDebris: number | null;
  orbitalTotal: number | null;
  decayedTotal: number | null;
  countryTotal: number | null;
}

/**
 * Per-country orbital and decayed object counts, as the authority reports them.
 *
 * The `ALL` row is excluded from the list and returned separately: it is a total,
 * not a country, and leaving it in makes any chart of "top owners" start with a
 * bar that means "everyone".
 */
export function listBoxscore(limit = 30): { rows: BoxscoreRow[]; all: BoxscoreRow | null } {
  const { sqlite } = getDb();
  const rows = sqlite
    .prepare(
      `SELECT country,
              orbital_payload      AS orbitalPayload,
              orbital_rocket_body  AS orbitalRocketBody,
              orbital_debris       AS orbitalDebris,
              orbital_total        AS orbitalTotal,
              decayed_total        AS decayedTotal,
              country_total        AS countryTotal
         FROM space_track_boxscore
        WHERE country <> 'ALL'
        ORDER BY orbital_total DESC
        LIMIT @limit`,
    )
    .all({ limit }) as BoxscoreRow[];
  const all =
    (sqlite
      .prepare(
        `SELECT country,
                orbital_payload      AS orbitalPayload,
                orbital_rocket_body  AS orbitalRocketBody,
                orbital_debris       AS orbitalDebris,
                orbital_total        AS orbitalTotal,
                decayed_total        AS decayedTotal,
                country_total        AS countryTotal
           FROM space_track_boxscore
          WHERE country = 'ALL'`,
      )
      .get() as BoxscoreRow | undefined) ?? null;
  return { rows, all };
}

export interface FragmentationRow {
  discosId: string;
  /** Date only: DISCOS gives no instant, so none is invented. */
  epoch: string | null;
  eventType: string | null;
  altitudeKm: number | null;
  latDeg: number | null;
  lonDeg: number | null;
  comment: string | null;
  objectsUrl: string | null;
}

export function listFragmentations(limit = 100): FragmentationRow[] {
  const { sqlite } = getDb();
  return sqlite
    .prepare(
      `SELECT discos_id AS discosId, epoch, event_type AS eventType,
              altitude_km AS altitudeKm, latitude_deg AS latDeg,
              longitude_deg AS lonDeg, comment, objects_url AS objectsUrl
         FROM discos_fragmentation
        ORDER BY epoch DESC
        LIMIT @limit`,
    )
    .all({ limit }) as FragmentationRow[];
}

export interface FragmentationSummary {
  total: number;
  withPosition: number;
  byType: Array<{ eventType: string; events: number }>;
}

export function fragmentationSummary(): FragmentationSummary {
  const { sqlite } = getDb();
  const totals = sqlite
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN altitude_km IS NOT NULL THEN 1 ELSE 0 END) AS withPosition
         FROM discos_fragmentation`,
    )
    .get() as { total: number; withPosition: number | null };
  const byType = sqlite
    .prepare(
      `SELECT event_type AS eventType, COUNT(*) AS events
         FROM discos_fragmentation
        GROUP BY event_type
        ORDER BY events DESC`,
    )
    .all() as Array<{ eventType: string; events: number }>;
  return { total: totals.total, withPosition: totals.withPosition ?? 0, byType };
}
