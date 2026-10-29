/**
 * Starlink public ephemeris feed.
 *
 * The vendor publishes every satellite's ephemeris without authentication:
 *
 *   https://www.starlink.com/public-files/ephemerides/MANIFEST.txt
 *   https://www.starlink.com/public-files/ephemerides/<entry from MANIFEST>
 *
 * This is a live data source usable before any SpaceX onboarding completes
 * (see `docs/SPEC-BEHAVIOR.md`). Documented in
 * `space-safety-articles/starlink_cola_conops.md`: ~8-hour cadence, CCSDS OCM
 * under `STARLINK-<nnnnn>.txt`, Modified ITC via the manifest filenames.
 *
 * Filename convention:
 *   MEME_<seq>_<OBJECT_NAME>_<NORAD_ID>_<Status>_<epoch>_UNCLASSIFIED.txt
 *
 * Body (Modified ITC):
 *   created:<ts> UTC
 *   ephemeris_start:<ts> UTC ephemeris_stop:<ts> UTC step_size:<seconds>
 *   ephemeris_source:<src>
 *   <COV_FRAME>
 *   repeating 4-line blocks of state + 21 covariance values
 */

import { parseModifiedItc, type CovarianceFrame, type ItcState } from "../orbit/itc";
import { downloadText, looksCompleteText } from "../net/download";

/**
 * Where the vendor publishes ephemerides.
 *
 * `www.starlink.com` used to serve the manifest directly. It now 302s to a
 * marketing page that returns HTML with HTTP 200, so a naive fetch "succeeds" and
 * then fails parsing with "manifest parsed to zero entries". The file endpoints
 * (`<name>.txt`) still work on both hosts, but the manifest only lives on
 * `api.starlink.com`.
 */
export const STARLINK_EPHEMERIS_BASE =
  "https://api.starlink.com/public-files/ephemerides";

/** Direct file host that also serves `<OBJECT_NAME>.txt` without a manifest. */
export const STARLINK_PUBLIC_FILES_BASE =
  "https://www.starlink.com/public-files/ephemerides";

export interface ManifestEntry {
  fileName: string;
  sequence: number;
  /** e.g. STARLINK-38128 */
  objectName: string;
  /**
   * The catalogue number, i.e. the object's NORAD id.
   *
   * Verified against the OCM: for every sampled object the first field equals
   * `OBJECT_DESIGNATOR` inside that object's own ephemeris (10/10 exact matches,
   * e.g. `STARLINK-38128` -> `100001`, `STARLINK-35000` -> `65278`). Starlink's
   * newer shells use ids in the 100000s, which is why they look unusual.
   *
   * The OCM remains authoritative: this is a convenience for listing objects
   * before their ephemeris has been fetched.
   */
  noradId: number;
  /**
   * Third numeric field: the vendor's delivery sequence for this file.
   *
   * Changes when the object's ephemeris is re-issued, so it distinguishes one
   * delivery of an arc from the next. It is **not** a catalogue number -- that is
   * `noradId`, the first field.
   */
  deliverySequence: number;
  /** Operational / PostMission / ... */
  status: string;
  /** Vendor epoch field from the filename. */
  epoch: number;
  url: string;
}

const MANIFEST_LINE =
  /^MEME_(\d+)_([A-Za-z0-9-]+)_(\d+)_([A-Za-z]+)_(\d+)_UNCLASSIFIED\.txt$/;

/**
 * Highest NORAD number that can plausibly be a catalogue id.
 *
 * Alpha-5 tops out at 339999; Starlink's newer shells legitimately use ids in
 * the 100000s, so this is a sanity bound, not a filter for "looks unusual".
 */
export const MAX_PLAUSIBLE_NORAD = 339999;

export function parseManifest(text: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = MANIFEST_LINE.exec(line);
    if (!m) continue;
    out.push({
      fileName: line,
      sequence: Number(m[1]),
      objectName: m[2],
      noradId: Number(m[1]),
      deliverySequence: Number(m[3]),
      status: m[4],
      epoch: Number(m[5]),
      url: `${STARLINK_EPHEMERIS_BASE}/${line}`,
    });
  }
  return out;
}

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
}

/**
 * Fetch an ephemeris body through the proxy, retrying until it is complete.
 *
 * Two separate truncation bugs drove this:
 *
 *   1. **Silent short reads.** A 1.6 MB ephemeris arrived as 772 KB, `fetch`
 *      reported success, and the parser died thousands of lines in with
 *      "trajectory line needs 7 fields".
 *   2. **No proxy.** The direct route to starlink.com truncates much earlier
 *      (a manifest of 823 468 bytes came back as 524 288), and Node's global
 *      `fetch` ignores `HTTPS_PROXY`, so downloads must go through
 *      `lib/net/download.ts`.
 *
 * The completeness predicate is format-agnostic: the body must not be shorter
 * than a trustworthy `content-length`. That header is only trusted when nothing
 * rewrote the transfer (no `content-encoding`), because otherwise it describes
 * the compressed size.
 */
