/**
 * Legacy ephemeris formats.
 *
 * The Space Safety Platform accepts five formats for uploads
 * (`docs/starlink-space-safety/api__upload-a-trajectory.md`). OEM, OCM and
 * Modified ITC are covered by dedicated modules; the three Spaceflight Safety
 * Handbook formats live here:
 *
 *   UTC   18 SDS handbook p.22  — up to 21 header lines, then
 *                                 `yyyy/mm/dd hh:mm:ss.sss  px py pz vx vy vz`
 *   JSpOC 18 SDS handbook p.16  — labelled columns, same DOY timestamp shape as
 *                                 NASA but with an explicit report header
 *   NASA  18 SDS handbook p.16  — `yyDOYhhmmss.sss  px py pz vx vy vz`
 *
 * All three are EME2000 with UTC timestamps, and none carry covariance, so a
 * trajectory uploaded in these formats can still be screened but will produce
 * CDMs with a NULL probability.
 */

export interface LegacyState {
  /** Unix epoch milliseconds (UTC). */
  ms: number;
  /** km, EME2000. */
  position: [number, number, number];
  /** km/s, EME2000. */
  velocity: [number, number, number];
}

export class LegacyParseError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line ? `${message} (line ${line})` : message);
    this.name = "LegacyParseError";
  }
}

/** Strip header lines that precede the numeric block. */
function splitHeaderAndData(
  raw: string,
  isDataLine: (line: string) => boolean,
  maxHeaderLines: number,
): { header: string[]; data: string[] } {
  const lines = raw.split(/\r?\n/).map((l) => l.trimEnd());
  let start = 0;
  for (let i = 0; i < Math.min(lines.length, maxHeaderLines); i += 1) {
    if (isDataLine(lines[i].trim())) {
      start = i;
      break;
    }
    start = i + 1;
  }
  return { header: lines.slice(0, start), data: lines.slice(start).filter((l) => l.trim() !== "") };
}

function toVec(parts: string[], from: number): [number, number, number] {
  const vals = parts.slice(from, from + 3).map(Number);
  if (vals.length < 3 || vals.some((v) => !Number.isFinite(v))) {
    throw new LegacyParseError("non-numeric state component");
  }
  return [vals[0], vals[1], vals[2]];
}

// ---------------------------------------------------------------------------
// UTC format
// ---------------------------------------------------------------------------

const UTC_DATA = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)\s+(.+)$/;

/** True when a line looks like a UTC-format state vector. */
export function isUtcDataLine(line: string): boolean {
  return UTC_DATA.test(line);
}

/**
 * Parse the UTC ephemeris format (handbook p.22).
 *
 * Example data line:
 *   `2025/04/25 00:00:00.000  123.030 123.601 123.940776 -1.654 1.005 -1.000`
 */
export function parseUtcFormat(raw: string): LegacyState[] {
  const { data } = splitHeaderAndData(raw, isUtcDataLine, 21);
  if (data.length === 0) {
    throw new LegacyParseError("no state vectors found in UTC format");
  }

  const states: LegacyState[] = [];
  for (let i = 0; i < data.length; i += 1) {
    const m = UTC_DATA.exec(data[i]);
    if (!m) {
      throw new LegacyParseError(`unrecognised line: ${data[i].slice(0, 60)}`, i + 1);
    }
    const [, y, mo, d, h, mi, s, rest] = m;
    const ms = Date.parse(
      `${y}-${mo}-${d}T${h}:${mi}:${String(Number(s)).padStart(2, "0")}${s.includes(".") ? s.slice(s.indexOf(".")) : ".000"}Z`,
    );
    if (Number.isNaN(ms)) {
      throw new LegacyParseError(`invalid timestamp: ${y}/${mo}/${d} ${h}:${mi}:${s}`, i + 1);
    }
    const nums = rest.trim().split(/\s+/);
    if (nums.length < 6) {
      throw new LegacyParseError("state line needs 6 numeric fields", i + 1);
    }
    states.push({
      ms,
      position: toVec(nums, 0),
      velocity: toVec(nums, 3),
    });
  }

  states.sort((a, b) => a.ms - b.ms);
  return states;
}

// ---------------------------------------------------------------------------
// JSpOC format
// ---------------------------------------------------------------------------

// yyDOYhhmmss[.sss] is 11 digits; yyyyDOYhhmmss[.sss] is 13. Accept both.
const JSPOC_DATA = /^(\d{11}|\d{13})(?:\.\d+)?\s+(.+)$/;

/** True when a line looks like a DOY-timestamped state vector. */
export function isJspocDataLine(line: string): boolean {
  return JSPOC_DATA.test(line);
}

/**
 * Decode a DOY timestamp regardless of year width.
 *
 * The vendor's own ITC exports use a 4-digit year; the handbook formats use 2.
 */
export function parseDoyAny(token: string): number {
  const digits = token.split(".")[0];
  return digits.length === 13 ? parseDoyLong(token) : parseDoyShort(token);
}

