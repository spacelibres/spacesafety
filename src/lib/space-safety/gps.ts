/**
 * GPS time helpers.
 *
 * The API reports times of closest approach as **GPS nanoseconds since
 * 1980-06-01T00:00:00Z** (`tca_gps_nanos`). Two hazards:
 *
 * 1. int64 precision. GPS nanos today are ~1.5e18, far beyond
 *    `Number.MAX_SAFE_INTEGER` (9.007e15). The value must stay a `bigint` or a
 *    decimal string end to end — never a JS `number`.
 * 2. GPS time does not count leap seconds; UTC does. The offset has been 18 s
 *    since 2017-01-01. Any future leap second invalidates this constant.
 */

/** GPS epoch (1980-06-01T00:00:00Z) in Unix ms. */
const GPS_EPOCH_UNIX_MS = 315_964_800_000n;
const MS_PER_NANO = 1_000_000n;

/** GPS is ahead of UTC by this many seconds (last changed 2017-01-01). */
export const GPS_UTC_LEAP_SECONDS = 18;
const LEAP_MS = BigInt(GPS_UTC_LEAP_SECONDS) * 1_000n;

/** A time field may arrive as a decimal string, bigint, or a (risky) number. */
export type GpsNanos = string | number | bigint;

function toBigInt(value: GpsNanos, field = "tca_gps_nanos"): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new RangeError(`${field} must be an integer, received ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      // Silently losing precision here would misplace a TCA by minutes.
      throw new RangeError(
        `${field}=${value} exceeds Number.MAX_SAFE_INTEGER; pass it as a string or bigint`,
      );
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new RangeError(`${field} is not a decimal integer: ${value}`);
  }
  return BigInt(trimmed);
}

/** GPS nanoseconds -> UTC `Date`. */
export function gpsNanosToDate(nanos: GpsNanos): Date {
  const gpsMs = toBigInt(nanos) / MS_PER_NANO;
  const unixMs = gpsMs + GPS_EPOCH_UNIX_MS - LEAP_MS;
  if (unixMs < -(2n ** 53n) || unixMs > 2n ** 53n) {
    throw new RangeError(`timestamp out of representable range: ${nanos}`);
  }
  return new Date(Number(unixMs));
}

/** UTC `Date` -> GPS nanoseconds, as a decimal string. */
export function dateToGpsNanos(date: Date): string {
  const unixMs = BigInt(Math.floor(date.getTime()));
  const gpsMs = unixMs - GPS_EPOCH_UNIX_MS + LEAP_MS;
  return (gpsMs * MS_PER_NANO).toString();
}

/** Format a GPS-nanos instant. */
export function formatGps(
  nanos: GpsNanos,
  opts: Intl.DateTimeFormatOptions = {},
  timeZone = "UTC",
): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone,
      ...opts,
    }).format(gpsNanosToDate(nanos));
  } catch {
    return "—";
  }
}

/** Human-readable countdown, e.g. `T-2d 04h`, `T-13m`, `T+40s`. */
/**
 * Format a signed countdown from a millisecond delta.
 *
 * Split out so both time representations in this project reach the same string:
 * our own CDMs carry GPS nanoseconds, while a publicly published CDM carries an
 * ISO instant, and a page that shows "T-2d 04h" for one and something else for
 * the other would be reporting the same quantity two ways.
 */
export function formatCountdown(deltaMs: number): string {
  const sign = deltaMs >= 0 ? "T-" : "T+";
  const total = Math.floor(Math.abs(deltaMs) / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;

  if (days > 0) return `${sign}${days}d ${String(hours).padStart(2, "0")}h`;
  if (hours > 0) {
    return `${sign}${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) return `${sign}${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${sign}${seconds}s`;
}

export function countdownTo(
  nanos: GpsNanos,
  now: Date = new Date(),
): string | null {
  let tca: Date;
  try {
    tca = gpsNanosToDate(nanos);
  } catch {
    return null;
  }
  return formatCountdown(tca.getTime() - now.getTime());
}

/** Countdown to an ISO instant; `null` when the value is not a valid date. */
export function countdownToIso(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return formatCountdown(ms - now.getTime());
}