async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  // A manifest ends with a file name; an ITC body ends with a `created:`/`ephemeris_start:`
  // header plus state blocks. Neither has a terminator line, so completeness is
  // "large enough and not an error page" rather than "ends with a marker".
  const isManifest = /MANIFEST\.txt$/i.test(url);
  const isComplete = isManifest
    ? looksCompleteText(/UNCLASSIFIED\.txt\s*$/)
    : (body: Buffer) => {
        if (!body || body.length < 512) return false;
        const head = body.subarray(0, 1).toString();
        if (head === "<" || head === "{") return false;
        const text = body.toString("utf8", 0, 4096);
        return /^created:/m.test(text) || /^ephemeris_start:/m.test(text);
      };

  const result = await downloadText(url, isComplete, {
    timeoutMs: opts.timeoutMs ?? 300_000,
    retries: opts.retries ?? 3,
    signal: opts.signal,
  });

  if (!result.complete) {
    throw new Error(
      `${url} -> body never arrived complete after retries ` +
        `(${result.text.length} chars)`,
    );
  }
  return result.text;
}

export async function fetchManifest(opts?: FetchOptions): Promise<ManifestEntry[]> {
  const text = await fetchText(`${STARLINK_EPHEMERIS_BASE}/MANIFEST.txt`, {
    timeoutMs: 120_000,
    ...opts,
  });
  const entries = parseManifest(text);
  if (entries.length === 0) {
    throw new Error("manifest parsed to zero entries — upstream format may have changed");
  }
  return entries;
}

export interface StarlinkEphemeris {
  objectName: string;
  createdAt: string;
  ephemerisStart: string;
  ephemerisStop: string;
  stepSeconds: number;
  source: string;
  covarianceFrame: CovarianceFrame | string;
  states: ItcState[];
  raw: string;
}

/** Parse a Starlink Modified-ITC file. Pure, so cached text can be reused. */
export function parseStarlinkEphemeris(
  raw: string,
  entry?: Pick<ManifestEntry, "objectName">,
): StarlinkEphemeris {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 5) throw new Error("ephemeris file too short");

  const header: Record<string, string> = {};
  let bodyStart = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();

    const created = /^created:(.+)$/.exec(line);
    if (created) {
      header.created = created[1].replace(/\s*UTC$/, "").trim();
      bodyStart = i + 1;
      continue;
    }

    const span =
      /^ephemeris_start:(.+?)\s+ephemeris_stop:(.+?)\s+step_size:(\S+)/.exec(line);
    if (span) {
      header.start = span[1].replace(/\s*UTC$/, "").trim();
      header.stop = span[2].replace(/\s*UTC$/, "").trim();
      header.step = span[3];
      bodyStart = i + 1;
      continue;
    }

    const source = /^ephemeris_source:(.+)$/.exec(line);
    if (source) {
      header.source = source[1].trim();
      bodyStart = i + 1;
      continue;
    }

    // Anything else non-numeric is the covariance frame line.
    if (/^[A-Z][A-Z0-9_]*$/.test(line)) {
      bodyStart = i;
      break;
    }
    break;
  }

  const covarianceFrame = lines[bodyStart]?.trim();
  if (!covarianceFrame || !/^[A-Z][A-Z0-9_]*$/.test(covarianceFrame)) {
    throw new Error(`missing covariance frame line (got "${covarianceFrame ?? ""}")`);
  }

  const body = lines.slice(bodyStart + 1).join("\n");
  const { states } = parseModifiedItc(body, covarianceFrame);

  return {
    objectName: entry?.objectName ?? "UNKNOWN",
    createdAt: toIso(header.created ?? ""),
    ephemerisStart: toIso(header.start ?? ""),
    ephemerisStop: toIso(header.stop ?? ""),
    stepSeconds: Number(header.step ?? 0) || 0,
    source: header.source ?? "unknown",
    covarianceFrame,
    states,
    raw,
  };
}

export async function fetchEphemeris(
  entry: ManifestEntry,
  opts?: FetchOptions,
): Promise<StarlinkEphemeris> {
  const raw = await fetchText(entry.url, opts);
  return parseStarlinkEphemeris(raw, entry);
}

/** "2026-10-26 00:54:42" (UTC) -> "2026-10-26T00:54:42.000Z" */
function toIso(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(trimmed);
  if (!m) return trimmed;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
}

/**
 * Convert a parsed ephemeris into the shape the screening kernel consumes.
 * Positions are already EME2000, which is exactly what the kernel expects.
 */
