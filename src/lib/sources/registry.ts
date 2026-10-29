/**
 * The registry of upstream sources, and the rules for combining them.
 *
 * ## Why a registry rather than per-script constants
 *
 * Every source has the same five attributes — credential env vars, refresh
 * cadence, format, what it covers, and how trustworthy its epoch is — and every
 * ingest script used to carry its own copy. That is how Spacebook TLEs ended up
 * written under the same `state_source` as Space-Track TLEs and silently
 * overwrote them. One table means one place to ask "who else has this object".
 *
 * ## Measured behaviour (2026-10-29), not vendor claims
 *
 * | source | epoch vs Space-Track | coverage | fields |
 * |---|---|---|---|
 * | space-track | reference | 30 752 | TLE + OMM + SATCAT |
 * | spacebook-entity-tle | **same epoch, 99.98%** | 32 809 | TLE |
 * | spacebook-omm | **same epoch, 99.98%** | 32 809 | OMM incl. TLE lines |
 * | spacebook-xp-tle | **66 h older** | 29 566 | TLE, no names |
 * | discos-objects | n/a (no elements) | 71 176 | **mass, shape, cross-section** |
 *
 * The first measurement of this said Spacebook ran 17–77 h behind. That was true
 * of `xp-tle` only: the `entity/tle` and `omm` endpoints share Space-Track's epoch
 * for 30 740 of 30 745 shared objects. See `docs/ANALYSIS.md` — the older figure
 * generalised one endpoint to the whole provider, and drove the wrong merge policy
 * (Spacebook was ranked as a stale source when it is a coverage source).
 *
 * ## Merge policy
 *
 * Precedence for the *trajectory a screen uses*:
 *
 *   1. `starlink-ocm` — operator arc with covariance. Only Starlink.
 *   2. `space-track`  — newest element set.
 *   3. `spacebook`    — widest coverage, older epoch.
 *
 * Precedence for *identity metadata* (name, type, RCS, launch/decay):
 *
 *   1. `spacebook-satcat` — the only source that has it for everything.
 *   2. `spacebook-omm`    — names for objects SATCAT lacks.
 *   3. `space-track`      — fills gaps, and its `OBJECT_NAME` is authoritative
 *                           for objects the operator renamed.
 */

export type SourceFormat = "tle" | "omm" | "ocm" | "itc" | "satcat" | "spaceweather" | "eop";

export interface SourceDefinition {
  id: string;
  label: string;
  /** `credentialed` sources need a login; `public` are anonymous. */
  kind: "credentialed" | "public";
  format: SourceFormat;
  /** Env var prefix, e.g. `SPACE_SAFETY_SPACETRACK` → `_USER` / `_PASS`. */
  credentialEnv?: string;
  /** Expected publication interval in minutes. */
  refreshMinutes: number;
  /** Does a fetch of this source need the outbound proxy? */
  viaProxy: boolean;
  /** One-line description shown in the UI. */
  notes: string;
  /**
   * Lower wins when two sources both have a trajectory for an object.
   *
   * Distances of 10 keep a whole class together: operator arcs (10) always beat
   * element sets (20+), so adding a fourth TLE-only feed cannot displace an OCM.
   */
  trajectoryPriority: number;
  /** Lower wins when two sources both claim to know an object's name. */
  identityPriority: number;
  /** Relative epoch staleness, in hours, measured against Space-Track. */
  typicalLagHours: number;
}

