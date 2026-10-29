/**
 * Modified ITC ephemeris parser.
 *
 * Format: 18th Space Defense Squadron, "Spaceflight Safety Handbook for
 * Operators", p. 19 — the same spec the Space Safety Platform accepts for
 * uploads (`docs/starlink-space-safety/api__upload-a-trajectory.md`).
 *
 * Structure
 * ---------
 *   <any header lines>
 *   <COV_FRAME>                       UVW | RTN | RSW | EME2000 | J2000
 *   then repeating blocks of four lines:
 *     yyyyDOYhhmmss.sss px py pz vx vy vz
 *     cov[0..6]   \
 *     cov[7..13]   > 21 values = lower triangle of the 6x6 covariance
 *     cov[14..20] /
 *
 * Units: km and km/s. Position/velocity are EME2000; covariance is RTN-like
 * (UVW/RSW are synonyms of RTN) or EME2000 depending on the frame line.
 *
 * This is what `https://www.starlink.com/public-files/ephemerides/*.txt`
 * serves, and what our own upload path must accept.
 */

export type CovarianceFrame = "UVW" | "RTN" | "RSW" | "EME2000" | "J2000";

/** Frames whose axes are radially/transversely/normally aligned. */
export const RTN_LIKE_FRAMES: ReadonlySet<string> = new Set(["UVW", "RTN", "RSW"]);

export interface ItcState {
  /** Unix epoch milliseconds (UTC). */
  ms: number;
  /** km, EME2000. */
  position: [number, number, number];
  /** km/s, EME2000. */
  velocity: [number, number, number];
  /** Row-major 6x6 covariance, or null when absent. */
  covariance: number[] | null;
}

export interface ItcEphemeris {
  covarianceFrame: CovarianceFrame | string;
  states: ItcState[];
}

export class ItcParseError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line ? `${message} (line ${line})` : message);
    this.name = "ItcParseError";
  }
}

/**
 * Parse `yyyyDOYhhmmss.sss` into Unix ms.
 *
 * Two-digit years are interpreted per the spec's 1950-2049 pivot window.
 */
export function parseDoyTimestamp(token: string): number {
  // yyyyDOYhhmmss[.sss] — 13 digits plus an optional fractional part.
  const m = /^(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/.exec(token);
  if (!m) throw new ItcParseError(`invalid DOY timestamp: ${token}`);

  const year = Number(m[1]);
  const doy = Number(m[2]);
  const hh = Number(m[3]);
  const mm = Number(m[4]);
  const ss = Number(m[5]);
  const fraction = m[6] ? Number(`0.${m[6]}`) : 0;

  if (doy < 1 || doy > 366 || hh > 23 || mm > 59 || ss > 60) {
    throw new ItcParseError(`out-of-range DOY timestamp: ${token}`);
  }

  // Day 1 of the year is January 1st.
  const base = Date.UTC(year, 0, 1, 0, 0, 0);
  return Math.round(
    base + ((doy - 1) * 86_400 + hh * 3_600 + mm * 60 + ss + fraction) * 1000,
  );
}

/**
 * Parse a Modified ITC body (frame line already identified).
 *
 * @param body  the repeating 4-line blocks
 * @param frame covariance frame from the header line
 */
export function parseModifiedItc(
  body: string,
  frame: CovarianceFrame | string,
): ItcEphemeris {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));

  const states: ItcState[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // A state line begins with a yyyyDOYhhmmss[.sss] timestamp (13 digits plus
    // an optional fraction) followed by whitespace.
    if (!/^\d{13}(\.\d+)?\s/.test(line)) {
      // A covariance value at the start of a block is a common symptom of a
      // truncated upload, so say so rather than exposing internal state.
      if (/^[-+\d.]+e[-+]?\d+/i.test(line)) {
        throw new ItcParseError(
          "file appears truncated: a covariance block starts without a preceding state vector",
          i + 1,
        );
      }
      throw new ItcParseError(`expected state line, got: ${line.slice(0, 60)}`, i + 1);
    }

    const parts = line.split(/\s+/);
    if (parts.length < 7) {
      throw new ItcParseError(`state line needs 7 fields, got ${parts.length}`, i + 1);
    }

    const ms = parseDoyTimestamp(parts[0]);
    const nums = parts.slice(1, 7).map(Number);
    if (nums.some((n) => !Number.isFinite(n))) {
      throw new ItcParseError("non-numeric state vector", i + 1);
    }

    // Collect up to 3 following lines with 7 covariance values each.
    const covValues: number[] = [];
    let j = i + 1;
    while (j < lines.length && covValues.length < 21) {
      const candidate = lines[j];
      if (/^\d{13}(\.\d+)?\s/.test(candidate)) break; // next state starts
      const vals = candidate.split(/\s+/).map(Number);
      if (vals.some((n) => !Number.isFinite(n))) break;
      covValues.push(...vals);
      j += 1;
    }

    let covariance: number[] | null = null;
    if (covValues.length >= 21) {
      covariance = lowerTriangleTo6x6(covValues.slice(0, 21));
    }

    states.push({
      ms,
      position: [nums[0], nums[1], nums[2]],
      velocity: [nums[3], nums[4], nums[5]],
      covariance,
    });

    i = covariance ? j : i + 1;
  }

  if (states.length === 0) {
    throw new ItcParseError("no state vectors found");
  }

  states.sort((a, b) => a.ms - b.ms);
  return { covarianceFrame: frame, states };
}

/** Expand 21 lower-triangular values into a row-major 6x6 matrix. */
export function lowerTriangleTo6x6(values: number[]): number[] {
  const m = new Array<number>(36).fill(0);
  let k = 0;
  for (let r = 0; r < 6; r += 1) {
    for (let c = 0; c <= r; c += 1) {
      const v = values[k] ?? 0;
      m[r * 6 + c] = v;
      m[c * 6 + r] = v;
      k += 1;
    }
  }
  return m;
}

/** Collapse a 6x6 back into the 21 lower-triangular values. */
export function toLowerTriangle6x6(m: number[]): number[] {
  const out: number[] = [];
  for (let r = 0; r < 6; r += 1) {
    for (let c = 0; c <= r; c += 1) out.push(m[r * 6 + c]);
  }
  return out;
}

/**
 * Format a Unix ms instant as an ITC DOY timestamp.
 *
 * The container's `toISOString` gives us the UTC calendar date; the day-of-year
 * is derived from it.
 */
export function formatDoyTimestamp(ms: number): string {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const doy = Math.floor((d.getTime() - start) / 86_400_000) + 1;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    pad(year, 4) +
    pad(doy, 3) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    ".000"
  );
}
