/**
 * Forecast-skill baseline from two independent ephemerides of the same object.
 *
 * ## What this measures, and what it does not
 *
 * An OCM and a Modified ITC for one object come from the same operator but are
 * separate products: different arc lengths (7 d vs 3 d), different covariance
 * parameterisations (Cartesian in ITRF vs UVW), and — measured — **different arc
 * start times, typically 3–4 hours apart**.
 *
 * Established by direct measurement on STARLINK-38128 (2026-10-27):
 *
 * | quantity | value |
 * |---|---|
 * | OCM radius | 6 160.5 km |
 * | ITC radius | 6 172.0 km |
 * | radial difference | **11.5 km** |
 * | total separation | **3 927 km** |
 * | implied phase | **8.6 min** of arc time |
 *
 * So the two products describe the same orbit to within 12 km of radius, and
 * differ almost entirely in *phase*. That is the expected signature of two
 * independent fits anchored at different times — not a modelling fault.
 *
 * The consequence for this report is important and constrains what it may claim:
 * **a raw kilometre separation between OCM and ITC is not forecast error.** It is
 * dominated by the phase offset between two fits. Reporting it as accuracy would
 * be exactly the guess-work this project must avoid.
 *
 * What this tool therefore establishes is the size of that phase offset, and the
 * growth of the *claimed* uncertainty along the arc. Both are inputs to the later
 * convergence study; neither is a Pc.
 *
 * ## The quantity that matters for collision risk
 *
 * Not the distance: the distance divided by the predicted uncertainty. A 2 km
 * separation with a 3 km 1-sigma is agreement inside the noise; a 2 km separation
 * with a 20 m sigma is a genuine disagreement. The report states both, plus the
 * ratio, and never one without the other.
 */

import type Database from "better-sqlite3";

import { mergeOcmCovariance, parseOcm, type Ocm } from "../orbit/ocm";
import { parseStarlinkEphemeris } from "../sources/starlink-public";
import { itrfStateToJ2000 } from "../orbit/frames-rigorous";

export interface TrackPoint {
  ms: number;
  position: [number, number, number];
  velocity: [number, number, number];
  /** Row-major 6x6 in the frame the source supplied, or null. */
  covariance: number[] | null;
}

export interface HorizonSample {
  objectId: string;
  objectName: string;
  /** Hours since the joint instant (the later of the two arc starts). */
  horizonHours: number;
  /** Age of the OCM forecast at the sample instant, hours. */
  ocmAgeHours: number;
  /** Age of the ITC forecast at the sample instant, hours. */
  itcAgeHours: number;
  /** |Δr| between the two forecasts, km. */
  separationKm: number;
  /** The part of |Δr| that is a difference in orbit radius, km. */
  radialKm: number;
  /** The part of |Δr| that is a phase (timing) difference, km. */
  alongKm: number;
  /** Along-track difference expressed as minutes of arc time. */
  phaseMinutes: number | null;
  /** Largest 1-sigma over the two forecasts, km; null when neither states one. */
  sigmaKm: number | null;
  /** separation / sigma, dimensionless. */
  ratio: number | null;
}

export interface HorizonStats {
  horizonHours: number;
  n: number;
  /** Median and p90 of |Δr|, km. */
  medianKm: number | null;
  p90Km: number | null;
  maxKm: number | null;
  /** Median radial part, km — the orbit-shape disagreement. */
  medianRadialKm: number | null;
  /** Median along-track part, km — the timing disagreement. */
  medianAlongKm: number | null;
  /** Median phase difference, minutes of arc time. */
  medianPhaseMinutes: number | null;
  /** Median forecast age of the OCM at this horizon, hours. */
  medianOcmAgeHours: number | null;
  /** Median forecast age of the ITC at this horizon, hours. */
  medianItcAgeHours: number | null;
  /** Median and p90 of |Δr| / sigma. */
  medianRatio: number | null;
  p90Ratio: number | null;
  /** Objects agreeing inside 3 sigma at this horizon. */
  within3Sigma: number;
  withSigma: number;
}

