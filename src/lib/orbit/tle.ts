/**
 * TLE parsing.
 *
 * Two-line element sets are the canonical public catalogue format: every object
 * tracked by 18th Space Defense Squadron has one, and it is the only public
 * source of a NORAD catalogue number tied to an object's orbit.
 *
 * Fixed-column layout (Vallado, *Fundamentals of Astrodynamics*, appendix;
 * also the Space-Track "TLE format" page):
 *
 *   Line 1
 *     01  line number
 *     03-07  catalogue number            (NORAD id)
 *     08     classification              U/C/S
 *     10-11  international designator year
 *     12-14  launch number of the year
 *     15-17  piece of the launch
 *     19-32  epoch: yyDDD.dddddddd       (day of year, fractional)
 *     34-43  first derivative of mean motion, rev/day^2
 *     45-52  second derivative, rev/day^3  (decimal point assumed)
 *     54-61  B* drag term                  (decimal point assumed)
 *     63     ephemeris type
 *     65-68  element set number
 *     69     checksum
 *
 *   Line 2
 *     01  line number
 *     03-07  catalogue number (must match line 1)
 *     09-16  inclination, deg
 *     18-25  right ascension of the ascending node, deg
 *     27-33  eccentricity, decimal point assumed
 *     35-42  argument of perigee, deg
 *     44-51  mean anomaly, deg
 *     53-63  mean motion, rev/day
 *     64-68  revolution number at epoch
 *     69     checksum
 *
 * ## Why the importer validates so hard
 *
 * A TLE with a bad checksum or mismatched catalogue numbers still *parses* — the
 * columns are fixed width — and then propagates to a plausible-looking but wrong
 * position. For conjunction screening that is far worse than a rejection, so
 * every structural invariant is checked and the checksum is verified.
 */

export interface Tle {
  /** Catalog number, as printed. Leading zeros are significant in some feeds. */
  noradId: number;
  /** Object name, when the source supplied a label line. */
  name: string | null;
  classification: string;
  /** International designator, e.g. `98067A`; empty when unassigned. */
  intlDesignator: string;
  /** Epoch as Unix milliseconds (UTC). */
  epochMs: number;
  /** Degrees. */
  inclinationDeg: number;
  /** Degrees, [0, 360). */
  raanDeg: number;
  /** Radians. */
  eccentricity: number;
  /** Degrees. */
  argPerigeeDeg: number;
  /** Degrees. */
  meanAnomalyDeg: number;
  /** Revolutions per day. */
  meanMotionRevPerDay: number;
  /** Rev number at epoch. */
  revNumber: number;
  /** Element set number. */
  elementSetNumber: number;
  /** B* drag term, 1/earth radii. */
  bstar: number;
  /** First derivative of mean motion / 2, rev/day². */
  meanMotionDot: number;
  /** Second derivative of mean motion / 6, rev/day³. */
  meanMotionDdot: number;
  /** Original text, for round-tripping and for `satellite.js`. */
  line1: string;
  line2: string;
}

export interface TleParseError {
  /** 1-based line number in the source text, when known. */
  line?: number;
  message: string;
}

const CHECKSUM_MOD = 10;

/**
 * Alpha-5 catalogue numbers.
 *
 * The catalogue passed 99 999 objects, so 5-column ids wrap into an alphanumeric
 * scheme: the leading character is `A`..`Z` (excluding I and O, which read as 1
 * and 0) standing for a hundred-thousands digit, followed by four digits. `A0000`
 * is 100000, `B0000` is 110000, and so on. Space-Track has been emitting these for
 * analyst objects since 2020, and CelesTrak for the whole catalogue.
 *
 * A plain `parseInt` returns NaN on `A1193`, which is what made every analyst
 * record fail to import.
 */
const ALPHA5_PREFIX = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Decode a 5-column catalogue field, which may be numeric or Alpha-5. */
export function parseCatalogueNumber(field: string): number | null {
  const text = field.trim();
  if (text === "") return null;

  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);

  const m = /^([A-Za-z])(\d{4})$/.exec(text);
  if (!m) return null;
  const index = ALPHA5_PREFIX.indexOf(m[1].toUpperCase());
  if (index < 0) return null;
  // A=10, B=11, ... => the hundred-thousands digit.
  return (index + 10) * 10_000 + Number.parseInt(m[2], 10);
}

/** Encode a catalogue number for display in a 5-column field. */
export function formatCatalogueNumber(noradId: number): string {
  if (noradId < 100_000) return String(noradId).padStart(5, "0");
  const digit = Math.floor(noradId / 10_000);
  const index = digit - 10;
  if (index < 0 || index >= ALPHA5_PREFIX.length) return String(noradId);
  return `${ALPHA5_PREFIX[index]}${String(noradId % 10_000).padStart(4, "0")}`;
}

