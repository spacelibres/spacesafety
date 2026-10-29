/**
 * Cross-source comparison: do two providers actually agree about an object?
 *
 * ## The problem this solves
 *
 * Element-set fields are a poor comparison basis. Space-Track's and Spacebook's
 * entry for the ISS have different epochs (2 days apart) and therefore different
 * RAAN, mean motion and mean anomaly — a naive field diff reports a 15° RAAN
 * "disagreement" that is nothing but two snapshots of a precessing orbit taken at
 * different times. That looks alarming and means nothing.
 *
 * The honest test is positional: propagate both element sets to **one common
 * instant** and measure |Δr|. A 2-day-old element set propagated forward is
 * expected to be a few km to a few tens of km off; a *wrong* object is off by
 * hundreds or thousands.
 *
 * ## Interpretation bands
 *
 * Separation is meaningless without the epoch gap, because a 3-day-old element set
 * drifts thousands of kilometres. Measured on this catalogue (2026-10-29,
 * Spacebook OMM vs XP-TLE):
 *
 * | object | epoch gap | separation | per day |
 * |---|---|---|---|
 * | ISS | 54 h | 276 km | ~120 km/d |
 * | STARLINK-1008 | 77 h | 4 337 km | ~1 350 km/d |
 * | VANGUARD 1 | 17 h | 246 km | ~350 km/d |
 *
 * A fixed kilometre threshold therefore classifies a correctly-aged STARLINK
 * element set as "suspect". The bands are applied to **drift per day**, and the
 * comparison reports both numbers so the raw separation is never hidden.
 *
 * | drift per day | verdict |
 * |---|---|
 * | < 50 km/d, or identical epochs | `agree` — same orbit |
 * | 50–3 000 km/d | `stale` — expected ageing of an element set |
 * | > 3 000 km/d | `suspect` — too far for ageing alone |
 *
 * Two measured exceptions the bands must not flag as broken:
 *
 * * **Debris.** `OPS 0856 DEB` (NORAD 26671) is listed by both sources 1.1 h
 *   apart and 278 km apart — 5 700 km/day, far outside any band. Debris has no
 *   station-keeping and a poorly modelled area-to-mass ratio, so a short arc
 *   separates quickly. It is a property of the object class, not of the feed.
 * * **High orbits.** Objects near 12 000–14 000 km separation are all high
 *   semi-major axis, where SGP4's drag-free propagation diverges over days.
 *
 * So the comparison reports drift *and* the raw separation, and the caller
 * decides whether a large drift is disqualifying. The verdict is a triage
 * signal, not a correctness judgement.
 */

import type { Tle } from "../orbit/tle";
import { propagateTle } from "../orbit/sgp4";
import { mergeOcmCovariance, parseOcm, type Ocm } from "../orbit/ocm";
import { itrfStateToJ2000 } from "../orbit/frames-rigorous";
import type { ObjectSourceState } from "./ledger";

/**
 * An operator ephemeris (OCM) reduced to a lookup at an arbitrary instant.
 *
 * The OCM states are in ITRF2000 while SGP4 produces EME2000, so a comparison
 * between the two has to rotate one of them. The OCM is rotated, because it is a
 * stored table rather than a propagator: sampling it is an interpolation, not a
 * model evaluation.
 */
export interface OcmSampler {
  sourceId: string;
  /** Closest state to `ms`, in EME2000, or null outside the arc. */
  positionAt(ms: number): [number, number, number] | null;
  startMs: number;
  stopMs: number;
}

