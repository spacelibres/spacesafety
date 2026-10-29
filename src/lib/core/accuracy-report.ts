import {
  empiricalCdf,
  evaluatePredictions,
  summarise,
  type Axis,
  type TrackPoint,
} from "@/lib/core/accuracy";
import { parseOcm, mergeOcmCovariance } from "@/lib/orbit/ocm";
import { parseOem } from "@/lib/orbit/oem";
import { itrfStateToJ2000 } from "@/lib/orbit/frames-rigorous";

/** Build a time-sorted inertial track from a stored trajectory file. */
export function trackFromFile(text: string, format: string): TrackPoint[] {
  try {
    if (format === "ocm") {
      const ocm = parseOcm(text);
      const earthFixed = /ITRF/i.test(ocm.trajectoryFrame);
      return mergeOcmCovariance(ocm).map((s) => {
        const pv = earthFixed
          ? itrfStateToJ2000(s.position, s.velocity, s.ms)
          : { position: s.position, velocity: s.velocity };
        return {
          ms: s.ms,
          position: pv.position,
          velocity: pv.velocity,
          covariance: s.covariance,
        };
      });
    }
    if (format === "oem") {
      const oem = parseOem(text);
      const earthFixed = /ITRF/i.test(oem.refFrame);
      return oem.states.map((s) => {
        const pv = earthFixed
          ? itrfStateToJ2000(s.position, s.velocity, s.tMs)
          : { position: s.position, velocity: s.velocity };
        return {
          ms: s.tMs,
          position: pv.position,
          velocity: pv.velocity,
          covariance: null,
        };
      });
    }
  } catch {
    return [];
  }
  return [];
}

export interface AccuracyReport {
  axis: Axis;
  horizonHours: number;
  samples: ReturnType<typeof evaluatePredictions>;
  summary: ReturnType<typeof summarise>;
  errorCdf: { x: number; p: number }[];
  mahaCdf: { x: number; p: number }[];
  /** How many uploads were usable as predictions / reference. */
  predictionCount: number;
  /** True when a reference track was available at all. */
  hasReference: boolean;
}

/**
 * Evaluate an object's upload history against its most recent trajectory.
 *
 * The newest upload is treated as truth, matching the vendor's "reference states
 * are overwritten by subsequent uploads" semantics.
 */
export function buildAccuracyReport(
  files: { text: string; format: string; uploadedAt: string }[],
  opts: { axis?: Axis; horizonHours?: number } = {},
): AccuracyReport {
  const axis = opts.axis ?? "R";
  const horizonHours = opts.horizonHours ?? 3;

  const tracks = files
    .map((f) => ({ track: trackFromFile(f.text, f.format), uploadedAt: f.uploadedAt }))
    .filter((t) => t.track.length > 1)
    .sort((a, b) => (a.uploadedAt < b.uploadedAt ? -1 : 1));

  if (tracks.length < 2) {
    return {
      axis,
      horizonHours,
      samples: [],
      summary: summarise([]),
      errorCdf: [],
      mahaCdf: [],
      predictionCount: tracks.length,
      hasReference: tracks.length > 0,
    };
  }

  const reference = tracks[tracks.length - 1].track;
  const predictions = tracks.slice(0, -1).map((t) => t.track);

  const samples = evaluatePredictions(predictions, reference, axis, horizonHours);
  const maha = samples
    .map((s) => s.mahalanobis)
    .filter((m): m is number => m !== null);

  return {
    axis,
    horizonHours,
    samples,
    summary: summarise(samples),
    errorCdf: empiricalCdf(samples.map((s) => s.errorM)),
    mahaCdf: empiricalCdf(maha),
    predictionCount: predictions.length,
    hasReference: true,
  };
}