/**
 * TLE checksum: sum of digits plus one per minus sign, modulo 10.
 *
 * The checksum digit itself occupies column 69 and is excluded.
 */
export function tleChecksum(line: string): number {
  const body = line.slice(0, 68);
  let sum = 0;
  for (const ch of body) {
    if (ch >= "0" && ch <= "9") sum += ch.charCodeAt(0) - 48;
    else if (ch === "-") sum += 1;
  }
  return sum % CHECKSUM_MOD;
}

/** Parse a decimal with an assumed point, as TLE uses for e, B* and derivatives. */
function assumedPoint(field: string, exponentDigits = 0): number {
  const trimmed = field.trim();
  if (!trimmed) return 0;

  // Sign occupies column 1; the mantissa has an implied leading "0.".
  const sign = trimmed.startsWith("-") ? -1 : 1;
  const body = trimmed.replace(/^[+-]/, "");

  let mantissa = body;
  let exponent = 0;
  if (exponentDigits > 0) {
    mantissa = body.slice(0, body.length - exponentDigits);
    const expText = body.slice(body.length - exponentDigits);
    exponent = Number.parseInt(expText, 10) || 0;
    const expSign = expText.startsWith("-") ? -1 : 1;
    exponent = Math.abs(exponent) * expSign;
  }

  const value = Number.parseFloat(`0.${mantissa}`);
  if (!Number.isFinite(value)) return 0;
  return sign * value * 10 ** exponent;
}

/**
 * Epoch from `yyDDD.dddddddd`.
 *
 * Two-digit years use the 1957 pivot that the catalogue itself is built on: the
 * first artificial satellite launched in 1957, so `57` is 1957 and anything
 * below it is 2000+. That is the convention both Space-Track and the CelesTrak
 * documentation state, and it stays correct until 2057.
 */
export function epochFromTle(yy: number, dayOfYear: number): number {
  const year = yy >= 57 ? 1900 + yy : 2000 + yy;
  const startOfYear = Date.UTC(year, 0, 1);
  // Day 1.0 is 1 January 00:00, so subtract one day before scaling.
  return startOfYear + (dayOfYear - 1) * 86_400_000;
}

/** Parse one TLE pair, with an optional preceding name line. */
export function parseTle(
  text: string,
  lineNumber?: number,
): { tle: Tle } | { error: TleParseError } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l !== "");

  if (lines.length < 2) {
    return { error: { line: lineNumber, message: "a TLE needs two lines" } };
  }

  // Accept an optional name line, which Space-Track emits for `format=3le`.
  let name: string | null = null;
  let l1: string;
  let l2: string;
  if (lines.length >= 3 && !lines[0].startsWith("1 ")) {
    // Strip the canonical `0 ` name marker so `name` holds the object name only.
    name = lines[0].replace(/^0\s+/, "").trim();
    l1 = lines[1];
    l2 = lines[2];
  } else {
    l1 = lines[0];
    l2 = lines[1];
  }

  const at = (s: string, from: number, to: number) => s.slice(from, to);

  if (!l1.startsWith("1 ") || !l2.startsWith("2 ")) {
    return {
      error: { line: lineNumber, message: "lines must begin with '1 ' and '2 '" },
    };
  }
  if (l1.length < 69 || l2.length < 69) {
    return {
      error: {
        line: lineNumber,
        message: `TLE lines must be 69 columns (got ${l1.length} and ${l2.length})`,
      },
    };
  }

  const sum1 = tleChecksum(l1);
  const sum2 = tleChecksum(l2);
  const given1 = Number.parseInt(l1[68], 10);
  const given2 = Number.parseInt(l2[68], 10);
  if (sum1 !== given1) {
    return {
      error: { line: lineNumber, message: `line 1 checksum ${given1} != computed ${sum1}` },
    };
  }
  if (sum2 !== given2) {
    return {
      error: { line: lineNumber, message: `line 2 checksum ${given2} != computed ${sum2}` },
    };
  }

  const cat1 = parseCatalogueNumber(at(l1, 2, 7));
  const cat2 = parseCatalogueNumber(at(l2, 2, 7));
  if (cat1 === null || cat1 !== cat2) {
    return {
      error: {
        line: lineNumber,
        message: `catalogue numbers differ between lines (${at(l1, 2, 7)} vs ${at(l2, 2, 7)})`,
      },
    };
  }

  const epochText = at(l1, 18, 32);
  const yy = Number.parseInt(epochText.slice(0, 2), 10);
  const doy = Number.parseFloat(epochText.slice(2));
  if (!Number.isFinite(yy) || !Number.isFinite(doy) || doy < 0 || doy > 367) {
    return { error: { line: lineNumber, message: `unreadable epoch '${epochText}'` } };
  }

  const inclinationDeg = Number.parseFloat(at(l2, 8, 16));
  const raanDeg = Number.parseFloat(at(l2, 17, 25));
  const argPerigeeDeg = Number.parseFloat(at(l2, 34, 42));
  const meanAnomalyDeg = Number.parseFloat(at(l2, 43, 51));
  const meanMotionRevPerDay = Number.parseFloat(at(l2, 52, 63));

  for (const [label, value] of [
    ["inclination", inclinationDeg],
    ["raan", raanDeg],
    ["argument of perigee", argPerigeeDeg],
    ["mean anomaly", meanAnomalyDeg],
    ["mean motion", meanMotionRevPerDay],
  ] as const) {
    if (!Number.isFinite(value)) {
      return { error: { line: lineNumber, message: `unreadable ${label}` } };
    }
  }

  return {
    tle: {
      noradId: cat1,
      name,
      classification: at(l1, 7, 8).trim() || "U",
      intlDesignator: at(l1, 9, 17).trim(),
      epochMs: epochFromTle(yy, doy),
      inclinationDeg,
      raanDeg,
      eccentricity: assumedPoint(at(l2, 26, 33)),
      argPerigeeDeg,
      meanAnomalyDeg,
      meanMotionRevPerDay,
      revNumber: Number.parseInt(at(l2, 63, 68), 10) || 0,
      elementSetNumber: Number.parseInt(at(l1, 64, 68), 10) || 0,
      bstar: assumedPoint(at(l1, 53, 61), 2),
      meanMotionDot: Number.parseFloat(at(l1, 33, 43)) || 0,
      meanMotionDdot: assumedPoint(at(l1, 44, 52), 2),
      line1: l1,
      line2: l2,
    },
  };
}