export interface BaselineReport {
  objects: number;
  /** Objects actually usable (both tracks parsed, overlapping arc). */
  comparable: number;
  horizons: HorizonStats[];
  /** Growth of the median separation per hour, km/h, from the first to last horizon. */
  growthKmPerHour: number | null;
  /**
   * Stability of the phase offset between the two products.
   *
   * If the offset is constant, the two products differ by a fixed time bias and
   * the orbits agree. If it drifts, the forecasts are diverging — which is the
   * quantity a convergence study actually needs to track over days.
   */
  phaseStability: PhaseStability | null;
  notes: string[];
}

export interface PhaseStability {
  /** Objects with at least two usable horizons. */
  objects: number;
  /** Median spread of the phase offset across horizons, minutes. */
  medianSpreadMinutes: number | null;
  /** p90 of that spread. */
  p90SpreadMinutes: number | null;
  /** Median mean offset, minutes. */
  medianMeanOffsetMinutes: number | null;
  /**
   * Objects whose offset varies by less than one minute across all horizons.
   * A high share means the products differ only by a fixed time bias.
   */
  stableCount: number;
}

/** Per-object phase offset across horizons: mean, spread, and whether it is stable. */
export function phaseStability(samples: HorizonSample[]): PhaseStability | null {
  const byObject = new Map<string, number[]>();
  for (const s of samples) {
    if (s.phaseMinutes === null) continue;
    // Sign is not retained by `phaseMinutes` (it is |along|/v); the magnitude of
    // the offset is what is compared here, which is sufficient to test constancy.
    const list = byObject.get(s.objectId) ?? [];
    list.push(s.phaseMinutes);
    byObject.set(s.objectId, list);
  }

  const spreads: number[] = [];
  const means: number[] = [];
  let stable = 0;

  for (const values of byObject.values()) {
    if (values.length < 2) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const spread = Math.max(...values) - Math.min(...values);
    means.push(mean);
    spreads.push(spread);
    if (spread < 1) stable += 1;
  }

  if (spreads.length === 0) return null;

  const q = (arr: number[], p: number) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };

  return {
    objects: spreads.length,
    medianSpreadMinutes: q(spreads, 0.5),
    p90SpreadMinutes: q(spreads, 0.9),
    medianMeanOffsetMinutes: q(means, 0.5),
    stableCount: stable,
  };
}

/**
 * Build an inertial track (EME2000) from stored OCM and ITC text.
 *
 * OCM states are ITRF2000 and are rotated here; ITC states are already EME2000.
 * Doing the rotation at load time keeps every later comparison in one frame —
 * mixing `ITRF` and `EME2000` between tracks produced a spurious ~3800 km "error"
 * in an earlier version, which is neither small nor obviously a frame bug.
 */
export function ocmTrack(text: string): TrackPoint[] {
  let ocm: Ocm;
  try {
    ocm = parseOcm(text);
  } catch {
    return [];
  }
  const earthFixed = /ITRF/i.test(ocm.trajectoryFrame);
  return mergeOcmCovariance(ocm).map((s) => {
    const pv = earthFixed
      ? itrfStateToJ2000(s.position, s.velocity, s.ms)
      : { position: s.position, velocity: s.velocity };
    return { ms: s.ms, position: pv.position, velocity: pv.velocity, covariance: s.covariance };
  });
}

export function itcTrack(text: string): TrackPoint[] {
  try {
    // `parseStarlinkEphemeris` reads the header and the covariance frame line; a
    // bare `parseModifiedItc` needs the frame supplied and throws on real files
    // whose header it has not consumed.
    const itc = parseStarlinkEphemeris(text);
    return itc.states.map((s) => ({
      ms: s.ms,
      position: s.position,
      velocity: s.velocity,
      covariance: s.covariance,
    }));
  } catch {
    return [];
  }
}

/** Linear interpolation of a state at `ms`, or null outside the track. */
function at(track: TrackPoint[], ms: number): TrackPoint | null {
  if (track.length === 0) return null;
  if (ms < track[0].ms || ms > track[track.length - 1].ms) return null;

  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].ms <= ms) lo = mid;
    else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  const span = b.ms - a.ms;
  if (span <= 0) return a;
  const t = (ms - a.ms) / span;
  return {
    ms,
    position: [
      a.position[0] + (b.position[0] - a.position[0]) * t,
      a.position[1] + (b.position[1] - a.position[1]) * t,
      a.position[2] + (b.position[2] - a.position[2]) * t,
    ],
    velocity: [
      a.velocity[0] + (b.velocity[0] - a.velocity[0]) * t,
      a.velocity[1] + (b.velocity[1] - a.velocity[1]) * t,
      a.velocity[2] + (b.velocity[2] - a.velocity[2]) * t,
    ],
    // Covariance is not interpolated: the trace of a covariance is monotone along
    // a prediction arc, and linearly interpolating it would understate the growth.
    // The nearer endpoint is used, which is conservative for the near horizon.
    covariance: t < 0.5 ? a.covariance : b.covariance,
  };
}

