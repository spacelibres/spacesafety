/**
 * Ephemeris accuracy metrics.
 *
 * The official object page plots four panels (`docs/UI-SPEC.md`):
 * Prediction Error, its CDF, Mahalanobis distance, and the Mahalanobis CDF
 * against a chi-squared reference. Their methodology note explains the idea:
 *
 *   > When trajectories for a given object are submitted, the platform produces
 *   > "reference states" ... Prior predictions can then be evaluated against
 *   > those reference states.
 *
 * We implement exactly that, plus the covariance-realism test the vendor calls
 * out: a well-tuned covariance should have Mahalanobis distances distributed as
 * chi(k) with k = 1.
 *
 * Everything here is pure: given a track of predictions and a reference track,
 * it returns the samples the charts need.
 */

import { rtnBasis, type Vec3 } from "./linalg";

export interface TrackPoint {
  ms: number;
  position: Vec3;
  velocity: Vec3;
  /** Row-major 6x6 in the inertial frame, or null when absent. */
  covariance: number[] | null;
}

export type Axis = "R" | "T" | "N";

export interface PredictionSample {
  /** Time the prediction was made. */
  madeAtMs: number;
  /** Time the prediction was for. */
  targetMs: number;
  /** Forecast horizon in hours. */
  horizonHours: number;
  axis: Axis;
  /** Signed radial/transverse/normal error, metres (predicted - truth). */
  errorM: number;
  /** Reported 1-sigma along the axis, metres. */
  sigma1M: number | null;
  /** 1-D Mahalanobis distance, dimensionless. */
  mahalanobis: number | null;
}

/** Linear interpolation on a time-sorted track. */
function interpolate(track: TrackPoint[], ms: number): TrackPoint | null {
  if (track.length === 0) return null;
  if (ms < track[0].ms || ms > track[track.length - 1].ms) return null;
  if (track.length === 1) return track[0];

  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].ms <= ms) lo = mid;
    else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  const f = (ms - a.ms) / (b.ms - a.ms || 1);
  const mix = (x: number, y: number) => x + (y - x) * f;

  // Interpolate the covariance too: it drifts slowly, and dropping it here would
  // silently disable the Mahalanobis metric for every off-grid sample.
  const covariance =
    a.covariance && b.covariance && a.covariance.length === 36 && b.covariance.length === 36
      ? a.covariance.map((va, i) => mix(va, b.covariance![i]))
      : (a.covariance ?? b.covariance);

  return {
    ms,
    position: [
      mix(a.position[0], b.position[0]),
      mix(a.position[1], b.position[1]),
      mix(a.position[2], b.position[2]),
    ],
    velocity: [
      mix(a.velocity[0], b.velocity[0]),
      mix(a.velocity[1], b.velocity[1]),
      mix(a.velocity[2], b.velocity[2]),
    ],
    covariance,
  };
}

/** Rotate an inertial vector into RTN of a reference state. */
function toRtn(v: Vec3, refPos: Vec3, refVel: Vec3): Vec3 {
  const m = rtnBasis(refPos, refVel);
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * Project a position-only 6x6 covariance onto one RTN axis.
 *
 * Returns the standard deviation in km, or null when no covariance is available
 * (in which case the error can still be plotted but not its band or Mahalanobis
 * distance).
 */
function axisSigma(cov: number[] | null, refPos: Vec3, refVel: Vec3, axis: Axis): number | null {
  if (!cov || cov.length !== 36) return null;
  const m = rtnBasis(refPos, refVel);
  const rowIdx = axis === "R" ? 0 : axis === "T" ? 1 : 2;
  const row: Vec3 = [m[rowIdx * 3], m[rowIdx * 3 + 1], m[rowIdx * 3 + 2]];
  // var = row^T C pos-pos row
  let varAxis = 0;
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      varAxis += row[i] * cov[i * 6 + j] * row[j];
    }
  }
  return varAxis > 0 ? Math.sqrt(varAxis) : null;
}