/** Build a sampler from raw OCM text. Returns null when the file cannot be parsed. */
export function ocmSampler(sourceId: string, raw: string): OcmSampler | null {
  let ocm: Ocm;
  try {
    ocm = parseOcm(raw);
  } catch {
    return null;
  }
  const states = mergeOcmCovariance(ocm);
  if (states.length === 0) return null;

  // Rotate once at build time. Doing it per lookup for 30 000 comparisons means
  // 30 000 IAU-2000 matrix builds, which dominated an early version of this run.
  const rotated = states.map((s) => ({
    ms: s.ms,
    position: itrfStateToJ2000(s.position, s.velocity, s.ms).position,
  }));

  return {
    sourceId,
    startMs: rotated[0].ms,
    stopMs: rotated[rotated.length - 1].ms,
    positionAt(ms: number) {
      if (ms < rotated[0].ms || ms > rotated[rotated.length - 1].ms) return null;
      // States are evenly spaced; binary search for the bracketing pair.
      let lo = 0;
      let hi = rotated.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (rotated[mid].ms <= ms) lo = mid;
        else hi = mid;
      }
      const a = rotated[lo];
      const b = rotated[hi];
      const span = b.ms - a.ms;
      if (span <= 0) return a.position;
      const t = (ms - a.ms) / span;
      return [
        a.position[0] + (b.position[0] - a.position[0]) * t,
        a.position[1] + (b.position[1] - a.position[1]) * t,
        a.position[2] + (b.position[2] - a.position[2]) * t,
      ];
    },
  };
}

/**
 * Why a comparison landed in `suspect`.
 *
 * A large separation alone cannot distinguish a bad element set from an object
 * class that simply diverges faster, so the reason is classified rather than
 * left to the reader of a kilometre count.
 */
export type SuspectCause =
  /** Both feeds date from the same hour but still disagree — a real mismatch. */
  | "same-epoch-disagreement"
  /** Debris or a rocket body: no station-keeping, short predictive horizon. */
  | "uncontrolled-object"
  /** High semi-major axis, where drag-free propagation diverges over days. */
  | "high-orbit"
  /** Nothing explains it; worth a human look. */
  | "unexplained";

/** How a source's comparison turns out. */
export type Agreement = "agree" | "stale" | "suspect" | "single-source" | "unpropagatable";

export interface SourceComparison {
  noradId: number;
  /** The source everything else is measured against. */
  referenceSource: string;
  referenceEpoch: string | null;
  /** One entry per source that has this object, including the reference. */
  entries: Array<{
    sourceId: string;
    epoch: string | null;
    /** Hours between this source's epoch and the reference epoch. */
    epochOffsetHours: number | null;
    /** Position at the joint epoch, km. Null when propagation failed. */
    position: [number, number, number] | null;
    /** Distance from the reference position, km. The reference itself is 0. */
    deltaKm: number | null;
    /** Field-level differences, for diagnosing a positional surprise. */
    deltaInclinationDeg: number | null;
    deltaMeanMotionRevPerDay: number | null;
  }>;
  /** Worst non-reference distance, km. */
  worstDeltaKm: number | null;
  /**
   * Worst distance expressed per day of epoch gap, km/day.
   *
   * `null` when every source states the same instant, in which case the verdict
   * rests on the raw separation alone.
   */
  worstDriftPerDay: number | null;
  verdict: Agreement;
  /** Set only when the verdict is `suspect`, to say which class of problem it is. */
  suspectCause: SuspectCause | null;
  /** Human-readable explanation, suitable for a UI tooltip. */
  reason: string;
}

export interface CompareOptions {
  /** Source whose epoch defines the joint instant. */
  referenceSource?: string;
  /**
   * Drift bands, km per day of epoch gap. Defaults suit LEO.
   */
  agreeKmPerDay?: number;
  staleKmPerDay?: number;
  /**
   * Raw separation treated as agreement regardless of epoch gap, km.
   *
   * Two sources that state the *same* epoch must agree to within this, so a
   * cross-check of two feeds of the same element set cannot be excused as "aging".
   */
  sameEpochKm?: number;
  /** Force a specific joint epoch instead of using the newest source's. */
  atMs?: number;
  /**
   * Operator ephemerides (OCM) keyed by source id.
   *
   * An OCM is the most accurate view of an object, so when one exists it becomes
   * the reference and the element sets are measured against it. A TLE fitted to
   * the same arc is a derived product, and checking the derivation against its
   * own source is the comparison that actually validates the whole chain.
   */
  ocm?: Map<string, OcmSampler>;
  /**
   * Object class from SATCAT, used to explain a large divergence.
   *
   * Passing it does not *excuse* a divergence — a debris object whose two feeds
   * disagree is still reported — it only labels the cause so an operator can
   * triage 60 warnings instead of reading them one by one.
   */
  objectType?: string | null;
  /**
   * Semi-major axis, km (mean motion derived). Above ~25 000 km the per-day
   * bands stop being meaningful.
   */
  semiMajorAxisKm?: number | null;
}

