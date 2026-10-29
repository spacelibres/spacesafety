/**
 * The download catalogue: every endpoint of both upstreams, with its cadence.
 *
 * ## Why one declarative table
 *
 * There are fifteen endpoints across two providers, each with its own format,
 * size, authentication requirement and publication rhythm. Spreading that across
 * scripts is how `satcat/details` — 69 MB of DISCOS and launch metadata — went
 * un-downloaded for a week while the smaller `satcat` fed the database.
 *
 * ## Cadence
 *
 * The numbers come from observed publication behaviour, not from a promise:
 *
 * | endpoint | observed | used |
 * |---|---|---|
 * | space-track `gp` | rebuilt several times a day | 120 min |
 * | spacebook `entity/tle` | OMM `CREATION_DATE` moves every few hours | 120 min |
 * | spacebook `satcat/supplemental` | follows the element sets | 120 min |
 * | spacebook `omm` | same | 120 min |
 * | space-track `cdm_public` | CDMs arrive continuously | 60 min |
 * | space-track `tip` | decay predictions, daily-ish | 360 min |
 * | spacebook `satcat`, `satcat/details` | catalogue, daily | 1440 min |
 * | space-track `satcat`, `boxscore`, `launch_site` | catalogue, daily | 1440 min |
 * | `spaceweather` / `eop` | daily files | 1440 min |
 *
 * ## Why history is kept
 *
 * Every download is archived under `data/archive/<endpoint>/<date>/`. Re-fetching
 * the catalogue daily is pointless unless the previous day is still on disk:
 * without history there is nothing to compare against, and a provider silently
 * rewriting last week's element sets cannot be detected. Differential storage is
 * what turns "we have data" into "we can prove what changed and when".
 */

export type Upstream = "space-track" | "spacebook" | "discos";

export type CatalogFormat =
  | "3le"
  | "json"
  | "csv"
  | "kvn"
  | "xml"
  | "text";

export interface DownloadSpec {
  /** Stable identifier, also the archive directory name. */
  id: string;
  upstream: Upstream;
  /** Path appended to the provider's base URL. */
  path: string;
  format: CatalogFormat;
  /** Minutes between refreshes. */
  refreshMinutes: number;
  /** Requires a login or token. */
  authenticated: boolean;
  /** Route through the SOCKS5 proxy. */
  viaProxy: boolean;
  /** One-line description of what this adds to the replica. */
  purpose: string;
  /**
   * How the body is stored.
   *
   * `raw` — archived as received, which is the only correct choice for any feed
   * we later want to diff. `parsed` — additionally loaded into the database by a
   * dedicated importer.
   */
  load: "raw" | "parsed";
  /**
   * Approximate body size, MB. Used only to estimate a schedule's cost, and to
   * catch a truncated download that still happened to end on a record boundary.
   */
  approxMB: number;
}

