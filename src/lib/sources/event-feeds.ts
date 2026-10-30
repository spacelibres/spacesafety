/**
 * The archived event feeds that are *about* catalogue objects rather than being
 * catalogue objects themselves.
 *
 * ## Why these are separate from the catalogue import
 *
 * The wide catalogue answers "what is this object". These answer "what happened to
 * it" and "what did someone predict will happen to it". Keeping them in their own
 * tables means a re-run of the catalogue build cannot drop them, and an event feed
 * that arrives late (CDM today, fragmentation tomorrow) does not require rebuilding
 * 71,200 rows to be visible.
 *
 * ## Why they are loaded from the archive
 *
 * Same reason as `discos-import.ts`: the download and the import are separate steps
 * so a parser fix can be re-run against a fixed capture. Every loader here takes
 * the path to one dated archive file, never a live API, and is idempotent — the
 * source's own primary key is the table's primary key, so re-running over the same
 * capture is a no-op rather than a duplicate.
 *
 * ## What each one is, measured rather than assumed
 *
 * The row counts and value distributions below were measured on the 2026-10-29
 * capture; the prose in `docs/DATA-SOURCES.md` had several of them wrong.
 *
 *   CDM         3,161 rows, 2,897 with a real Pc (not "no probability"), all
 *               flagged EMERGENCY_REPORTABLE. This is the official conjunction
 *               warning — the business the space-safety service exists to do.
 *   TIP        26,184 rows of predicted re-entry, back to 2012. KeepTrack had 14.
 *   decay     143,546 rows — the full historical re-entry record, not a summary.
 *   frag         673 fragmentation events, of which only 147 carry a position.
 *   boxscore     122 rows, per-country orbital/decayed counts.
 *   site          45 rows, launch-site code → name.
 *   eop/spaceweather
 *                23,858 and 25,875 daily rows; needed by any propagation that
 *               wants to reproduce another tool's answer, unused by the catalogue.
 */

import type Database from "better-sqlite3";

// ------------------------------------------------------------------ utilities

/**
 * Space-Track emits `2026-09-29 12:21:34.000000` and `2026-10-01T22:31:11.609000`.
 * Both are UTC; nothing in the feed carries an offset, so the string is stored as
 * ISO with a `Z` rather than parsed into a `Date` that would then be re-rendered in
 * the host's zone.
 */
export function isoUtc(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const t = s.replace(" ", "T");
  const withMs = /\.\d+$/.test(t) ? t : `${t}.000`;
  return `${withMs}Z`;
}

/** Feed values arrive as strings, including `"null"` and `""`. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s || s === "null") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function int(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.trunc(n);
}

export function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s && s !== "null" ? s : null;
}

// ---------------------------------------------------------- shared base class

/**
 * One loader per feed. `run()` returns the number of rows written, which is what
 * the sync driver prints; anything that would make a row unjoinable to the
 * catalogue is stored as given rather than dropped, because knowing that
 * `COSMOS 2251` broke up is useful even before we can say which 2,000 pieces came
 * from it.
 */
export abstract class EventFeedLoader {
  constructor(protected readonly db: Database.Database) {}

  abstract readonly table: string;
  abstract run(rows: unknown[]): number;

