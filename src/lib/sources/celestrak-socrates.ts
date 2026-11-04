/**
 * CelesTrak's SOCRATES conjunction screening — the complete list.
 *
 * ## Why this replaces KeepTrack as the conjunction source
 *
 * KeepTrack re-publishes SOCRATES at `/socrates/latest`, and the v4 endpoint turned
 * out to return **ten rows**, all of them the same pair one 93-minute orbit apart:
 *
 *   ISS (ZARYA) × SOYUZ-MS 29   MIN_RNG 0.006   REL_SPEED 0   MAX_PROB 1
 *
 * Six metres between the ISS and a docked Soyuz, at zero relative velocity, is not a
 * conjunction — it is a docked pair seen by a screen that does not exclude them. The
 * probability of 1 is CelesTrak's "not computed" sentinel. So the endpoint is a
 * snapshot of one screened pair, not the screening.
 *
 * CelesTrak's own download is the screening: **197,600 events**, 10,197 of them under
 * 1 km, minimum 0.011 km, phase-appropriate relative speeds (12–14 km/s). Same feed,
 * complete. Fetch it at the source.
 *
 * ## Fields, and what the names get wrong
 *
 * `TCA_RANGE` is in **kilometres** and `TCA_RELATIVE_SPEED` in **km/s**. The KeepTrack
 * copy named the same field `MIN_RNG`, which reads like the CDM's `MIN_RNG` — and
 * that one is in metres. The two feeds disagree on that detail; here only one feed
 * is involved and the value is checked against magnitude, not against a name.
 *
 * `DSE` is the days-since-epoch of each element set: the age of the orbit solution
 * the screen used. A large value means the event rests on a stale TLE.
 *
 * ## Two files, one table
 *
 * `sort-minRange.csv` and `sort-maxProb.csv` are the same rows in two orders. Only
 * the first is fetched; the second is sorted again locally when a page asks.
 */

import { ACCEPT_ENCODING } from "../net/encoding";
import { download } from "../net/download";

const URL = "https://celestrak.org/SOCRATES/sort-minRange.csv";

export interface SocratesEventRow {
  norad1: number;
  name1: string;
  age1: number | null;
  norad2: number;
  name2: string;
  age2: number | null;
  /** ISO 8601 UTC. */
  tca: string | null;
  /** Kilometres. */
  minRangeKm: number | null;
  /** Kilometres per second. */
  relSpeedKmS: number | null;
  /** Null when CelesTrak did not compute one (it writes 1.000E+00). */
  maxProb: number | null;
  dilution: number | null;
}

/** Column order in the CSV. Splitting on commas is safe: no field is quoted. */
const COLUMNS = [
  "NORAD_CAT_ID_1",
  "OBJECT_NAME_1",
  "DSE_1",
  "NORAD_CAT_ID_2",
  "OBJECT_NAME_2",
  "DSE_2",
  "TCA",
  "TCA_RANGE",
  "TCA_RELATIVE_SPEED",
  "MAX_PROB",
  "DILUTION",
] as const;

/** `STARLINK-37392 [+]` → `STARLINK-37392`. The marker flags a note in CelesTrak's HTML. */
function cleanName(raw: string): string {
  return raw.replace(/\s*\[\+\]$/, "").trim();
}

function num(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/** `2026-11-07 19:18:26.039` (UTC, no zone marker) → ISO 8601. */
function isoFromCsv(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(raw.trim());
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/**
 * Parse the CSV.
 *
 * Lines that do not split into exactly eleven fields are counted and skipped rather
 * than guessed at: a shifted column would put a probability where a distance belongs.
 */
export function parseSocratesCsv(text: string): {
  rows: SocratesEventRow[];
  skipped: number;
} {
  const lines = text.split("\n");
  const header = lines[0]?.replace(/^\uFEFF/, "").trim().split(",");
  if (!header || header.length !== COLUMNS.length || header[0] !== COLUMNS[0]) {
    throw new Error(`SOCRATES header not recognised: ${lines[0]?.slice(0, 120) ?? "(empty)"}`);
  }

  const rows: SocratesEventRow[] = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = line.split(",");
    if (c.length !== COLUMNS.length) {
      skipped += 1;
      continue;
    }
    const norad1 = Number(c[0]);
    const norad2 = Number(c[3]);
    if (!Number.isInteger(norad1) || !Number.isInteger(norad2)) {
      skipped += 1;
      continue;
    }
    const maxProb = num(c[9]);
    rows.push({
      norad1,
      name1: cleanName(c[1]),
      age1: num(c[2]),
      norad2,
      name2: cleanName(c[4]),
      age2: num(c[5]),
      tca: isoFromCsv(c[6]),
      minRangeKm: num(c[7]),
      relSpeedKmS: num(c[8]),
      // ≥ 1 is the "not computed" sentinel, not certainty.
      maxProb: maxProb !== null && maxProb >= 0 && maxProb < 1 ? maxProb : null,
      dilution: num(c[10]),
    });
  }
  return { rows, skipped };
}

/**
 * Download and parse.
 *
 * The completeness test is the last line of the body: a truncated transfer ends
 * mid-row, and this file has no footer to check against. A final line with eleven
 * fields and a parseable date is the only evidence that the whole file arrived.
 */
export async function fetchSocratesFull(): Promise<{
  rows: SocratesEventRow[];
  skipped: number;
  bytes: number;
  lastModified: string | null;
}> {
  const res = await download(
    URL,
    (body) => {
      const text = body.toString("utf8");
      const lines = text.split("\n").filter((l) => l.trim() !== "");
      if (lines.length < 2) return false;
      const last = lines[lines.length - 1].split(",");
      return last.length === COLUMNS.length && isoFromCsv(last[6]) !== null;
    },
    {
      timeoutMs: 300_000,
      retries: 2,
      headers: {
        "user-agent": "spacesafety/0.1 (+https://github.com/spacelibres/spacesafety)",
        "accept-encoding": ACCEPT_ENCODING,
        accept: "text/csv,*/*",
      },
    },
  );
  if (!res.complete) {
    throw new Error(`SOCRATES transfer incomplete (${res.body.length} bytes, HTTP ${res.status})`);
  }
  const text = res.body.toString("utf8");
  const { rows, skipped } = parseSocratesCsv(text);
  return {
    rows,
    skipped,
    bytes: res.body.length,
    lastModified: res.lastModified ?? res.headers.get("last-modified"),
  };
}