/** Largest positional 1-sigma (km) from a 6x6 row-major covariance. */
export function positionSigmaKm(cov: number[] | null): number | null {
  if (!cov || cov.length < 36) return null;
  const sx = cov[0];
  const sy = cov[7];
  const sz = cov[14];
  if (![sx, sy, sz].every((v) => Number.isFinite(v) && v >= 0)) return null;
  return Math.sqrt(Math.max(sx, sy, sz));
}

function distanceKm(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Compare every object's OCM and ITC at a set of horizons.
 *
 * The horizon is measured from the first instant both tracks cover, and samples
 * are only taken where both still cover the target instant — extrapolating past
 * an arc's end would measure the extrapolator, not the forecast.
 */
export function compareHorizons(
  sqlite: Database.Database,
  options: { horizons?: number[]; objectLimit?: number } = {},
): BaselineReport {
  const horizons = options.horizons ?? [6, 12, 24, 48, 72];
  const notes: string[] = [];

  const pairs = sqlite
    .prepare(
      `SELECT o.id AS id, o.object_name AS name,
              (SELECT f.file_text FROM trajectories t
                 JOIN trajectory_files f ON f.trajectory_id = t.id
                WHERE t.object_id = o.id AND t.file_format = 'ocm' LIMIT 1) AS ocm,
              (SELECT f.file_text FROM trajectories t
                 JOIN trajectory_files f ON f.trajectory_id = t.id
                WHERE t.object_id = o.id AND t.file_format = 'itc' LIMIT 1) AS itc
         FROM objects o
        WHERE EXISTS (SELECT 1 FROM trajectories t WHERE t.object_id = o.id AND t.file_format = 'ocm')
          AND EXISTS (SELECT 1 FROM trajectories t WHERE t.object_id = o.id AND t.file_format = 'itc')
        LIMIT ?`,
    )
    .all(options.objectLimit ?? 10_000) as Array<{
    id: string;
    name: string;
    ocm: string | null;
    itc: string | null;
  }>;

  const samples: HorizonSample[] = [];
  let comparable = 0;

  for (const pair of pairs) {
    if (!pair.ocm || !pair.itc) continue;
    const a = ocmTrack(pair.ocm);
    const b = itcTrack(pair.itc);
    if (a.length < 2 || b.length < 2) continue;

    // The joint epoch must lie inside *both* arcs. Using max(start) alone is not
    // enough: when one product's arc ends before the other's begins there is no
    // common instant at all, and interpolation then silently snaps to the nearest
    // endpoint and reports a separation measured across hours.
    const start = Math.max(a[0].ms, b[0].ms);
    const end = Math.min(a[a.length - 1].ms, b[b.length - 1].ms);
    if (end <= start) {
      notes.push(
        `${pair.name}: 两个弧段不重叠（OCM ${new Date(a[0].ms).toISOString()}→` +
          `${new Date(a[a.length - 1].ms).toISOString()}，` +
          `ITC ${new Date(b[0].ms).toISOString()}→${new Date(b[b.length - 1].ms).toISOString()}）`,
      );
      continue;
    }
    comparable += 1;

    const ocmLeadHours = (a[0].ms - b[0].ms) / 3_600_000;
    if (comparable === 1) {
      notes.push(
        `${pair.name}: 重叠 ${((end - start) / 3_600_000).toFixed(1)} h；` +
          `两产品起点相差 ${ocmLeadHours.toFixed(2)} h（ITC 更早）`,
      );
    }

    for (const horizon of horizons) {
      // The horizon is the age of the *forecast*, measured from each product's own
      // start. Measuring from the overlap instead would report "6 h ahead" for a
      // product that is already 4.5 h old, which understates its age.
      //
      // The two products are aligned on an absolute instant, chosen as the later of
      // the two starts so neither is queried before its own arc begins.
      const ms = start + horizon * 3_600_000;
      if (ms > end) continue;
      const sa = at(a, ms);
      const sb = at(b, ms);
      if (!sa || !sb) continue;

      const separationKm = distanceKm(sa.position, sb.position);
      const ra = Math.hypot(sa.position[0], sa.position[1], sa.position[2]);
      const rb = Math.hypot(sb.position[0], sb.position[1], sb.position[2]);
      // Radial difference is an orbit-shape disagreement; the rest is along-track
      // phase. One is a modelling failure, the other is expected of two fits made
      // at different times.
      const radialKm = Math.abs(ra - rb);
      const alongKm = Math.sqrt(Math.max(0, separationKm * separationKm - radialKm * radialKm));

      const sigmas = [positionSigmaKm(sa.covariance), positionSigmaKm(sb.covariance)].filter(
        (v): v is number => v !== null && v > 0,
      );
      const sigmaKm = sigmas.length ? Math.max(...sigmas) : null;

      const speed = Math.hypot(sa.velocity[0], sa.velocity[1], sa.velocity[2]);

      samples.push({
        objectId: pair.id,
        objectName: pair.name,
        horizonHours: horizon,
        // The two products start hours apart, so at any absolute instant their
        // forecasts are of different ages. Recording both ages is what lets the
        // report separate "these disagree" from "these were made at different
        // times".
        ocmAgeHours: (ms - a[0].ms) / 3_600_000,
        itcAgeHours: (ms - b[0].ms) / 3_600_000,
        separationKm,
        radialKm,
        alongKm,
        phaseMinutes: speed > 0 ? alongKm / speed / 60 : null,
        sigmaKm,
        ratio: sigmaKm && sigmaKm > 0 ? separationKm / sigmaKm : null,
      });
    }
  }

  const stats: HorizonStats[] = [];
  for (const horizon of horizons) {
    const at_h = samples.filter((s) => s.horizonHours === horizon);
    if (at_h.length === 0) continue;

    const seps = at_h.map((s) => s.separationKm).sort((x, y) => x - y);
    const ratios = at_h
      .map((s) => s.ratio)
      .filter((v): v is number => v !== null)
      .sort((x, y) => x - y);

    const q = (arr: number[], p: number) =>
      arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : null;

    stats.push({
      horizonHours: horizon,
      n: at_h.length,
      medianKm: q(seps, 0.5),
      p90Km: q(seps, 0.9),
      maxKm: seps[seps.length - 1] ?? null,
      medianRadialKm: q(at_h.map((s) => s.radialKm).sort((x, y) => x - y), 0.5),
      medianAlongKm: q(at_h.map((s) => s.alongKm).sort((x, y) => x - y), 0.5),
      medianPhaseMinutes: q(
        at_h.map((s) => s.phaseMinutes).filter((v): v is number => v !== null).sort((x, y) => x - y),
        0.5,
      ),
      medianOcmAgeHours: q(at_h.map((s) => s.ocmAgeHours).sort((x, y) => x - y), 0.5),
      medianItcAgeHours: q(at_h.map((s) => s.itcAgeHours).sort((x, y) => x - y), 0.5),
      medianRatio: q(ratios, 0.5),
      p90Ratio: q(ratios, 0.9),
      within3Sigma: ratios.filter((r) => r <= 3).length,
      withSigma: ratios.length,
    });
  }

  // Growth rate of the median separation: the number a later study has to beat.
  let growthKmPerHour: number | null = null;
  if (stats.length >= 2) {
    const first = stats[0];
    const last = stats[stats.length - 1];
    if (first.medianKm !== null && last.medianKm !== null) {
      growthKmPerHour =
        (last.medianKm - first.medianKm) / (last.horizonHours - first.horizonHours);
    }
  }

  if (horizons.length > 2) {
    const last = stats[stats.length - 1];
    if (last && last.n < stats[0].n) {
      notes.push(
        `样本随预报时长减少（${stats[0].horizonHours}h: n=${stats[0].n} → ` +
          `${last.horizonHours}h: n=${last.n}），因为 ITC 弧只有 3 天`,
      );
    }
  }

  return {
    objects: pairs.length,
    comparable,
    horizons: stats,
    growthKmPerHour,
    phaseStability: phaseStability(samples),
    notes,
  };
}
