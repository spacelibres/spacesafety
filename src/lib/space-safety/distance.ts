/**
 * Format a miss distance so that it reads correctly at every scale.
 *
 * ## Why one function
 *
 * Collision distances span four orders of magnitude: a real warning is tens of
 * metres, a routine screening result is hundreds of kilometres, and a message that
 * reports a near-zero miss is a genuine near-miss. One fixed unit cannot serve all
 * three:
 *
 *   `0.019 km`   → shown as "0.0 km", which says "zero distance" and is wrong
 *   `47.4 km`    → correct
 *   `101.0 km`   → correct, but three decimals would be noise
 *
 * So the unit follows the magnitude, and the number of decimals follows the unit.
 * A distance under 1 km is metres; anything larger is kilometres.
 *
 * ## Why the threshold is exactly 1 km
 *
 * Two reasons, and they agree. Metres are the unit the screening centre itself
 * publishes (`MIN_RNG` is in metres), so nothing is being invented for small
 * values; and 1 km is where millimetre-level precision stops being meaningful —
 * the elements behind these numbers are not accurate to that anyway.
 *
 * ## Locale
 *
 * The value is rounded here and the unit label comes from the dictionary, so the
 * digits are locale-independent and the words are not. `Intl` would give
 * localised digit grouping, but none of the distances here exceed 10 000 km in a
 * form where grouping matters, and mixing `Intl` output with a translated suffix
 * risks a different decimal separator in the number than in the unit.
 */

/** A distance already converted to kilometres, or null when unknown. */
export type DistanceKm = number | null | undefined;

/**
 * The display string, unit included.
 *
 * `t` is the dictionary lookup, so the unit label comes from the locale rather
 * than from this module. Passed in rather than imported because this file is also
 * used from server code that has no translator in scope.
 */
export function distanceLabel(
  km: DistanceKm,
  dash: string,
  t: (key: string) => string,
): string {
  const f = formatDistance(km);
  if (!f) return dash;
  return `${f.value} ${t(f.unit === "m" ? "unit.m" : "unit.km")}`;
}

export interface FormattedDistance {
  /** Digits only, no unit. Empty string is never returned — callers check `value`. */
  value: string;
  /** `m` or `km`; callers map this through the dictionary. */
  unit: "m" | "km";
}

/**
 * Format a distance in kilometres for display, choosing the unit by magnitude.
 *
 * Returns `null` for a missing value so the caller decides what to show for it —
 * an em dash, a translated "none", or nothing at all differ by context and this
 * function should not pick one.
 */
export function formatDistance(km: DistanceKm): FormattedDistance | null {
  if (km === null || km === undefined || !Number.isFinite(km)) return null;

  const metres = km * 1000;

  // Negative is not a distance. Rounding in `formatDistance` is display-only, so a
  // tiny negative from a subtraction upstream lands on 0 m rather than "-1 m".
  if (Math.abs(metres) < 1) return { value: "0", unit: "m" };

  if (Math.abs(km) < 1) {
    // Sub-kilometre: metres, no decimals. A 19 m miss and a 19.4 m miss are the
    // same operational fact, and the elements do not support the tenth.
    return { value: String(Math.round(metres)), unit: "m" };
  }

  // Kilometres: one decimal below 100 km (0.1 km ≈ 100 m, still meaningful at
  // screening scale), none above (a 0.1 km precision on a 900 km miss is noise).
  const decimals = Math.abs(km) < 100 ? 1 : 0;
  return { value: km.toFixed(decimals), unit: "km" };
}
