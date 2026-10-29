/**
 * Axis helpers for the hand-drawn SVG charts.
 *
 * Kept separate from the components so the (surprisingly easy to get wrong)
 * domain and tick logic can be tested without a renderer or a browser.
 */

export interface LogDomain {
  /** Lower bound, in log10 units. */
  lo: number;
  /** Upper bound, in log10 units. */
  hi: number;
  /** `hi - lo`, always > 0. */
  span: number;
}

/**
 * Domain for a log10 axis over a set of positive values.
 *
 * A series with a single point, or several identical points, has `hi === lo`.
 * Using those bounds directly makes the axis zero-width: every tick lands on the
 * same coordinate and React rejects the repeated keys — the bug this function
 * exists to prevent. The domain is therefore widened to half a decade either
 * side, which also gives the lone point a sensible position mid-plot.
 *
 * `values` must be positive; callers filter NULL and zero probabilities first.
 */
export function logDomain(values: number[]): LogDomain {
  if (values.length === 0) {
    // Nothing to plot; still return a usable domain rather than NaN.
    return { lo: -1, hi: 0, span: 1 };
  }
  const logs = values.map((v) => Math.log10(v));
  const lo = Math.min(...logs);
  const hi = Math.max(...logs);
  if (hi > lo) return { lo, hi, span: hi - lo };
  return { lo: lo - 0.5, hi: hi + 0.5, span: 1 };
}

/**
 * Grid lines for a log10 axis: one per whole decade inside the domain.
 *
 * Decade ticks are the readable choice on a log axis, and because they are
 * integers they are guaranteed distinct. A domain narrower than one decade still
 * gets a single centred line, so the plot never renders bare.
 *
 * The returned values are log10 exponents, not probabilities.
 */
export function logTicks(domain: LogDomain): number[] {
  const ticks: number[] = [];
  for (let e = Math.ceil(domain.lo); e <= Math.floor(domain.hi); e += 1) {
    ticks.push(e);
  }
  if (ticks.length === 0) ticks.push((domain.lo + domain.hi) / 2);
  return ticks;
}

/** Map a log10 value to a y coordinate inside `[top, top + height]`. */
export function logToY(value: number, domain: LogDomain, top: number, height: number): number {
  return top + height - ((value - domain.lo) / domain.span) * height;
}
