/**
 * Import Spacebook's `satcat/details` feed: the physical model and McDowell's
 * launch catalogue.
 *
 * ## Why this feed outranks DISCOS for the collision model
 *
 * Coverage, measured on the 2026-10-29 capture:
 *
 * | field | records |
 * |---|---|
 * | `comspocDerivedMessage` present | **71 074 / 71 088** (99.98%) |
 * | DISCOS objects with a mass | 42 327 / 71 176 (59.5%) |
 * | Space-Track physical data | 0 |
 *
 * The record count alone is not the reason it matters. The hard-body radius is the
 * dominant term in a collision probability, and this feed states it explicitly
 * where every other source offers only an RCS class band:
 *
 * | object | RCS-band estimate | `hbrMeanMeters` | error in radius |
 * |---|---|---|---|
 * | STARLINK-1008 | 5.0 m | 1.139 m | 4.4× too large |
 * | ISS (ZARYA) | 5.0 m | 36.49 m | 14.6× too small |
 *
 * Pc scales with the square of the combined radii, so the 4.4× error is a 19×
 * error in probability. Nothing here can be estimated.
 *
 * ## Structure
 *
 * The feed is one array; each record carries two optional sub-objects:
 *
 *   `discosMsg.comspocDerivedMessage`  physical model (mass, HBR, B*)
 *   `jMcDowellMsg`                     launch and identity metadata
 *
 * They are stored in separate tables because a missing launch date must never be
 * able to affect a collision calculation.
 *
 * ## What is deliberately dropped
 *
 * McDowell's per-field quality flags (`massFlag`, `perigeeFlag`, …) are not stored:
 * they describe how he derived each value, and without his codebook they cannot be
 * interpreted without guessing. The values themselves are kept as stated.
 */

import type Database from "better-sqlite3";

export interface DerivedMessage {
  adoptedMass?: number | null;
  adoptedSpan?: number | null;
  adoptedDiameter?: number | null;
  ballisticCoefficient?: number | null;
  hbrEncap?: number | null;
  hbrHiMeters?: number | null;
  hbrLoMeters?: number | null;
  hbrMeanMeters?: number | null;
  hbrMedianMeters?: number | null;
  solarRadiationPressure?: number | null;
  crossSectionMedian?: number | null;
  shapeNumber?: number | null;
}

export interface McDowellMessage {
  jcat?: string | null;
  launchTag?: string | null;
  piece?: string | null;
  type?: string | null;
  name?: string | null;
  payloadName?: string | null;
  launchDate?: string | null;
  separationDate?: string | null;
  decayDate?: string | null;
  owner?: string | null;
  state?: string | null;
  manufacturer?: string | null;
  bus?: string | null;
  mass?: number | null;
  dryMass?: number | null;
  length?: number | null;
  diameter?: number | null;
  span?: number | null;
  shape?: string | null;
  perigee?: number | null;
  apogee?: number | null;
  inclination?: number | null;
  orbitType?: string | null;
  motor?: string | null;
  altNames?: string | null;
}

export interface DetailRecord {
  id?: string;
  name?: string | null;
  noradId?: number | null;
  intlId?: string | null;
  discosMsg?: { comspocDerivedMessage?: DerivedMessage } | null;
  jMcDowellMsg?: McDowellMessage | null;
}

export interface DetailImportSummary {
  records: number;
  physics: number;
  launchInfo: number;
  withHbr: number;
  withMass: number;
  withBallistic: number;
  skippedNoNorad: number;
  missingDerived: number;
  ms: number;
}

export class SatcatDetailsImporter {
  private readonly sqlite: Database.Database;

  constructor(sqlite: Database.Database) {
    this.sqlite = sqlite;
  }