/**
 * Compare the element sets several sources hold for one object.
 *
 * `tles` is keyed by source id. A source that has no TLE-shaped element set (an
 * OCM, say) contributes its `ObjectSourceState` epoch but no position, and is
 * reported as `unpropagatable` rather than being dropped — silently omitting it
 * would make the object look single-sourced.
 */
export function compareSources(
  noradId: number,
  states: ObjectSourceState[],
  tles: Map<string, Tle>,
  options: CompareOptions = {},
): SourceComparison {
  const agreeKmPerDay = options.agreeKmPerDay ?? 50;
  const staleKmPerDay = options.staleKmPerDay ?? 3_000;
  const sameEpochKm = options.sameEpochKm ?? 5;

  if (states.length === 0) {
    return {
      noradId,
      referenceSource: options.referenceSource ?? "",
      referenceEpoch: null,
      entries: [],
      worstDeltaKm: null,
      worstDriftPerDay: null,
      verdict: "unpropagatable",
      suspectCause: null,
      reason: "no source holds this object",
    };
  }

  // The joint instant is the *newest* epoch among the sources, because that is
  // the shortest forward propagation and therefore the least accumulated drag
  // error. An explicit reference overrides it.
  //
  // Compared as timestamps, not strings: two sources can state the same instant
  // with different precision, and a lexical compare would pick the longer string.
  const usable = states.filter((s) => tles.has(s.sourceId) || options.ocm?.has(s.sourceId));
  const explicit = options.referenceSource
    ? states.find((s) => s.sourceId === options.referenceSource)
    : undefined;
  // An operator ephemeris wins the reference slot when present: it is the
  // published truth, and a TLE fitted from it is the thing under test.
  const ocmReference = options.ocm?.size
    ? states.find((s) => options.ocm!.has(s.sourceId))
    : undefined;
  const reference =
    explicit ??
    ocmReference ??
    [...usable].sort((a, b) => Date.parse(b.epoch as string) - Date.parse(a.epoch as string))[0] ??
    states[0];

  const jointMs = options.atMs ?? (reference.epoch ? Date.parse(reference.epoch) : NaN);

  const positions = new Map<string, [number, number, number] | null>();
  for (const state of states) {
    if (!Number.isFinite(jointMs)) {
      positions.set(state.sourceId, null);
      continue;
    }
    const sampler = options.ocm?.get(state.sourceId);
    if (sampler) {
      positions.set(state.sourceId, sampler.positionAt(jointMs));
      continue;
    }
    const tle = tles.get(state.sourceId);
    positions.set(state.sourceId, tle ? positionAt(tle, jointMs) : null);
  }

  const referencePosition = positions.get(reference.sourceId) ?? null;

  const entries = states.map((state) => {
    const position = positions.get(state.sourceId) ?? null;
    const epochOffsetHours =
      state.epoch && reference.epoch
        ? (Date.parse(state.epoch) - Date.parse(reference.epoch)) / 3_600_000
        : null;

    let deltaKm: number | null = null;
    if (position && referencePosition) {
      deltaKm =
        state.sourceId === reference.sourceId ? 0 : distance(position, referencePosition);
    }

    return {
      sourceId: state.sourceId,
      epoch: state.epoch,
      epochOffsetHours,
      position,
      deltaKm,
      deltaInclinationDeg:
        state.inclination !== null && reference.inclination !== null
          ? state.inclination - reference.inclination
          : null,
      deltaMeanMotionRevPerDay:
        state.meanMotion !== null && reference.meanMotion !== null
          ? state.meanMotion - reference.meanMotion
          : null,
    };
  });

  const others = entries.filter(
    (e) => e.sourceId !== reference.sourceId && e.deltaKm !== null,
  );
  const worstDeltaKm = others.length
    ? Math.max(...others.map((e) => e.deltaKm as number))
    : null;

  // Drift per day uses each offender's own epoch gap, so a source that is 1 h
  // behind is judged on 1 h of drift and a source 3 days behind on 3 days of it.
  // The gap is floored at one hour: two sources minutes apart would divide by
  // almost zero and report an enormous rate for a trivial separation.
  let worstDriftPerDay: number | null = null;
  if (worstDeltaKm !== null) {
    const rates = others
      .filter((e) => e.deltaKm !== null)
      .map((e) => {
        const gap = Math.max(1, Math.abs(e.epochOffsetHours ?? 0));
        return (e.deltaKm as number) / (gap / 24);
      });
    worstDriftPerDay = rates.length ? Math.max(...rates) : null;
  }

  // "Same epoch" is decided on the reference epoch, which is what a joint-instant
  // comparison means: equal instants must produce equal positions.
  const sameEpoch = others.every((e) => Math.abs(e.epochOffsetHours ?? Infinity) < 1 / 60);

  let verdict: Agreement;
  let reason: string;
  let suspectCause: SuspectCause | null = null;
  if (states.length === 1) {
    verdict = "single-source";
    reason = `only ${states[0].sourceId} holds this object; nothing to cross-check`;
  } else if (worstDeltaKm === null) {
    verdict = "unpropagatable";
    reason = "no two sources produced a position at the joint epoch";
  } else if (sameEpoch && worstDeltaKm <= sameEpochKm) {
    verdict = "agree";
    reason = `same epoch, separation ${worstDeltaKm.toFixed(2)} km — the sources publish the same elements`;
  } else if (!sameEpoch && (worstDriftPerDay ?? 0) <= agreeKmPerDay) {
    verdict = "agree";
    reason = `drift ${(worstDriftPerDay as number).toFixed(1)} km/day is within ${agreeKmPerDay}`;
  } else if (!sameEpoch && (worstDriftPerDay ?? 0) <= staleKmPerDay) {
    const oldest = Math.max(...others.map((e) => Math.abs(e.epochOffsetHours ?? 0)));
    verdict = "stale";
    reason =
      `drift ${(worstDriftPerDay as number).toFixed(0)} km/day over a ${oldest.toFixed(0)} h epoch gap — ` +
      `consistent with an aged element set`;
  } else {
    verdict = "suspect";
    suspectCause = classifySuspect({
      sameEpoch,
      sameEpochKm,
      deltaKm: worstDeltaKm,
      objectType: options.objectType,
      semiMajorAxisKm: options.semiMajorAxisKm,
    });
    reason = describeSuspect(suspectCause, worstDeltaKm, worstDriftPerDay, sameEpoch);
  }

  return {
    noradId,
    referenceSource: reference.sourceId,
    referenceEpoch: reference.epoch,
    entries,
    worstDeltaKm,
    worstDriftPerDay,
    verdict,
    suspectCause,
    reason,
  };
}