  protected count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.table}`).get() as { n: number }).n;
  }
}

// --------------------------------------------------------------- public CDMs

interface CdmRow {
  CDM_ID?: string;
  CREATED?: string;
  EMERGENCY_REPORTABLE?: string;
  TCA?: string;
  MIN_RNG?: string;
  PC?: string | null;
  SAT_1_ID?: string;
  SAT_1_NAME?: string;
  SAT1_OBJECT_TYPE?: string;
  SAT1_RCS?: string;
  SAT_1_EXCL_VOL?: string;
  SAT_2_ID?: string;
  SAT_2_NAME?: string;
  SAT2_OBJECT_TYPE?: string;
  SAT2_RCS?: string;
  SAT_2_EXCL_VOL?: string;
}

/**
 * Public CDMs from Space-Track (`/cdm_public`).
 *
 * ## What is and is not here
 *
 * A public CDM is the screening centre's own message, not the operators'. It says
 * two catalogue objects will pass within `MIN_RNG` at `TCA`, with a probability
 * computed from the public elements. It carries no covariance and no manoeuvre
 * plan, so it cannot be fed to our conjunction pipeline as if it were one of our
 * own CDMs — it is kept as evidence, in its own table, alongside them.
 *
 * `PC` is null on 264 of 3,161 rows. Those are stored as null, not as zero: a
 * missing probability is not a zero probability, and treating it as zero would sort
 * a potentially real threat below every measured one.
 */
export class PublicCdmLoader extends EventFeedLoader {
  readonly table = "space_track_cdm_public";

  private static readonly SCHEMA = `
    CREATE TABLE IF NOT EXISTS space_track_cdm_public (
      cdm_id            TEXT PRIMARY KEY,
      created           TEXT,
      tca               TEXT NOT NULL,
      min_range_km      REAL,
      pc                REAL,
      emergency         INTEGER NOT NULL DEFAULT 0,
      sat1_norad        INTEGER,
      sat1_name         TEXT,
      sat1_object_type  TEXT,
      sat1_rcs          TEXT,
      sat1_excl_vol_km  REAL,
      sat2_norad        INTEGER,
      sat2_name         TEXT,
      sat2_object_type  TEXT,
      sat2_rcs          TEXT,
      sat2_excl_vol_km  REAL
    );
    CREATE INDEX IF NOT EXISTS stcdm_tca_idx  ON space_track_cdm_public(tca);
    CREATE INDEX IF NOT EXISTS stcdm_pc_idx   ON space_track_cdm_public(pc);
    CREATE INDEX IF NOT EXISTS stcdm_sat1_idx ON space_track_cdm_public(sat1_norad);
    CREATE INDEX IF NOT EXISTS stcdm_sat2_idx ON space_track_cdm_public(sat2_norad);
  `;

  run(rows: unknown[]): number {
    this.db.exec(PublicCdmLoader.SCHEMA);
    const stmt = this.db.prepare(`
      INSERT INTO space_track_cdm_public (
        cdm_id, created, tca, min_range_km, pc, emergency,
        sat1_norad, sat1_name, sat1_object_type, sat1_rcs, sat1_excl_vol_km,
        sat2_norad, sat2_name, sat2_object_type, sat2_rcs, sat2_excl_vol_km
      ) VALUES (
        @cdm_id, @created, @tca, @min_range_km, @pc, @emergency,
        @sat1_norad, @sat1_name, @sat1_object_type, @sat1_rcs, @sat1_excl_vol_km,
        @sat2_norad, @sat2_name, @sat2_object_type, @sat2_rcs, @sat2_excl_vol_km
      )
      ON CONFLICT(cdm_id) DO UPDATE SET
        created = excluded.created, tca = excluded.tca,
        min_range_km = excluded.min_range_km, pc = excluded.pc,
        emergency = excluded.emergency,
        sat1_name = excluded.sat1_name, sat2_name = excluded.sat2_name
    `);

    let n = 0;
    const write = this.db.transaction((all: CdmRow[]) => {
      for (const r of all) {
        const id = text(r.CDM_ID);
        const tca = isoUtc(r.TCA);
        // The TCA is the key fact; a row without it cannot be placed in time.
        if (!id || !tca) continue;
        stmt.run({
          cdm_id: id,
          created: isoUtc(r.CREATED),
          tca,
          min_range_km: num(r.MIN_RNG),
          pc: num(r.PC),
          emergency: r.EMERGENCY_REPORTABLE === "Y" ? 1 : 0,
          sat1_norad: int(r.SAT_1_ID),
          sat1_name: text(r.SAT_1_NAME),
          sat1_object_type: text(r.SAT1_OBJECT_TYPE),
          sat1_rcs: text(r.SAT1_RCS),
          sat1_excl_vol_km: num(r.SAT_1_EXCL_VOL),
          sat2_norad: int(r.SAT_2_ID),
          sat2_name: text(r.SAT_2_NAME),
          sat2_object_type: text(r.SAT2_OBJECT_TYPE),
          sat2_rcs: text(r.SAT2_RCS),
          sat2_excl_vol_km: num(r.SAT_2_EXCL_VOL),
        });
        n++;
      }
    });
    write(rows as CdmRow[]);
    return n;
  }
}

// ------------------------------------------------------------ TIP re-entries

interface TipRow {
  NORAD_CAT_ID?: string;
  MSG_EPOCH?: string;
  DECAY_EPOCH?: string;
  WINDOW?: string;
  REV?: string;
  DIRECTION?: string;
  LAT?: string;
  LON?: string;
  INCL?: string;
  HIGH_INTEREST?: string;
}

/**
 * TIP messages: the official prediction of when and where an object comes down.
 *
 * ## Why the primary key is (NORAD, DECAY_EPOCH, MSG_EPOCH)
 *
 * The same object gets a new TIP every few hours as the prediction narrows, and
 * the history of those predictions is the signal — a window that keeps widening is
 * an object that is tumbling. So this is an append-only log, not a
 * one-row-per-object table, and the key is the prediction plus when it was made.
 *
 * `WINDOW` is minutes of uncertainty, not a time span around the epoch.
 */
export class TipLoader extends EventFeedLoader {
  readonly table = "space_track_tip";

  private static readonly SCHEMA = `
    CREATE TABLE IF NOT EXISTS space_track_tip (
      norad_id       INTEGER NOT NULL,
      msg_epoch      TEXT NOT NULL,
      decay_epoch    TEXT NOT NULL,
      window_min     REAL,
      rev            INTEGER,
      direction      TEXT,
      lat_deg        REAL,
      lon_deg        REAL,
      incl_deg       REAL,
      high_interest  INTEGER NOT NULL DEFAULT 0,
      tip_id         TEXT,
      PRIMARY KEY (norad_id, msg_epoch, decay_epoch)
    );
    CREATE INDEX IF NOT EXISTS sttip_decay_idx ON space_track_tip(decay_epoch);
    CREATE INDEX IF NOT EXISTS sttip_msg_idx   ON space_track_tip(msg_epoch);
  `;

  run(rows: unknown[]): number {
    this.db.exec(TipLoader.SCHEMA);
    const stmt = this.db.prepare(`
      INSERT INTO space_track_tip (
        norad_id, msg_epoch, decay_epoch, window_min, rev, direction,
        lat_deg, lon_deg, incl_deg, high_interest, tip_id
      ) VALUES (
        @norad_id, @msg_epoch, @decay_epoch, @window_min, @rev, @direction,
        @lat_deg, @lon_deg, @incl_deg, @high_interest, @tip_id
      )
      ON CONFLICT(norad_id, msg_epoch, decay_epoch) DO UPDATE SET
        window_min = excluded.window_min, lat_deg = excluded.lat_deg,
        lon_deg = excluded.lon_deg
    `);

    let n = 0;
    const write = this.db.transaction((all: TipRow[]) => {
      for (const r of all) {
        const norad = int(r.NORAD_CAT_ID);
        const msg = isoUtc(r.MSG_EPOCH);
        const decay = isoUtc(r.DECAY_EPOCH);
        if (norad === null || !msg || !decay) continue;
        stmt.run({
          norad_id: norad,
          msg_epoch: msg,
          decay_epoch: decay,
          window_min: num(r.WINDOW),
          rev: int(r.REV),
          direction: text(r.DIRECTION),
          lat_deg: num(r.LAT),
          lon_deg: num(r.LON),
          incl_deg: num(r.INCL),
          high_interest: r.HIGH_INTEREST === "Y" ? 1 : 0,
          tip_id: text((r as { ID?: string }).ID),
        });
        n++;
      }
    });
    write(rows as TipRow[]);
    return n;
  }
}

// ---------------------------------------------------------- decay history

interface DecayRow {
  NORAD_CAT_ID?: string;
  OBJECT_NAME?: string;
  INTLDES?: string;
  DECAY_EPOCH?: string;
  MSG_EPOCH?: string;
  RCS_SIZE?: string;
  COUNTRY?: string;
  SOURCE?: string;
  MSG_TYPE?: string;
}

/**
 * Every re-entry Space-Track has on record — 143,546 rows going back to 1957.
 *
 * This is the authority for "is it still up there". The wide catalogue's
 * `decay_date` is whatever the four catalogues said, and they disagree; this table
 * says when the 18th Space Defense Squadron stopped tracking the object, which is
 * the only definition that does not depend on who is guessing.
 *
 * Several objects have more than one row (`MSG_TYPE` differs, and the epoch is
 * sometimes revisable). The key includes the message epoch so the revision history
 * survives, and readers should take the latest `msg_epoch` per object.
 */
export class DecayLoader extends EventFeedLoader {
  readonly table = "space_track_decay";

  private static readonly SCHEMA = `
    CREATE TABLE IF NOT EXISTS space_track_decay (
      norad_id     INTEGER NOT NULL,
      msg_epoch    TEXT NOT NULL,
      decay_epoch  TEXT NOT NULL,
      name         TEXT,
      intldes      TEXT,
      country      TEXT,
      rcs_size     TEXT,
      source       TEXT,
      msg_type     TEXT,
      PRIMARY KEY (norad_id, msg_epoch)
    );
    CREATE INDEX IF NOT EXISTS stdecay_epoch_idx ON space_track_decay(decay_epoch);
    CREATE INDEX IF NOT EXISTS stdecay_intl_idx  ON space_track_decay(intldes);
  `;

  run(rows: unknown[]): number {
    this.db.exec(DecayLoader.SCHEMA);
    const stmt = this.db.prepare(`
      INSERT INTO space_track_decay (
        norad_id, msg_epoch, decay_epoch, name, intldes, country,
        rcs_size, source, msg_type
      ) VALUES (
        @norad_id, @msg_epoch, @decay_epoch, @name, @intldes, @country,
        @rcs_size, @source, @msg_type
      )
      ON CONFLICT(norad_id, msg_epoch) DO UPDATE SET
        decay_epoch = excluded.decay_epoch, name = excluded.name
    `);

    let n = 0;
    const write = this.db.transaction((all: DecayRow[]) => {
      for (const r of all) {
        const norad = int(r.NORAD_CAT_ID);
        const msg = isoUtc(r.MSG_EPOCH);
        const decay = isoUtc(r.DECAY_EPOCH);
        if (norad === null || !msg || !decay) continue;
        stmt.run({
          norad_id: norad,
          msg_epoch: msg,
          decay_epoch: decay,
          name: text(r.OBJECT_NAME),
          intldes: text(r.INTLDES),
          country: text(r.COUNTRY),
          rcs_size: text(r.RCS_SIZE),
          source: text(r.SOURCE),
          msg_type: text(r.MSG_TYPE),
        });
        n++;
      }
    });
    write(rows as DecayRow[]);
    return n;
  }
}

// ------------------------------------------------------- fragmentation events

interface DiscosFragmentation {
  id?: string;
  type?: string;
  attributes?: {
    epoch?: string | null;
    comment?: string | null;
    latitude?: number | string | null;
    longitude?: number | string | null;
    altitude?: number | string | null;
    eventType?: string | null;
  };
  relationships?: {
    objects?: { links?: { related?: string } };
  };
}

/**
 * Break-up events, from ESA DISCOSweb.
 *
 * ## Why this matters more than the debris objects themselves
 *
 * A debris object's catalogue entry says almost nothing — no mass, no size, often
 * no launch. What makes it interpretable is which break-up produced it: the 2009
 * Iridium/Cosmos collision accounts for roughly 2,000 tracked pieces, and knowing
 * that is the difference between "unknown debris" and "debris from the first
 * accidental collision between two intact spacecraft".
 *
 * ## What is missing
 *
 * Only 147 of 673 events carry a latitude/longitude/altitude. The rest record
 * *that* a break-up happened and nothing about where. Stored as null, not zero.
 *
 * The link from event to the objects it produced is a relationship URL, so the
 * event rows here are on their own; populating `fragmentation_member` requires a
 * second pass that follows `/api/fragmentations/{id}/objects`.
 */
export class FragmentationLoader extends EventFeedLoader {
  readonly table = "discos_fragmentation";

  private static readonly SCHEMA = `
    CREATE TABLE IF NOT EXISTS discos_fragmentation (
      discos_id        TEXT PRIMARY KEY,
      epoch            TEXT,
      event_type       TEXT,
      latitude_deg     REAL,
      longitude_deg    REAL,
      altitude_km      REAL,
      comment          TEXT,
      objects_url      TEXT,
      member_count     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS dsfrag_epoch_idx ON discos_fragmentation(epoch);
    CREATE INDEX IF NOT EXISTS dsfrag_type_idx  ON discos_fragmentation(event_type);
  `;

  run(rows: unknown[]): number {
    this.db.exec(FragmentationLoader.SCHEMA);
    const stmt = this.db.prepare(`
      INSERT INTO discos_fragmentation (
        discos_id, epoch, event_type, latitude_deg, longitude_deg,
        altitude_km, comment, objects_url
      ) VALUES (
        @discos_id, @epoch, @event_type, @latitude_deg, @longitude_deg,
        @altitude_km, @comment, @objects_url
      )
      ON CONFLICT(discos_id) DO UPDATE SET
        epoch = excluded.epoch, event_type = excluded.event_type,
        latitude_deg = excluded.latitude_deg,
        longitude_deg = excluded.longitude_deg,
        altitude_km = excluded.altitude_km
    `);

    let n = 0;
    const write = this.db.transaction((all: DiscosFragmentation[]) => {
      for (const r of all) {
        const a = r.attributes ?? {};
        const id = text(r.id);
        if (!id) continue;
        stmt.run({
          discos_id: id,
          // DISCOS gives a date, not an instant: `1979-12-15`. Kept date-only.
          epoch: text(a.epoch),
          event_type: text(a.eventType),
          latitude_deg: num(a.latitude),
          longitude_deg: num(a.longitude),
          altitude_km: num(a.altitude),
          comment: text(a.comment),
          objects_url: r.relationships?.objects?.links?.related ?? null,
        });
        n++;
      }
    });
    write(rows as DiscosFragmentation[]);
    return n;
  }
}

// --------------------------------------------------------------- box score

interface BoxScoreRow {
  COUNTRY?: string;
  SPADOC_CD?: string;
  ORBITAL_TBA?: string;
  ORBITAL_PAYLOAD_COUNT?: string;
  ORBITAL_ROCKET_BODY_COUNT?: string;
  ORBITAL_DEBRIS_COUNT?: string;
  ORBITAL_TOTAL_COUNT?: string;
  DECAYED_PAYLOAD_COUNT?: string;
  DECAYED_ROCKET_BODY_COUNT?: string;
  DECAYED_DEBRIS_COUNT?: string;
  DECAYED_TOTAL_COUNT?: string;
  COUNTRY_TOTAL?: string;
}

/**
 * Objects in orbit and objects decayed, per owning country.
 *
 * The catalogue can compute the same totals, and they will not match these exactly —
 * the box score is as-of the file's generation and counts a few objects the
 * catalogue file has not yet received. Kept as a separate statement of the
 * authority's own view so a discrepancy is visible rather than silently averaged.
 */
export class BoxScoreLoader extends EventFeedLoader {
  readonly table = "space_track_boxscore";

  private static readonly SCHEMA = `
    CREATE TABLE IF NOT EXISTS space_track_boxscore (
      country             TEXT PRIMARY KEY,
      spadoc_cd           TEXT,
      orbital_payload     INTEGER NOT NULL DEFAULT 0,
      orbital_rocket_body INTEGER NOT NULL DEFAULT 0,
      orbital_debris      INTEGER NOT NULL DEFAULT 0,
      orbital_total       INTEGER NOT NULL DEFAULT 0,
      decayed_payload     INTEGER NOT NULL DEFAULT 0,
      decayed_rocket_body INTEGER NOT NULL DEFAULT 0,
      decayed_debris      INTEGER NOT NULL DEFAULT 0,
      decayed_total       INTEGER NOT NULL DEFAULT 0,
      country_total       INTEGER NOT NULL DEFAULT 0
    );
  `;

  run(rows: unknown[]): number {
    this.db.exec(BoxScoreLoader.SCHEMA);
    const stmt = this.db.prepare(`
      INSERT INTO space_track_boxscore VALUES (
        @country, @spadoc_cd, @orbital_payload, @orbital_rocket_body,
        @orbital_debris, @orbital_total, @decayed_payload,
        @decayed_rocket_body, @decayed_debris, @decayed_total, @country_total
      )
      ON CONFLICT(country) DO UPDATE SET
        orbital_total = excluded.orbital_total,
        decayed_total = excluded.decayed_total,
        country_total = excluded.country_total
    `);

    let n = 0;
    const write = this.db.transaction((all: BoxScoreRow[]) => {
      for (const r of all) {
        const country = text(r.COUNTRY);
        if (!country) continue;
        stmt.run({
          country,
          spadoc_cd: text(r.SPADOC_CD),
          orbital_payload: int(r.ORBITAL_PAYLOAD_COUNT) ?? 0,
          orbital_rocket_body: int(r.ORBITAL_ROCKET_BODY_COUNT) ?? 0,
          orbital_debris: int(r.ORBITAL_DEBRIS_COUNT) ?? 0,
          orbital_total: int(r.ORBITAL_TOTAL_COUNT) ?? 0,
          decayed_payload: int(r.DECAYED_PAYLOAD_COUNT) ?? 0,
          decayed_rocket_body: int(r.DECAYED_ROCKET_BODY_COUNT) ?? 0,
          decayed_debris: int(r.DECAYED_DEBRIS_COUNT) ?? 0,
          decayed_total: int(r.DECAYED_TOTAL_COUNT) ?? 0,
          country_total: int(r.COUNTRY_TOTAL) ?? 0,
        });
        n++;
      }
    });
    write(rows as BoxScoreRow[]);
    return n;
  }
}

// ------------------------------------------------------------ launch sites

/**
 * Launch-site codes to names.
 *
 * The catalogue's `launch_site` is the bare code — `AFETR`, `TTMTR`, `PLMSC` — and
 * a user cannot read it. This is the only mapping in any of the four sources.
 */
export class LaunchSiteLoader extends EventFeedLoader {
  readonly table = "launch_site";

  private static readonly SCHEMA = `
    CREATE TABLE IF NOT EXISTS launch_site (
      site_code TEXT PRIMARY KEY,
      name      TEXT NOT NULL
    );
  `;

  run(rows: unknown[]): number {
    this.db.exec(LaunchSiteLoader.SCHEMA);
    const stmt = this.db.prepare(
      `INSERT INTO launch_site (site_code, name) VALUES (?, ?)
       ON CONFLICT(site_code) DO UPDATE SET name = excluded.name`,
    );
    let n = 0;
    const write = this.db.transaction((all: Array<{ SITE_CODE?: string; LAUNCH_SITE?: string }>) => {
      for (const r of all) {
        const code = text(r.SITE_CODE);
        const name = text(r.LAUNCH_SITE);
        if (!code || !name) continue;
        stmt.run(code, name);
        n++;
      }
    });
    write(rows as Array<{ SITE_CODE?: string; LAUNCH_SITE?: string }>);
    return n;
  }
}

// ------------------------------------------------------- eop / space weather

/**
 * A fixed-column whitespace table from ComSpoc's CelesTrak-format files.
 *
 * The headers in those files name the columns in a comment block rather than in
 * the data, so the column list is passed in by the caller and asserted against the
 * file's declared count: a format change becomes a loud failure instead of rows
 * silently shifting one column left.
 */
export interface FixedColumn {
  name: string;
  type: "int" | "real";
}

export function parseFixedColumns(
  content: string,
  columns: FixedColumn[],
  beginMarker: string,
): Array<Record<string, number | null>> {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === beginMarker);
  if (start === -1) throw new Error(`缺少 ${beginMarker} 段落`);

  const out: Array<Record<string, number | null>> = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith("END")) break;
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length !== columns.length) {
      throw new Error(`第 ${i + 1} 行有 ${parts.length} 列，期望 ${columns.length}`);
    }
    const row: Record<string, number | null> = {};
    columns.forEach((c, j) => {
      const v = Number(parts[j]);
      row[c.name] = Number.isFinite(v) ? (c.type === "int" ? Math.trunc(v) : v) : null;
    });
    out.push(row);
  }
  return out;
}

/**
 * A loader whose input is the whole file as text (fixed-column format), rather
 * than an array of records.
 */
export abstract class TextFeedLoader {
  constructor(protected readonly db: Database.Database) {}

  abstract readonly table: string;
  abstract run(content: string): number;
}

/** Earth orientation parameters: needed to turn a fixed frame into an Earth-fixed one. */
export class EopLoader extends TextFeedLoader {
  readonly table = "earth_orientation";

  static readonly COLUMNS: FixedColumn[] = [
    { name: "year", type: "int" },
    { name: "month", type: "int" },
    { name: "day", type: "int" },
    { name: "mjd", type: "int" },
    { name: "x_arcsec", type: "real" },
    { name: "y_arcsec", type: "real" },
    { name: "ut1_utc_s", type: "real" },
    { name: "lod_s", type: "real" },
    { name: "dpsi_arcsec", type: "real" },
    { name: "deps_arcsec", type: "real" },
    { name: "dx_arcsec", type: "real" },
    { name: "dy_arcsec", type: "real" },
    { name: "dat_s", type: "int" },
  ];

  private static readonly SCHEMA = `
    CREATE TABLE IF NOT EXISTS earth_orientation (
      mjd        INTEGER PRIMARY KEY,
      x_arcsec   REAL, y_arcsec   REAL,
      ut1_utc_s  REAL, lod_s      REAL,
      dpsi_arcsec REAL, deps_arcsec REAL,
      dx_arcsec  REAL, dy_arcsec  REAL,
      dat_s      INTEGER
    );
  `;

  run(content: string): number {
    this.db.exec(EopLoader.SCHEMA);
    const rows = parseFixedColumns(content, EopLoader.COLUMNS, "BEGIN OBSERVED");
    const stmt = this.db.prepare(`
      INSERT INTO earth_orientation VALUES (
        @mjd, @x_arcsec, @y_arcsec, @ut1_utc_s, @lod_s,
        @dpsi_arcsec, @deps_arcsec, @dx_arcsec, @dy_arcsec, @dat_s
      ) ON CONFLICT(mjd) DO UPDATE SET
        ut1_utc_s = excluded.ut1_utc_s, lod_s = excluded.lod_s
    `);
    this.db.transaction((all: typeof rows) => {
      for (const r of all) if (r.mjd !== null) stmt.run(r);
    })(rows);
    return rows.length;
  }
}

/** Daily space-weather indices: F10.7 and Kp drive thermospheric density. */
export class SpaceWeatherLoader extends TextFeedLoader {
  readonly table = "space_weather";

  /**
   * 33 data columns, counted from the file rather than from the header comment —
   * the header block wraps and is easy to miscount by two. The eight 3-hourly Kp
   * values are columns 6–13; only the daily sum and Ap mean are used downstream,
   * but all are parsed so a consumer can be added without re-reading the file.
   */
  static readonly COLUMNS: FixedColumn[] = [
    { name: "year", type: "int" },
    { name: "month", type: "int" },
    { name: "day", type: "int" },
    { name: "bsrn", type: "int" },
    { name: "nd", type: "int" },
    ...Array.from({ length: 8 }, (_, i) => ({ name: `kp${i + 1}`, type: "int" as const })),
    { name: "kp_sum", type: "int" },
    ...Array.from({ length: 8 }, (_, i) => ({ name: `ap${i + 1}`, type: "int" as const })),
    { name: "ap_avg", type: "int" },
    { name: "cp", type: "real" },
    { name: "c9", type: "int" },
    { name: "isn", type: "int" },
    { name: "f107_obs", type: "real" },
    { name: "q", type: "int" },
    { name: "ctr81", type: "real" },
    { name: "lst81", type: "real" },
    { name: "f107_ctr81", type: "real" },
    { name: "f107_adj_ctr81", type: "real" },
    { name: "f107_lst81", type: "real" },
  ];

  private static readonly SCHEMA = `
    CREATE TABLE IF NOT EXISTS space_weather (
      day         TEXT PRIMARY KEY,
      bsrn        INTEGER, nd          INTEGER,
      kp_sum      INTEGER, ap_avg      INTEGER,
      cp          REAL,    c9          INTEGER,
      isn         INTEGER, f107_obs    REAL,
      f107_ctr81  REAL,    f107_adj_ctr81 REAL,
      kp_json     TEXT
    );
  `;

  run(content: string): number {
    this.db.exec(SpaceWeatherLoader.SCHEMA);
    const rows = parseFixedColumns(content, SpaceWeatherLoader.COLUMNS, "BEGIN OBSERVED");
    const stmt = this.db.prepare(`
      INSERT INTO space_weather VALUES (
        @day, @bsrn, @nd, @kp_sum, @ap_avg, @cp, @c9, @isn, @f107_obs,
        @f107_ctr81, @f107_adj_ctr81, @kp_json
      ) ON CONFLICT(day) DO UPDATE SET
        f107_obs = excluded.f107_obs, kp_sum = excluded.kp_sum
    `);
    this.db.transaction((all: typeof rows) => {
      for (const r of all) {
        if (r.year === null || r.month === null || r.day === null) continue;
        const day = `${r.year}-${String(r.month).padStart(2, "0")}-${String(r.day).padStart(2, "0")}`;
        const kp = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => r[`kp${i}`]);
        stmt.run({
          day,
          bsrn: r.bsrn, nd: r.nd, kp_sum: r.kp_sum, ap_avg: r.ap_avg,
          cp: r.cp, c9: r.c9, isn: r.isn, f107_obs: r.f107_obs,
          f107_ctr81: r.f107_ctr81, f107_adj_ctr81: r.f107_adj_ctr81,
          kp_json: JSON.stringify(kp),
        });
      }
    })(rows);
    return rows.length;
  }
}