  import(records: DetailRecord[]): DetailImportSummary {
    const started = Date.now();
    const now = new Date().toISOString();

    const insertPhysics = this.sqlite.prepare(
      `INSERT INTO object_physics
         (norad_id, adopted_mass_kg, adopted_span_m, adopted_diameter_m,
          ballistic_coefficient, hbr_mean_m, hbr_median_m, hbr_lo_m, hbr_hi_m,
          hbr_encap_m, cross_section_median_m2, solar_radiation_pressure,
          shape_number, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(norad_id) DO UPDATE SET
         adopted_mass_kg = excluded.adopted_mass_kg,
         adopted_span_m = excluded.adopted_span_m,
         adopted_diameter_m = excluded.adopted_diameter_m,
         ballistic_coefficient = excluded.ballistic_coefficient,
         hbr_mean_m = excluded.hbr_mean_m,
         hbr_median_m = excluded.hbr_median_m,
         hbr_lo_m = excluded.hbr_lo_m,
         hbr_hi_m = excluded.hbr_hi_m,
         hbr_encap_m = excluded.hbr_encap_m,
         cross_section_median_m2 = excluded.cross_section_median_m2,
         solar_radiation_pressure = excluded.solar_radiation_pressure,
         shape_number = excluded.shape_number,
         updated_at = excluded.updated_at`,
    );

    const insertLaunch = this.sqlite.prepare(
      `INSERT INTO object_launch_info
         (norad_id, jcat, launch_tag, piece, object_type, payload_name, launch_date,
          separation_date, decay_date, owner, state, manufacturer, bus, mass_kg,
          dry_mass_kg, length_m, diameter_m, span_m, shape, perigee_km, apogee_km,
          inclination_deg, orbit_type, motor, alt_names, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(norad_id) DO UPDATE SET
         jcat = excluded.jcat, launch_tag = excluded.launch_tag,
         piece = excluded.piece, object_type = excluded.object_type,
         payload_name = excluded.payload_name, launch_date = excluded.launch_date,
         separation_date = excluded.separation_date, decay_date = excluded.decay_date,
         owner = excluded.owner, state = excluded.state,
         manufacturer = excluded.manufacturer, bus = excluded.bus,
         mass_kg = excluded.mass_kg, dry_mass_kg = excluded.dry_mass_kg,
         length_m = excluded.length_m, diameter_m = excluded.diameter_m,
         span_m = excluded.span_m, shape = excluded.shape,
         perigee_km = excluded.perigee_km, apogee_km = excluded.apogee_km,
         inclination_deg = excluded.inclination_deg,
         orbit_type = excluded.orbit_type, motor = excluded.motor,
         alt_names = excluded.alt_names, updated_at = excluded.updated_at`,
    );

    const summary: DetailImportSummary = {
      records: records.length,
      physics: 0,
      launchInfo: 0,
      withHbr: 0,
      withMass: 0,
      withBallistic: 0,
      skippedNoNorad: 0,
      missingDerived: 0,
      ms: 0,
    };

    const tx = this.sqlite.transaction((rows: DetailRecord[]) => {
      this.sqlite.prepare("DELETE FROM object_physics").run();
      this.sqlite.prepare("DELETE FROM object_launch_info").run();

      for (const record of rows) {
        const noradId = num(record.noradId);
        if (noradId === null || noradId <= 0) {
          summary.skippedNoNorad += 1;
          continue;
        }

        const d = record.discosMsg?.comspocDerivedMessage;
        if (d) {
          const hbr = num(d.hbrMeanMeters);
          const mass = num(d.adoptedMass);
          const bc = num(d.ballisticCoefficient);
          if (hbr !== null) summary.withHbr += 1;
          if (mass !== null) summary.withMass += 1;
          if (bc !== null) summary.withBallistic += 1;

          insertPhysics.run(
            noradId,
            mass,
            num(d.adoptedSpan),
            num(d.adoptedDiameter),
            bc,
            hbr,
            num(d.hbrMedianMeters),
            num(d.hbrLoMeters),
            num(d.hbrHiMeters),
            num(d.hbrEncap),
            num(d.crossSectionMedian),
            num(d.solarRadiationPressure),
            num(d.shapeNumber),
            now,
          );
          summary.physics += 1;
        } else {
          summary.missingDerived += 1;
        }

        const j = record.jMcDowellMsg;
        if (j) {
          insertLaunch.run(
            noradId,
            text(j.jcat),
            text(j.launchTag),
            text(j.piece),
            text(j.type),
            text(j.payloadName),
            text(j.launchDate),
            text(j.separationDate),
            text(j.decayDate),
            text(j.owner),
            text(j.state),
            text(j.manufacturer),
            text(j.bus),
            num(j.mass),
            num(j.dryMass),
            num(j.length),
            num(j.diameter),
            num(j.span),
            text(j.shape),
            num(j.perigee),
            num(j.apogee),
            num(j.inclination),
            text(j.orbitType),
            text(j.motor),
            text(j.altNames),
            now,
          );
          summary.launchInfo += 1;
        }
      }
    });

    tx(records);
    summary.ms = Date.now() - started;
    return summary;
  }
}

/** Hard-body radius by NORAD id, metres, for the collision model. */
export function loadHardBodyRadii(sqlite: Database.Database): Map<number, number> {
  const rows = sqlite
    .prepare(
      "SELECT norad_id AS n, hbr_mean_m AS r FROM object_physics WHERE hbr_mean_m IS NOT NULL",
    )
    .all() as Array<{ n: number; r: number }>;
  return new Map(rows.map((row) => [row.n, row.r]));
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