function classifySuspect(input: {
  sameEpoch: boolean;
  sameEpochKm: number;
  deltaKm: number;
  objectType?: string | null;
  semiMajorAxisKm?: number | null;
}): SuspectCause {
  if (input.sameEpoch && input.deltaKm > input.sameEpochKm) {
    return "same-epoch-disagreement";
  }
  const type = (input.objectType ?? "").toUpperCase();
  if (type === "DEBRIS" || type === "ROCKET BODY") return "uncontrolled-object";
  if (input.semiMajorAxisKm !== null && input.semiMajorAxisKm !== undefined) {
    if (input.semiMajorAxisKm > 25_000) return "high-orbit";
  } else if (input.deltaKm > 5_000) {
    // No orbit information: a separation this large is characteristic of a high
    // semi-major axis where drag-free propagation has diverged.
    return "high-orbit";
  }
  return "unexplained";
}

function describeSuspect(
  cause: SuspectCause,
  deltaKm: number,
  drift: number | null,
  sameEpoch: boolean,
): string {
  const rate = drift === null ? "" : `${drift.toFixed(0)} km/day`;
  switch (cause) {
    case "same-epoch-disagreement":
      return (
        `same epoch but ${deltaKm.toFixed(1)} km apart — the two feeds disagree about ` +
        `identical elements, which is a real mismatch, not ageing`
      );
    case "uncontrolled-object":
      return (
        `${deltaKm.toFixed(0)} km (${rate}) on debris or a rocket body — ` +
        `no station-keeping, so a short arc separates quickly`
      );
    case "high-orbit":
      return (
        `${deltaKm.toFixed(0)} km (${rate}) on a high orbit — SGP4 diverges over days ` +
        `without drag; compare over a shorter gap`
      );
    default:
      return (
        `${deltaKm.toFixed(0)} km (${rate})${sameEpoch ? " at the same epoch" : ""} — ` +
        `unexplained; check for a mis-keyed NORAD or an unannounced manoeuvre`
      );
  }
}