/**
 * Compare each prediction against the reference ("truth") track.
 *
 * @param predictions one track per upload, each internally time-sorted
 * @param reference   the track treated as truth
 * @param axis        which RTN dimension to evaluate
 * @param horizonHours how far ahead of the prediction's own start to sample
 */
export function evaluatePredictions(
  predictions: TrackPoint[][],
  reference: TrackPoint[],
  axis: Axis,
  horizonHours: number,
): PredictionSample[] {
  const samples: PredictionSample[] = [];
  const horizonMs = horizonHours * 3_600_000;

  for (const track of predictions) {
    if (track.length < 2) continue;
    const madeAtMs = track[0].ms;
    const targetMs = madeAtMs + horizonMs;

    const pred = interpolate(track, targetMs);
    const truth = interpolate(reference, targetMs);
    if (!pred || !truth) continue;

    const delta = toRtn(
      [
        pred.position[0] - truth.position[0],
        pred.position[1] - truth.position[1],
        pred.position[2] - truth.position[2],
      ],
      truth.position,
      truth.velocity,
    );

    const errorKm = axis === "R" ? delta[0] : axis === "T" ? delta[1] : delta[2];
    const sigmaKm = axisSigma(pred.covariance, truth.position, truth.velocity, axis);

    samples.push({
      madeAtMs,
      targetMs,
      horizonHours,
      axis,
      errorM: errorKm * 1000,
      sigma1M: sigmaKm === null ? null : sigmaKm * 1000,
      mahalanobis: sigmaKm && sigmaKm > 0 ? Math.abs(errorKm) / sigmaKm : null,
    });
  }

  samples.sort((a, b) => a.madeAtMs - b.madeAtMs);
  return samples;
}

/** Empirical CDF of a sample of values. */
export function empiricalCdf(values: number[]): { x: number; p: number }[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.map((v, i) => ({ x: v, p: (i + 1) / sorted.length }));
}

/** Chi-squared CDF with 1 degree of freedom, for the realism overlay. */
export function chi2Cdf1(x: number): number {
  if (x <= 0) return 0;
  return erf(Math.sqrt(x / 2));
}

/** Abramowitz & Stegun 7.1.26 error function, |error| < 1.5e-7. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export interface AccuracySummary {
  count: number;
  /** Mean signed error, metres. Ideal is 0 (unbiased). */
  meanErrorM: number;
  /** 1-sigma of the error distribution, metres. */
  stdErrorM: number;
  /** Root-mean-square error, metres. */
  rmsErrorM: number;
  /** Mean 1-D Mahalanobis distance; ideal is ~0.8 for chi(1). */
  meanMahalanobis: number | null;
  /**
   * Fraction of samples whose |error| exceeded 3 sigma. Should be near 0.003 for
   * realistic covariance; larger means the covariance is too optimistic.
   */
  fractionOutside3Sigma: number | null;
}

/** Summarise a set of prediction samples. */
export function summarise(samples: PredictionSample[]): AccuracySummary {
  if (samples.length === 0) {
    return {
      count: 0,
      meanErrorM: 0,
      stdErrorM: 0,
      rmsErrorM: 0,
      meanMahalanobis: null,
      fractionOutside3Sigma: null,
    };
  }

  const errors = samples.map((s) => s.errorM);
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  const variance = errors.reduce((a, b) => a + (b - mean) ** 2, 0) / errors.length;
  const rms = Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length);

  const maha = samples.map((s) => s.mahalanobis).filter((m): m is number => m !== null);
  const outside = samples.filter(
    (s) => s.sigma1M !== null && Math.abs(s.errorM) > 3 * s.sigma1M,
  ).length;
  const withSigma = samples.filter((s) => s.sigma1M !== null).length;

  return {
    count: samples.length,
    meanErrorM: mean,
    stdErrorM: Math.sqrt(variance),
    rmsErrorM: rms,
    meanMahalanobis: maha.length ? maha.reduce((a, b) => a + b, 0) / maha.length : null,
    fractionOutside3Sigma: withSigma ? outside / withSigma : null,
  };
}
