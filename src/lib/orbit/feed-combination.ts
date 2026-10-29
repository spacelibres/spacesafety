/**
 * Combining the two vendor feeds into one screening input.
 *
 * Starlink publishes the same orbit twice. The OCM is the better feed — longer arc,
 * its own covariance, and the manoeuvre plan — so the normal case is simply "use
 * the OCM". The ITC matters in two narrower situations:
 *
 *   1. **The OCM carries no covariance section.** Then the ITC supplies it, and the
 *      result is a state set with the OCM's coverage and the ITC's uncertainty.
 *   2. **There is no OCM at all.** The ITC stands alone, as it did before the OCM
 *      was wired in.
 *
 * A third case is deliberately *not* handled: splicing two different state sets
 * together by timestamp. The feeds use different cadences, epochs and frames, so a
 * splice would either resample one onto the other (inventing data) or produce a
 * track with discontinuities at the seam. Coverage comes from one feed, covariance
 * from the other, and never the two mixed inside a single arc.
 *
 * ## Why the covariance is borrowed rather than interpolated across feeds
 *
 * Covariance grows with propagation time and the two feeds are propagated
 * independently from different fits. Borrowing a matrix from the ITC at a time the
 * OCM covers is a reasonable approximation only when the epochs are close, so the
 * borrow is limited to a tolerance and the result records that it happened.
 */

import type { ItcState } from "../orbit/itc";

export type FeedFormat = "ocm" | "itc" | string;

export interface FeedSource {
  trajectoryId: string;
  format: FeedFormat;
  states: ItcState[];
}

export type CombinationKind =
  /** One feed only; nothing to combine. */
  | "single"
  /** OCM states and covariance, self-contained. */
  | "ocm-complete"
  /** OCM states, covariance borrowed from the ITC. */
  | "ocm-with-itc-covariance"
  /** OCM has no covariance and no ITC to borrow from. */
  | "ocm-without-covariance";

export interface CombinedTrajectory {
  states: ItcState[];
  kind: CombinationKind;
  /** Trajectory id whose states were used. */
  stateTrajectoryId: string;
  /** Trajectory id whose covariance was used, when it differs. */
  covarianceTrajectoryId: string | null;
  /** Notes a caller should surface rather than hide. */
  warnings: string[];
}

/** How close a borrowed covariance epoch must be to the state, ms. */
export const COVARIANCE_BORROW_TOLERANCE_MS = 5 * 60 * 1000;

function withCovariance(states: ItcState[]): ItcState[] {
  return states.filter((s) => s.covariance !== null && s.covariance.length === 36);
}

/**
 * Attach covariance from `donor` onto `target` states by nearest epoch.
 *
 * Only fills states that have none; an existing matrix is never replaced, because
 * the feed that supplied the states is the authority for them.
 */
function borrowCovariance(
  target: ItcState[],
  donor: ItcState[],
): { states: ItcState[]; filled: number } {
  const pool = withCovariance(donor).sort((a, b) => a.ms - b.ms);
  if (pool.length === 0) return { states: target, filled: 0 };

  let filled = 0;
  const states = target.map((s) => {
    if (s.covariance) return s;

    // Nearest donor epoch by linear scan from a binary search: the arrays are
    // sorted and a track has thousands of samples, so a full scan per state would
    // be quadratic.
    let lo = 0;
    let hi = pool.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pool[mid].ms <= s.ms) lo = mid;
      else hi = mid;
    }
    const a = pool[lo];
    const b = pool[hi];
    const best = Math.abs(a.ms - s.ms) <= Math.abs(b.ms - s.ms) ? a : b;

    if (Math.abs(best.ms - s.ms) > COVARIANCE_BORROW_TOLERANCE_MS) return s;
    filled += 1;
    return { ...s, covariance: best.covariance };
  });

  return { states, filled };
}

/**
 * Choose the states to screen, given the trajectories available for one object.
 *
 * Precedence: a self-contained OCM, then an OCM borrowing covariance from an ITC,
 * then an ITC alone, then whatever single feed exists. Ties are broken toward the
 * longer arc, because a longer arc catches more conjunctions.
 */
export function combineFeeds(feeds: FeedSource[]): CombinedTrajectory | null {
  if (feeds.length === 0) return null;

  const ocm = feeds.filter((f) => f.format === "ocm").sort((a, b) => b.states.length - a.states.length)[0];
  const itc = feeds.filter((f) => f.format === "itc").sort((a, b) => b.states.length - a.states.length)[0];

  if (ocm) {
    const own = withCovariance(ocm.states);
    if (own.length === ocm.states.length) {
      return {
        states: ocm.states,
        kind: "ocm-complete",
        stateTrajectoryId: ocm.trajectoryId,
        covarianceTrajectoryId: null,
        warnings: [],
      };
    }

    if (itc) {
      const { states, filled } = borrowCovariance(ocm.states, itc.states);
      if (filled > 0) {
        return {
          states,
          kind: "ocm-with-itc-covariance",
          stateTrajectoryId: ocm.trajectoryId,
          covarianceTrajectoryId: itc.trajectoryId,
          warnings: [
            `OCM carried no covariance on ${ocm.states.length - own.length} state(s); ` +
              `borrowed from the ITC for ${filled}. The two feeds are independently ` +
              `propagated, so Pc from this pairing is approximate.`,
          ],
        };
      }
    }

    return {
      states: ocm.states,
      kind: "ocm-without-covariance",
      stateTrajectoryId: ocm.trajectoryId,
      covarianceTrajectoryId: null,
      warnings: [
        "OCM carries no covariance and no ITC was available to supply one; " +
          "any CDM from this trajectory will report a NULL Pc.",
      ],
    };
  }

  if (itc) {
    // The ITC can also be the covariance-less one: a deployment may hold an OCM
    // without COV plus a modified ITC, and both parse as `itc` here. Borrowing
    // across them is still correct in the limited sense the module documents --
    // nearest epoch, within tolerance, never overwriting an existing matrix.
    const own = withCovariance(itc.states);
    if (own.length === 0) {
      const donor = feeds.find((f) => f !== itc && withCovariance(f.states).length > 0);
      if (donor) {
        const { states, filled } = borrowCovariance(itc.states, donor.states);
        if (filled > 0) {
          return {
            states,
            kind: "ocm-with-itc-covariance",
            stateTrajectoryId: itc.trajectoryId,
            covarianceTrajectoryId: donor.trajectoryId,
            warnings: [
              `${itc.trajectoryId} carried no covariance on ${itc.states.length} state(s); ` +
                `borrowed from ${donor.trajectoryId} for ${filled}. The feeds are independently ` +
                `propagated, so Pc from this pairing is approximate.`,
            ],
          };
        }
      }
    }
    return {
      states: itc.states,
      kind: "single",
      stateTrajectoryId: itc.trajectoryId,
      covarianceTrajectoryId: null,
      warnings:
        own.length === itc.states.length
          ? []
          : ["ITC carries no covariance on some states; Pc may be NULL."],
    };
  }

  // Some other format: pass it through untouched.
  const other = feeds[0];
  return {
    states: other.states,
    kind: "single",
    stateTrajectoryId: other.trajectoryId,
    covarianceTrajectoryId: null,
    warnings: [],
  };
}