export const SOURCES: readonly SourceDefinition[] = [
  {
    id: "starlink-ocm",
    label: "Starlink OCM",
    kind: "public",
    format: "ocm",
    refreshMinutes: 480,
    viaProxy: false,
    notes: "7-day operator arc with 6x6 covariance and manoeuvre plan. Screening input.",
    trajectoryPriority: 10,
    identityPriority: 30,
    typicalLagHours: 0,
  },
  {
    id: "starlink-itc",
    label: "Starlink Modified ITC",
    kind: "public",
    format: "itc",
    refreshMinutes: 480,
    viaProxy: false,
    notes: "3-day operator arc with UVW covariance. Second sample of the same orbit.",
    trajectoryPriority: 11,
    identityPriority: 31,
    typicalLagHours: 0,
  },
  {
    id: "space-track",
    label: "Space-Track GP",
    kind: "credentialed",
    format: "tle",
    credentialEnv: "SPACE_SAFETY_SPACETRACK",
    refreshMinutes: 120,
    viaProxy: false,
    notes: "18th SDS element sets. Newest epoch of any source; the cross-check reference.",
    trajectoryPriority: 20,
    identityPriority: 20,
    typicalLagHours: 0,
  },
  {
    id: "spacebook-xp-tle",
    label: "Spacebook XP-TLE",
    kind: "public",
    format: "tle",
    refreshMinutes: 120,
    viaProxy: true,
    notes:
      "LEGACY. 29 566 objects, epochs 66 h behind on average (measured). " +
      "Superseded by spacebook-entity-tle; kept only as a second sample.",
    trajectoryPriority: 27,
    identityPriority: 42,
    typicalLagHours: 66,
  },
  {
    id: "spacebook-entity-tle",
    label: "Spacebook entity/TLE",
    kind: "public",
    format: "tle",
    refreshMinutes: 120,
    viaProxy: true,
    notes:
      "32 809 objects. Epochs match Space-Track on 99.98% of shared objects " +
      "(measured, n=30 745), so it is a coverage source, not a freshness one.",
    trajectoryPriority: 23,
    identityPriority: 41,
    typicalLagHours: 0,
  },
  {
    id: "spacebook-satcat-supplemental",
    label: "Spacebook SATCAT supplemental",
    kind: "public",
    format: "satcat",
    refreshMinutes: 1440,
    viaProxy: true,
    notes:
      "Per-object status and covariance window. 37 935 objects state a covariance span, which is what makes a Pc computable.",
    trajectoryPriority: 91,
    identityPriority: 11,
    typicalLagHours: 0,
  },
  {
    id: "spacebook-omm",
    label: "Spacebook OMM",
    kind: "public",
    format: "omm",
    refreshMinutes: 120,
    viaProxy: true,
    notes:
      "Same element sets as entity/tle, plus names and catalogue fields. " +
      "Epoch matches Space-Track on 99.98% of shared objects (measured).",
    trajectoryPriority: 26,
    identityPriority: 20,
    typicalLagHours: 0,
  },
  {
    id: "spacebook-satcat",
    label: "Spacebook SATCAT",
    kind: "public",
    format: "satcat",
    refreshMinutes: 1440,
    viaProxy: true,
    notes: "72 310 objects including decayed ones. Object type, RCS class, launch and decay.",
    trajectoryPriority: 90,
    identityPriority: 10,
    typicalLagHours: 0,
  },
  {
    id: "spaceweather",
    label: "Space weather (F10.7 / Ap)",
    kind: "public",
    format: "spaceweather",
    refreshMinutes: 1440,
    viaProxy: true,
    notes: "Drives atmospheric density in the drag model.",
    trajectoryPriority: 99,
    identityPriority: 99,
    typicalLagHours: 0,
  },
  {
    id: "eop",
    label: "Earth orientation (EOP)",
    kind: "public",
    format: "eop",
    refreshMinutes: 1440,
    viaProxy: true,
    notes: "Polar motion and UT1-UTC for the ITRF/TEME rotations.",
    trajectoryPriority: 99,
    identityPriority: 99,
    typicalLagHours: 0,
  },
] as const;

const BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

export function sourceById(id: string): SourceDefinition | undefined {
  return BY_ID.get(id);
}

/** Sources that carry per-object orbits, ordered by trajectory precedence. */
export function trajectorySources(): SourceDefinition[] {
  return SOURCES.filter((s) => ["tle", "omm", "ocm", "itc"].includes(s.format)).sort(
    (a, b) => a.trajectoryPriority - b.trajectoryPriority,
  );
}

/** The source a screen should use for object `noradId`, given what is present. */
export function pickTrajectorySource(available: Iterable<string>): SourceDefinition | undefined {
  const have = new Set(available);
  return trajectorySources().find((s) => have.has(s.id));
}

/** Sources that claim to know an object's name and type. */
export function identitySources(): SourceDefinition[] {
  return SOURCES.filter((s) => ["satcat", "omm"].includes(s.format)).concat(
    SOURCES.filter((s) => s.id === "space-track"),
  ).sort((a, b) => a.identityPriority - b.identityPriority);
}

/**
 * Is a source due for a refresh?
 *
 * A source that has never succeeded is always due. Otherwise the provider's own
 * cadence decides: polling Space-Track's 2-hour feed every 10 minutes spends the
 * day's login quota for no new data, and polling the daily SATCAT hourly just
 * re-downloads 21 MB.
 */
export function isDue(
  source: SourceDefinition,
  lastSuccessAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!lastSuccessAt) return true;
  const last = Date.parse(lastSuccessAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= source.refreshMinutes * 60_000;
}

/** Credential env prefix → the variable names the fetch needs. */
export function credentialVars(source: SourceDefinition): { user?: string; pass?: string } {
  if (!source.credentialEnv) return {};
  return { user: `${source.credentialEnv}_USER`, pass: `${source.credentialEnv}_PASS` };
}

/** True when every credential the source needs is present in `env`. */
export function hasCredentials(
  source: SourceDefinition,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const { user, pass } = credentialVars(source);
  if (!user || !pass) return true;
  return Boolean(env[user]) && Boolean(env[pass]);
}