export const DOWNLOADS: readonly DownloadSpec[] = [
  // ---- Space-Track ---------------------------------------------------------
  {
    id: "space-track-gp",
    upstream: "space-track",
    path: "class/gp/format/3le",
    format: "3le",
    refreshMinutes: 120,
    authenticated: true,
    viaProxy: false,
    purpose: "Newest element set for every tracked object. The freshness reference.",
    load: "parsed",
    approxMB: 5,
  },
  {
    id: "space-track-satcat",
    upstream: "space-track",
    path: "class/satcat/format/json",
    format: "json",
    refreshMinutes: 1440,
    authenticated: true,
    viaProxy: false,
    purpose: "71 198 catalogue rows: type, country, launch, decay, RCS, orbit.",
    load: "parsed",
    approxMB: 33,
  },
  {
    id: "space-track-decay",
    upstream: "space-track",
    path: "class/decay/format/json",
    format: "json",
    refreshMinutes: 1440,
    authenticated: true,
    viaProxy: false,
    purpose: "143 546 re-entry records. Explains why a NORAD number stops appearing.",
    load: "raw",
    approxMB: 43,
  },
  {
    id: "space-track-tip",
    upstream: "space-track",
    path: "class/tip/format/json",
    format: "json",
    refreshMinutes: 360,
    authenticated: true,
    viaProxy: false,
    purpose: "26 184 tracking and impact predictions: predicted decay time and window.",
    load: "raw",
    approxMB: 8,
  },
  {
    id: "space-track-cdm-public",
    upstream: "space-track",
    path: "class/cdm_public/format/json",
    format: "json",
    refreshMinutes: 60,
    authenticated: true,
    viaProxy: false,
    purpose:
      "3 161 public conjunction data messages. The ground truth for validating our own Pc.",
    load: "raw",
    approxMB: 1.3,
  },
  {
    id: "space-track-boxscore",
    upstream: "space-track",
    path: "class/boxscore/format/json",
    format: "json",
    refreshMinutes: 1440,
    authenticated: true,
    viaProxy: false,
    purpose: "122 per-country object counts. Cheap completeness check on the catalogue.",
    load: "raw",
    approxMB: 0.05,
  },
  {
    id: "space-track-launch-site",
    upstream: "space-track",
    path: "class/launch_site/format/json",
    format: "json",
    refreshMinutes: 1440,
    authenticated: true,
    viaProxy: false,
    purpose: "45 launch site codes, to expand the SATCAT `LAUNCH_SITE` column.",
    load: "raw",
    approxMB: 0.005,
  },

  // ---- Spacebook -----------------------------------------------------------
  {
    id: "spacebook-entity-tle",
    upstream: "spacebook",
    path: "api/entity/tle",
    format: "3le",
    refreshMinutes: 120,
    authenticated: false,
    viaProxy: true,
    purpose: "32 809 element sets; supersedes XP-TLE, which is 3 234 objects shorter.",
    load: "parsed",
    approxMB: 4.6,
  },
  {
    id: "spacebook-xp-tle",
    upstream: "spacebook",
    path: "api/Entity/xp-tle",
    format: "3le",
    refreshMinutes: 120,
    authenticated: false,
    viaProxy: true,
    purpose: "Older/smaller TLE endpoint, kept as a second sample of the same provider.",
    load: "parsed",
    approxMB: 4.2,
  },
  {
    id: "spacebook-omm-json",
    upstream: "spacebook",
    path: "api/entity/omm/json",
    format: "json",
    refreshMinutes: 120,
    authenticated: false,
    viaProxy: true,
    purpose: "32 809 named OMM records with embedded TLE lines and catalogue fields.",
    load: "parsed",
    approxMB: 30,
  },
  {
    id: "spacebook-omm-kvn",
    upstream: "spacebook",
    path: "api/entity/omm/kvn",
    format: "kvn",
    refreshMinutes: 120,
    authenticated: false,
    viaProxy: true,
    purpose: "Same OMM records in CCSDS KVN. Cross-format check on the JSON body.",
    load: "raw",
    approxMB: 25,
  },
  {
    id: "spacebook-omm-xml",
    upstream: "spacebook",
    path: "api/entity/omm/xml",
    format: "xml",
    refreshMinutes: 1440,
    authenticated: false,
    viaProxy: true,
    purpose: "Same OMM records as XML. Confirms the field set is format-independent.",
    load: "raw",
    approxMB: 48,
  },
  {
    id: "spacebook-satcat",
    upstream: "spacebook",
    path: "api/entity/satcat",
    format: "json",
    refreshMinutes: 1440,
    authenticated: false,
    viaProxy: true,
    purpose: "72 310 catalogue rows with names, launch and decay dates, RCS class.",
    load: "parsed",
    approxMB: 21,
  },
  {
    id: "spacebook-satcat-details",
    upstream: "spacebook",
    path: "api/entity/satcat/details",
    format: "json",
    refreshMinutes: 1440,
    authenticated: false,
    viaProxy: true,
    purpose:
      "71 088 rows of DISCOS and McDowell launch messages — the provenance behind a NORAD number.",
    load: "raw",
    approxMB: 69,
  },
  {
    id: "spacebook-satcat-supplemental",
    upstream: "spacebook",
    path: "api/entity/satcat/supplemental",
    format: "json",
    refreshMinutes: 120,
    authenticated: false,
    viaProxy: true,
    purpose: "Status and covariance window per object; decides whether a Pc is computable.",
    load: "parsed",
    approxMB: 14.8,
  },
  {
    id: "spacebook-satcat-csv",
    upstream: "spacebook",
    path: "api/entity/satcat/csv",
    format: "csv",
    refreshMinutes: 1440,
    authenticated: false,
    viaProxy: true,
    purpose: "SATCAT as CSV — the format downstream spreadsheets expect.",
    load: "raw",
    approxMB: 11.2,
  },
  {
    id: "spacebook-satcat-details-csv",
    upstream: "spacebook",
    path: "api/entity/satcat/details/csv",
    format: "csv",
    refreshMinutes: 1440,
    authenticated: false,
    viaProxy: true,
    purpose: "The details feed as CSV.",
    load: "raw",
    approxMB: 24,
  },
  {
    id: "spacebook-spaceweather",
    upstream: "spacebook",
    path: "api/spaceweather/full",
    format: "kvn",
    refreshMinutes: 1440,
    authenticated: false,
    viaProxy: true,
    purpose: "F10.7 and Ap history and forecast, for the drag model.",
    load: "raw",
    approxMB: 3.5,
  },
  {
    id: "spacebook-eop",
    upstream: "spacebook",
    path: "api/eop/full",
    format: "kvn",
    refreshMinutes: 1440,
    authenticated: false,
    viaProxy: true,
    purpose: "Earth orientation history and prediction, for ITRF/TEME rotations.",
    load: "raw",
    approxMB: 2.5,
  },

  // ---- ESA DISCOSweb -------------------------------------------------------
  // The objects collection is paged by the API, so `path` is the base resource
  // and the runner walks pages rather than fetching one body.
  {
    id: "discos-objects",
    upstream: "discos",
    path: "objects",
    format: "json",
    refreshMinutes: 1440,
    authenticated: true,
    viaProxy: false,
    purpose:
      "Mass, cross-section, shape and drag coefficient per object — the only source with a physical model.",
    load: "raw",
    approxMB: 120,
  },
  {
    id: "discos-launches",
    upstream: "discos",
    path: "launches",
    format: "json",
    refreshMinutes: 1440,
    authenticated: true,
    viaProxy: false,
    purpose: "Launch events with dates and outcomes, to explain catalogue gaps.",
    load: "raw",
    approxMB: 8,
  },
  {
    id: "discos-fragmentations",
    upstream: "discos",
    path: "fragmentations",
    format: "json",
    refreshMinutes: 1440,
    authenticated: true,
    viaProxy: false,
    purpose: "Break-up events and the objects they produced — debris-cloud provenance.",
    load: "raw",
    approxMB: 3,
  },
  {
    id: "discos-launch-vehicles",
    upstream: "discos",
    path: "launch-vehicles",
    format: "json",
    refreshMinutes: 10080,
    authenticated: true,
    viaProxy: false,
    purpose: "Launcher models, their stages and engines. Nearly static.",
    load: "raw",
    approxMB: 3,
  },
  {
    id: "discos-reference",
    upstream: "discos",
    path: "object-classes",
    format: "json",
    refreshMinutes: 10080,
    authenticated: true,
    viaProxy: false,
    purpose:
      "Small enumeration tables (object classes, launch sites, tags, event types, families).",
    load: "raw",
    approxMB: 1,
  },
  {
    id: "discos-orbits",
    upstream: "discos",
    path: "destination-orbits",
    format: "json",
    refreshMinutes: 10080,
    authenticated: true,
    viaProxy: false,
    purpose:
      "88 378 historical orbit records (destination and initial). 232+641 pages; crawled concurrently.",
    load: "raw",
    approxMB: 90,
  },
] as const;

export function downloadById(id: string): DownloadSpec | undefined {
  return DOWNLOADS.find((d) => d.id === id);
}

/** Total bytes one full refresh moves, MB. */
export function totalSizeMB(specs: readonly DownloadSpec[] = DOWNLOADS): number {
  return specs.reduce((sum, s) => sum + s.approxMB, 0);
}

/** Endpoints due at `now`, given the last successful fetch time per id. */
export function dueForRefresh(
  lastSuccess: Map<string, string | null>,
  now = Date.now(),
  specs: readonly DownloadSpec[] = DOWNLOADS,
): DownloadSpec[] {
  return specs.filter((spec) => {
    const last = lastSuccess.get(spec.id);
    if (!last) return true;
    const ms = Date.parse(last);
    if (!Number.isFinite(ms)) return true;
    return now - ms >= spec.refreshMinutes * 60_000;
  });
}