/** yyyyDOYhhmmss[.sss] */
function parseDoyLong(token: string): number {
  const m = /^(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/.exec(token);
  if (!m) throw new LegacyParseError(`invalid yyyyDOY timestamp: ${token}`);
  const [, y, doy, hh, mi, ss, frac] = m;
  const d = Number(doy);
  if (d < 1 || d > 366 || Number(hh) > 23 || Number(mi) > 59 || Number(ss) > 60) {
    throw new LegacyParseError(`out-of-range yyyyDOY timestamp: ${token}`);
  }
  return Math.round(
    Date.UTC(Number(y), 0, 1) +
      ((d - 1) * 86_400 + Number(hh) * 3_600 + Number(mi) * 60 + Number(ss) + (frac ? Number(`0.${frac}`) : 0)) * 1000,
  );
}

/** Detects a JSpOC ephemeris report header, e.g. "JSpOC Format Ephemeris Report". */
const JSPOC_BANNER = /JSpOC[^\n]*Ephemeris\s+Report/i;

export function isJspocReport(raw: string): boolean {
  return JSPOC_BANNER.test(raw);
}

/**
 * Parse the JSpOC ephemeris report (handbook p.16).
 *
 * The report carries a `Spacecraft:` field and a `Date:` field; both are
 * informational for us, but the spacecraft name is useful as the object name.
 */
export function parseJspocFormat(raw: string): {
  states: LegacyState[];
  spacecraft: string | null;
  reportDate: string | null;
} {
  if (!isJspocReport(raw)) {
    throw new LegacyParseError("not a JSpOC ephemeris report");
  }

  const spacecraft = /Spacecraft:\s*(\S+)/i.exec(raw)?.[1] ?? null;
  const reportDate = /Date:\s*([0-9/]+\s+[0-9:]+)/i.exec(raw)?.[1] ?? null;

  const { data } = splitHeaderAndData(raw, isJspocDataLine, 40);
  if (data.length === 0) {
    throw new LegacyParseError("no state vectors found in JSpOC report");
  }

  const states: LegacyState[] = [];
  for (let i = 0; i < data.length; i += 1) {
    const m = JSPOC_DATA.exec(data[i]);
    if (!m) throw new LegacyParseError("unrecognised line", i + 1);
    const ms = parseDoyAny(m[1]);
    const nums = m[2].trim().split(/\s+/);
    if (nums.length < 6) {
      throw new LegacyParseError("state line needs 6 numeric fields", i + 1);
    }
    states.push({ ms, position: toVec(nums, 0), velocity: toVec(nums, 3) });
  }

  states.sort((a, b) => a.ms - b.ms);
  return { states, spacecraft, reportDate };
}

// ---------------------------------------------------------------------------
// NASA format
// ---------------------------------------------------------------------------

/**
 * Parse the NASA ephemeris format (handbook p.16).
 *
 * Data line: `yyDOYhhmmss.sss  px py pz vx vy vz`
 */
export function parseNasaFormat(raw: string): LegacyState[] {
  const { data } = splitHeaderAndData(raw, isJspocDataLine, 40);
  if (data.length === 0) {
    throw new LegacyParseError("no state vectors found in NASA format");
  }

  const states: LegacyState[] = [];
  for (let i = 0; i < data.length; i += 1) {
    const m = JSPOC_DATA.exec(data[i]);
    if (!m) throw new LegacyParseError(`unrecognised line: ${data[i].slice(0, 60)}`, i + 1);
    const ms = parseDoyAny(m[1]);
    const nums = m[2].trim().split(/\s+/);
    if (nums.length < 6) {
      throw new LegacyParseError("state line needs 6 numeric fields", i + 1);
    }
    states.push({ ms, position: toVec(nums, 0), velocity: toVec(nums, 3) });
  }

  states.sort((a, b) => a.ms - b.ms);
  return states;
}

/**
 * `yyDOYhhmmss.sss` with a **two-digit** year.
 *
 * These handbook formats differ from the vendor's own ITC exports, which use a
 * four-digit year (`yyyyDOYhhmmss.sss`). Two-digit years use the 1950-2049
 * pivot window from the handbook.
 */
export function parseDoyShort(token: string): number {
  const m = /^(\d{2})(\d{3})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/.exec(token);
  if (!m) throw new LegacyParseError(`invalid yyDOY timestamp: ${token}`);

  const yy = Number(m[1]);
  const doy = Number(m[2]);
  const hh = Number(m[3]);
  const mi = Number(m[4]);
  const ss = Number(m[5]);
  const frac = m[6] ? Number(`0.${m[6]}`) : 0;

  if (doy < 1 || doy > 366 || hh > 23 || mi > 59 || ss > 60) {
    throw new LegacyParseError(`out-of-range yyDOY timestamp: ${token}`);
  }

  const year = yy >= 50 ? 1900 + yy : 2000 + yy;
  const base = Date.UTC(year, 0, 1);
  return Math.round(
    base + ((doy - 1) * 86_400 + hh * 3_600 + mi * 60 + ss + frac) * 1000,
  );
}

/** Serialize a state list in NASA format (used by tests and exporters). */
export function toNasaFormat(states: LegacyState[]): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const lines = ["NASA Ephemeris Report", ""];
  for (const s of states) {
    const d = new Date(s.ms);
    const doy = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
    const stamp =
      pad(d.getUTCFullYear() % 100) +
      pad(doy, 3) +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds()) +
      "." +
      pad(d.getUTCMilliseconds(), 3);
    lines.push(
      `${stamp} ${s.position[0].toFixed(6)} ${s.position[1].toFixed(6)} ${s.position[2].toFixed(6)} ${s.velocity[0].toFixed(9)} ${s.velocity[1].toFixed(9)} ${s.velocity[2].toFixed(9)}`,
    );
  }
  return lines.join("\n") + "\n";
}