/** Position of `tle` at `ms`, km EME2000, or null when SGP4 refuses. */
function positionAt(tle: Tle, ms: number): [number, number, number] | null {
  const result = propagateTle(tle, {
    startMs: ms,
    spanHours: 1,
    stepSeconds: 3_600,
  });
  // `spanHours: 1` at a one-hour step yields exactly one state, at `startMs`, and
  // does so explicitly: passing 0 relies on the propagator's "non-positive span
  // means 24 h" fallback, which silently changes if that default ever moves.
  const state = result.states[0];
  if (!state) return null;
  // A state that is not at the requested instant is not a comparison point.
  if (Math.abs(state.ms - ms) > 1_000) return null;
  return state.position;
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export interface ComparisonSummary {
  compared: number;
  agree: number;
  stale: number;
  suspect: number;
  singleSource: number;
  unpropagatable: number;
  /** Median and p95 of the worst separation, km. */
  medianKm: number | null;
  p95Km: number | null;
  /** Median and p95 drift, km per day of epoch gap. */
  medianDriftKmPerDay: number | null;
  p95DriftKmPerDay: number | null;
  /** The worst offenders, for a UI table. */
  worst: SourceComparison[];
}

/** Aggregate many per-object comparisons into a report. */
export function summarize(comparisons: SourceComparison[], worstShown = 20): ComparisonSummary {
  const tally = { agree: 0, stale: 0, suspect: 0, singleSource: 0, unpropagatable: 0 };
  for (const c of comparisons) {
    if (c.verdict === "agree") tally.agree += 1;
    else if (c.verdict === "stale") tally.stale += 1;
    else if (c.verdict === "suspect") tally.suspect += 1;
    else if (c.verdict === "single-source") tally.singleSource += 1;
    else tally.unpropagatable += 1;
  }

  const deltas = comparisons
    .map((c) => c.worstDeltaKm)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);

  const drifts = comparisons
    .map((c) => c.worstDriftPerDay)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);

  const quantile = (values: number[], q: number) =>
    values.length === 0
      ? null
      : values[Math.min(values.length - 1, Math.floor(q * values.length))];

  return {
    compared: comparisons.length,
    ...tally,
    medianKm: quantile(deltas, 0.5),
    p95Km: quantile(deltas, 0.95),
    medianDriftKmPerDay: quantile(drifts, 0.5),
    p95DriftKmPerDay: quantile(drifts, 0.95),
    worst: [...comparisons]
      .filter((c) => c.worstDriftPerDay !== null)
      .sort((a, b) => (b.worstDriftPerDay as number) - (a.worstDriftPerDay as number))
      .slice(0, worstShown),
  };
}