export function toScreeningSample(
  eph: StarlinkEphemeris,
  opts: { trajectoryId: string; objectId: string; hardBodyRadiusKm: number; stateSource?: string },
) {
  return {
    trajectoryId: opts.trajectoryId,
    objectId: opts.objectId,
    objectName: eph.objectName,
    hardBodyRadiusKm: opts.hardBodyRadiusKm,
    stateSource: opts.stateSource ?? "operator_ephemeris",
    states: eph.states.map((s) => ({
      epochMs: String(s.ms),
      px: s.position[0],
      py: s.position[1],
      pz: s.position[2],
      vx: s.velocity[0],
      vy: s.velocity[1],
      vz: s.velocity[2],
      covariance: s.covariance ?? [],
    })),
  };
}

/**
 * Direct OCM feed.
 *
 * The vendor serves a CCSDS OCM for every satellite at
 * `ephemerides/<OBJECT_NAME>.txt`, independent of the manifest. This is a
 * different product from the Modified-ITC files the manifest lists, and the
 * difference matters:
 *
 *   | | OCM | Modified ITC |
 *   |---|---|---|
 *   | NORAD id | **`OBJECT_DESIGNATOR`** | none |
 *   | covariance | none | **yes (UVW)** |
 *   | span | 7 days | 3 days |
 *   | frame | ITRF2000 | EME2000 |
 *
 * So neither format is strictly better. The OCM is authoritative for *identity*
 * (it is the only vendor feed that states the catalogue number) and covers a
 * longer arc; the ITC is the only vendor feed that carries covariance, which is
 * required for a probability of collision. A screening run wants both.
 */
export function ocmUrl(objectName: string): string {
  return `${STARLINK_EPHEMERIS_BASE}/${objectName.replace(/\.txt$/, "")}.txt`;
}

export interface StarlinkOcmFetch {
  raw: string;
  /** NORAD catalogue number from `OBJECT_DESIGNATOR`; null when unreadable. */
  noradId: number | null;
  objectName: string;
  startMs: number | null;
  stopMs: number | null;
}

/** Download one satellite's OCM. */
/**
 * Completeness for a Starlink OCM or Modified ITC body.
 *
 /**
 * Completeness for a Starlink OCM, decided by the file's own terminators.
 *
 * A complete OCM ends with `TRAJ_STOP` (trajectory section) and `MAN_STOP`
 * (manoeuvre section). A truncated download ends mid-number and has neither, so
 * the markers are proof of completeness in a way that headers are not: on this
 * host `content-length` has been wrong in both directions.
 */
function looksCompleteOcm(body: Buffer): boolean {
  if (!body || body.length === 0) return false;
  const head = body.subarray(0, 1).toString();
  if (head === "<" || head === "{") return false;
  const tail = body.subarray(Math.max(0, body.length - 8192)).toString("utf8");
  return tail.includes("TRAJ_STOP") || tail.includes("MAN_STOP");
}

export async function fetchStarlinkOcm(
  objectName: string,
  opts?: FetchOptions,
): Promise<StarlinkOcmFetch> {
  const result = await downloadText(ocmUrl(objectName), looksCompleteOcm, {
    timeoutMs: opts?.timeoutMs ?? 300_000,
    retries: opts?.retries ?? 3,
    signal: opts?.signal,
  });
  if (!result.complete) {
    throw new Error(
      `OCM for ${objectName} arrived incomplete (${result.text.length} chars, ` +
        `no TRAJ_STOP) after retries`,
    );
  }
  return parseStarlinkOcmHeader(result.text);
}

/**
 * Pull the identity fields out of an OCM without committing to a full parse.
 *
 * `parseOcm` in `../orbit/ocm` is the real parser; this exists so a caller that
 * only needs the catalogue number (identity resolution) does not pay for the
 * whole trajectory.
 */
export function parseStarlinkOcmHeader(raw: string): StarlinkOcmFetch {
  const designator = /^OBJECT_DESIGNATOR\s*=\s*(\S+)\s*$/m.exec(raw);
  const name = /^OBJECT_NAME\s*=\s*(\S+)\s*$/m.exec(raw);
  const start = /^START_TIME\s*=\s*(\S+)\s*$/m.exec(raw);
  const stop = /^STOP_TIME\s*=\s*(\S+)\s*$/m.exec(raw);

  // OCM declares DESIGNATOR as a string; it is a catalogue number when numeric.
  const numeric = designator ? Number.parseInt(designator[1], 10) : Number.NaN;

  return {
    raw,
    noradId: Number.isFinite(numeric) ? numeric : null,
    objectName: name?.[1] ?? "",
    startMs: start ? Date.parse(start[1]) : null,
    stopMs: stop ? Date.parse(stop[1]) : null,
  };
}
