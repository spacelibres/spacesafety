/**
 * Trajectory source selection.
 *
 * Not every object can be screened from the same data, and using the wrong source
 * produces confident but wrong results. This module states the policy in one place
 * so callers cannot each invent their own.
 *
 * ## The three sources
 *
 * | Source | Provides | Accuracy | Availability |
 * |---|---|---|---|
 * | **OCM** (vendor) | epoch states, 7-day span, covariance, manoeuvre plan, **NORAD id** | highest | Starlink only |
 * | **ITC** (vendor) | epoch states, 3-day span, covariance | high | Starlink only |
 * | **OMM / TLE** | mean elements at one epoch | low — SGP4 with no covariance | whole catalogue |
 *
 * The OCM supersedes the ITC on every axis that matters: longer arc, same
 * covariance, and it alone states the catalogue number and the planned
 * manoeuvres. The ITC is kept because it is a second independent sample of the
 * same orbit, which is what the accuracy report needs to measure prediction
 * drift.
 *
 * ## Why Starlink must not be screened from TLE
 *
 * A TLE is a *fit*: one epoch of mean elements, propagated by an analytic model
 * with a single drag term. The vendor publishes the actual propagated trajectory,
 * which is a different and much better input. Screening Starlink against a
 * catalogue TLE would throw that away — and a TLE's along-track error grows by
 * kilometres per day, which is the same order as the 44 km along-track box.
 *
 * ## Why everything else must use TLE
 *
 * No other operator publishes public ephemerides. For those objects a TLE is the
 * only trajectory that exists, so it is used for *preliminary screening* and the
 * result is labelled as such: coarse enough to flag a candidate, not precise
 * enough to plan a manoeuvre from. Since SGP4 carries no covariance, any Pc
 * computed from it is NULL, which is the honest answer.
 */

/** Where a set of states came from. */
export type StateSource = "ocm" | "itc" | "tle" | "omm" | "operator";

/** How much weight a screening result from this source deserves. */
export type ScreeningQuality = "authoritative" | "preliminary";

export interface SourcePolicy {
  source: StateSource;
  quality: ScreeningQuality;
  /** True when the states carry usable 6x6 covariance. */
  hasCovariance: boolean;
  /** Why this source was chosen, for logs and for API metadata. */
  reason: string;
  /** Conditions a caller should surface rather than hide. */
  warnings: string[];
}

/**
 * The vendor's own feeds exist only for Starlink.
 *
 * The public ephemeris directory is Starlink-specific; there is no equivalent for
 * other operators in this platform's data set.
 */
export function isVendorEphemerisObject(objectName: string, operatorName?: string | null): boolean {
  // The name must be exactly `STARLINK-<digits>`. A prefix test is not enough: a
  // derived object such as `STARLINK-38128-PARTNER` belongs to this platform, has
  // no file in the vendor's directory, and would 404 on every lookup.
  if (/^STARLINK-\d+$/i.test(objectName)) return true;
  // Other names still qualify when the operator is the vendor — the directory is
  // keyed by name, but a future naming change should not silently drop the feed.
  return (
    !!operatorName &&
    /starlink|spacex/i.test(operatorName) &&
    !/-PARTNER$/i.test(objectName)
  );
}

/**
 * Decide how an object's trajectory should be obtained.
 *
 * Pure and synchronous: given what is known about the object, say which source is
 * correct and what a caller must be told about the result.
 */
export function sourcePolicy(opts: {
  objectName: string;
  operatorName?: string | null;
  /** Covariance present in the operator ephemeris we already hold? */
  hasCovariance?: boolean;
}): SourcePolicy {
  const vendor = isVendorEphemerisObject(opts.objectName, opts.operatorName);

  if (vendor && opts.hasCovariance) {
    return {
      source: "ocm",
      quality: "authoritative",
      hasCovariance: true,
      reason:
        "Starlink's OCM carries the operator's own propagated states, a 7-day arc, " +
        "6x6 covariance and the planned manoeuvres, plus the catalogue number.",
      warnings: [],
    };
  }

  if (vendor) {
    return {
      source: "ocm",
      quality: "authoritative",
      hasCovariance: false,
      reason:
        "Starlink publishes propagated OCM trajectories; they are the operator's own " +
        "solution and carry the catalogue number in the header.",
      warnings: [
        "This OCM carried no covariance, so any CDM built from it reports a NULL Pc. " +
          "Check whether the covariance section parsed.",
      ],
    };
  }

  return {
    source: "tle",
    quality: "preliminary",
    hasCovariance: false,
    reason:
      "No operator ephemeris is published for this object; the catalogue's mean " +
      "elements are the only trajectory available.",
    warnings: [
      "TLE accuracy degrades by kilometres per day from epoch; treat results as " +
        "candidate identification, not as a manoeuvre-grade prediction.",
      "SGP4 carries no covariance, so Pc is NULL.",
    ],
  };
}

/**
 * Screen-result label.
 *
 * Attached to anything derived from a trajectory so a consumer cannot mistake a
 * preliminary result for an authoritative one. The vendor's own API has no such
 * distinction because it only ever accepts operator ephemerides; this replica
 * accepts more, so it must say when it did.
 */
export interface SourceAttribution {
  source: StateSource;
  quality: ScreeningQuality;
  has_covariance: boolean;
  warnings: string[];
}

export function attribution(policy: SourcePolicy): SourceAttribution {
  return {
    source: policy.source,
    quality: policy.quality,
    has_covariance: policy.hasCovariance,
    warnings: policy.warnings,
  };
}

/**
 * Guard for the screening path.
 *
 * Returns an error string when the combination is one the platform should refuse
 * outright — currently: screening a vendor-ephemeris object from TLE. Silent
 * degradation is worse than refusal here, because the numbers look fine.
 */
export function refuseReason(opts: {
  objectName: string;
  operatorName?: string | null;
  usingSource: StateSource;
}): string | null {
  if (
    isVendorEphemerisObject(opts.objectName, opts.operatorName) &&
    (opts.usingSource === "tle" || opts.usingSource === "omm")
  ) {
    return (
      `${opts.objectName} is a Starlink object with a published OCM/OEM; screening it ` +
      `from catalogue mean elements would discard the operator's own trajectory. ` +
      `Use the OCM/OEM feed instead.`
    );
  }
  return null;
}