/**
 * Parse a multi-object TLE file.
 *
 * Handles both 2-line and 3-line layouts, and tolerates blank lines and `#`
 * comments, which some exports include. Errors are collected rather than thrown
 * so one bad record cannot discard an entire catalogue download — the caller
 * decides whether the failure rate is acceptable.
 */
export function parseTleFile(text: string): { tles: Tle[]; errors: TleParseError[] } {
  const raw = text.split(/\r?\n/);
  const tles: Tle[] = [];
  const errors: TleParseError[] = [];

  let i = 0;
  while (i < raw.length) {
    const line = raw[i].trimEnd();
    if (line === "" || line.startsWith("#")) {
      i += 1;
      continue;
    }

    if (line.startsWith("1 ")) {
      const next = raw[i + 1]?.trimEnd() ?? "";
      if (!next.startsWith("2 ")) {
        errors.push({ line: i + 1, message: "line 1 without a following line 2" });
        i += 1;
        continue;
      }
      const parsed = parseTle(`${line}\n${next}`, i + 1);
      if ("error" in parsed) errors.push(parsed.error);
      else tles.push(parsed.tle);
      i += 2;
      continue;
    }

    // `0 ` is the canonical name-line marker (Space-Track `format=3le`, CelesTrak
    // exports), so it must be checked as a name, not as a stray element line.
    // A bare `2 ` with no preceding `1 ` really is stray.
    if (line.startsWith("2 ")) {
      errors.push({ line: i + 1, message: "stray element line outside a pair" });
      i += 1;
      continue;
    }

    // A name line (with or without the `0 ` prefix): the next two lines should be
    // the element pair.
    const l1 = raw[i + 1]?.trimEnd() ?? "";
    const l2 = raw[i + 2]?.trimEnd() ?? "";
    if (l1.startsWith("1 ") && l2.startsWith("2 ")) {
      const parsed = parseTle(`${line}\n${l1}\n${l2}`, i + 1);
      if ("error" in parsed) errors.push(parsed.error);
      else tles.push(parsed.tle);
      i += 3;
      continue;
    }

    errors.push({ line: i + 1, message: "unrecognised line in TLE file" });
    i += 1;
  }

  return { tles, errors };
}

/** Compact summary for logs and API responses. */
export function describeTle(tle: Tle, asOfMs?: number): string {
  const epoch = new Date(tle.epochMs).toISOString();
  const ageHours = asOfMs ? ((asOfMs - tle.epochMs) / 3_600_000).toFixed(1) : "-";
  return (
    `${tle.name ?? `#${tle.noradId}`} i=${tle.inclinationDeg.toFixed(2)}° ` +
    `n=${tle.meanMotionRevPerDay.toFixed(4)}/day epoch=${epoch} age=${ageHours}h`
  );
}
