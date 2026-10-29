/**
 * NORAD catalogue resolution.
 *
 * An object in this platform carries whatever name its operator's ephemeris used.
 * The NORAD catalogue number is what links that object to the public catalogue —
 * and it cannot be read off the ephemeris: the Starlink manifest's filename field
 * that looks like a catalogue number (`MEME_..._STARLINK-38128_2992336_...`) is a
 * launch/delivery sequence, not a NORAD id. Only the catalogue can say which
 * object a name refers to.
 *
 * ## Why a name alone is not enough
 *
 * Names are reused and reused inconsistently. `STARLINK-38128` is a legitimate
 * catalogue entry today, but the Starlink series recycles numbers, and the same
 * string can match a decayed object from an earlier launch. So a candidate is only
 * accepted when:
 *
 *   1. the catalogue name matches, and
 *   2. the catalogue's orbital description agrees with what we observe
 *      (inclination and mean altitude within tolerance), and
 *   3. for ambiguity, the epoch and decay status prefer the live object.
 *
 * The orbital cross-check is what makes this safe. A wrong NORAD id is worse than
 * none: it silently attributes a conjunction to the wrong operator and corrupts
 * every downstream report.
 */

import { getDb } from "@/db";
import { objects } from "@/db/schema";
import { eq } from "drizzle-orm";

import { elementsFromState } from "../core/kinematics";
import type { ItcState } from "../orbit/itc";
import { isVendorEphemerisObject } from "../orbit/source-policy";
import { parseStarlinkOcmHeader } from "../sources/starlink-public";
import { fetchSatCat, type SatCatEntry } from "../sources/space-track";

/** Reasons a candidate was rejected, kept for the API and the audit log. */
export type RejectReason =
  | "name-mismatch"
  | "inclination-mismatch"
  | "altitude-mismatch"
  | "decayed"
  | "no-elements";

export interface NoradCandidate {
  entry: SatCatEntry;
  /** Absolute inclination difference, degrees. */
  inclinationDeltaDeg: number | null;
  /** Absolute mean-altitude difference, km. */
  altitudeDeltaKm: number | null;
  accepted: boolean;
  reason?: RejectReason;
}

/** Where a resolved id came from, so the caller can judge its trustworthiness. */
export type NoradSource = "ocm" | "catalogue";

export interface NoradResolution {
  noradId: number | null;
  /**
   * `ocm` when the vendor's own OCM stated the designator — authoritative, no
   * inference involved. `catalogue` when it came from matching a name against
   * Space-Track and cross-checking the orbit.
   */
  source?: NoradSource;
  /** Every candidate considered, with the decision, so a miss is explainable. */
  candidates: NoradCandidate[];
  /** Why nothing was chosen, when `noradId` is null. */
  error?: string;
  /** True when Space-Track is not configured or unreachable. */
  unavailable?: boolean;
}

export interface ResolveOptions {
  /** Inclination tolerance, degrees. Default 1.0 — TLE mean vs osculating differs. */
  inclinationToleranceDeg?: number;
  /** Mean-altitude tolerance, km. Default 15 — shells are 10 km apart. */
  altitudeToleranceKm?: number;
  /**
   * Accept a decayed catalogue entry. Off by default: an operator's live ephemeris
   * cannot describe an object that re-entered, so a match would be a name collision.
   */
  allowDecayed?: boolean;
}

/** Mean radius of a trajectory, km above the equator. */
function meanAltitudeKm(states: ItcState[]): number | null {
  if (states.length === 0) return null;
  let sum = 0;
  for (const s of states) {
    sum += Math.hypot(s.position[0], s.position[1], s.position[2]);
  }
  return sum / states.length - 6378.137;
}

/** Inclination from the first usable state. */
function inclinationDeg(states: ItcState[]): number | null {
  for (const s of states) {
    const el = elementsFromState(s.position, s.velocity);
    if (Number.isFinite(el.inclinationDeg)) return el.inclinationDeg;
  }
  return null;
}

/**
 * Score a catalogue entry against an observed trajectory.
 *
 * Exported for testing: the acceptance rule is the part that must not drift.
 */
export function scoreCandidate(
  entry: SatCatEntry,
  observed: { inclinationDeg: number | null; altitudeKm: number | null },
  opts: Required<Pick<ResolveOptions, "inclinationToleranceDeg" | "altitudeToleranceKm" | "allowDecayed">>,
): NoradCandidate {
  if (entry.decayDate && !opts.allowDecayed) {
    return { entry, inclinationDeltaDeg: null, altitudeDeltaKm: null, accepted: false, reason: "decayed" };
  }
  if (entry.inclinationDeg === null || entry.apogeeKm === null || entry.perigeeKm === null) {
    return { entry, inclinationDeltaDeg: null, altitudeDeltaKm: null, accepted: false, reason: "no-elements" };
  }

  const inclDelta =
    observed.inclinationDeg === null
      ? null
      : Math.abs(entry.inclinationDeg - observed.inclinationDeg);

  const catalogueMean = (entry.apogeeKm + entry.perigeeKm) / 2;
  const altDelta =
    observed.altitudeKm === null ? null : Math.abs(catalogueMean - observed.altitudeKm);

  if (inclDelta !== null && inclDelta > opts.inclinationToleranceDeg) {
    return { entry, inclinationDeltaDeg: inclDelta, altitudeDeltaKm: altDelta, accepted: false, reason: "inclination-mismatch" };
  }
  if (altDelta !== null && altDelta > opts.altitudeToleranceKm) {
    return { entry, inclinationDeltaDeg: inclDelta, altitudeDeltaKm: altDelta, accepted: false, reason: "altitude-mismatch" };
  }

  return { entry, inclinationDeltaDeg: inclDelta, altitudeDeltaKm: altDelta, accepted: true };
}

/**
 * Resolve a name plus trajectory to a NORAD catalogue number.
 *
 * Returns the best accepted candidate, or null with the reasons recorded. Never
 * throws for a missing catalogue; a network or credential problem surfaces as
 * `unavailable`.
 */
/**
 * Read the NORAD id straight out of the vendor's OCM.
 *
 * This is the authoritative path for Starlink: the OCM header carries
 * `OBJECT_DESIGNATOR`, which the vendor sets to the catalogue number. No name
 * matching, no orbital tolerance, no possibility of a reused name colliding.
 *
 * Returns null when the feed has no OCM for this object or the designator is not
 * numeric — a partner object, for instance, has no catalogue entry at all.
 */
export async function resolveNoradFromOcm(objectName: string): Promise<number | null> {
  // Only the vendor's own objects have a public ephemeris directory; asking for
  // another operator's file would just 404 on every call.
  if (!isVendorEphemerisObject(objectName)) return null;
  try {
    const { fetchStarlinkOcm } = await import("../sources/starlink-public");
    const ocm = await fetchStarlinkOcm(objectName, { timeoutMs: 120_000, retries: 1 });
    // Trust the designator only when the OCM is about the object we asked for:
    // a wrong file would otherwise attach someone else's catalogue id.
    if (ocm.objectName && ocm.objectName.toUpperCase() !== objectName.toUpperCase()) {
      return null;
    }
    return ocm.noradId;
  } catch {
    return null;
  }
}

/**
 * Resolve a name to a NORAD catalogue number.
 *
 * Tries the vendor OCM first, because it states the id directly; falls back to a
 * catalogue match only when no OCM exists. The fallback is deliberately the
 * weaker path and reports itself as such.
 */
export async function resolveNorad(
  objectName: string,
  states: ItcState[],
  opts: ResolveOptions = {},
): Promise<NoradResolution> {
  const fromOcm = await resolveNoradFromOcm(objectName);
  if (fromOcm !== null) {
    return { noradId: fromOcm, source: "ocm", candidates: [] };
  }
  const catalogue = await resolveFromCatalogue(objectName, states, opts);
  return { ...catalogue, source: catalogue.noradId === null ? undefined : "catalogue" };
}

/** Catalogue-only resolution: name match plus an orbital cross-check. */
export async function resolveFromCatalogue(
  objectName: string,
  states: ItcState[],
  opts: ResolveOptions = {},
): Promise<NoradResolution> {
  const tolerance = {
    inclinationToleranceDeg: opts.inclinationToleranceDeg ?? 1.0,
    altitudeToleranceKm: opts.altitudeToleranceKm ?? 15,
    allowDecayed: opts.allowDecayed ?? false,
  };

  const lookup = await fetchSatCat({ objectName, limit: 50 });
  if (lookup.error) {
    return {
      noradId: null,
      candidates: [],
      error: lookup.error,
      unavailable: lookup.notConfigured === true,
    };
  }

  // The catalogue's `~~` predicate is a contains-match, so filter to exact names.
  const exact = lookup.entries.filter((e) => e.name.toUpperCase() === objectName.toUpperCase());
  if (exact.length === 0) {
    return {
      noradId: null,
      candidates: [],
      error: `no catalogue entry named ${objectName}`,
    };
  }

  const observed = {
    inclinationDeg: inclinationDeg(states),
    altitudeKm: meanAltitudeKm(states),
  };

  const candidates = exact.map((e) => scoreCandidate(e, observed, tolerance));
  const accepted = candidates.filter((c) => c.accepted);

  if (accepted.length === 0) {
    return {
      noradId: null,
      candidates,
      error: `no catalogue entry for ${objectName} matches the trajectory ` +
        `(i=${observed.inclinationDeg?.toFixed(2) ?? "?"}°, alt=${observed.altitudeKm?.toFixed(1) ?? "?"} km)`,
    };
  }
  if (accepted.length === 1) {
    return { noradId: accepted[0].entry.noradId, candidates };
  }

  // Several live entries with the same name: prefer the one whose orbital
  // description is closest, which is the only tie-breaker the data supports.
  const best = accepted.sort((a, b) => {
    const da = (a.inclinationDeltaDeg ?? 0) + (a.altitudeDeltaKm ?? 0) / 100;
    const db = (b.inclinationDeltaDeg ?? 0) + (b.altitudeDeltaKm ?? 0) / 100;
    return da - db;
  })[0];

  return { noradId: best.entry.noradId, candidates };
}

export interface BackfillResult {
  updated: number;
  skipped: number;
  unresolved: Array<{ objectId: string; objectName: string; error: string }>;
}

/**
 * Fill in `objects.norad_id` for every object that lacks one.
 *
 * Each object's most recent trajectory is used for the orbital cross-check. Objects
 * already carrying a NORAD id are left alone: an operator may have set it by hand,
 * and that value wins over inference.
 */
export async function backfillNoradIds(
  opts: ResolveOptions & { limit?: number; dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const { db } = getDb();

  const rows = db
    .select()
    .from(objects)
    .all()
    .filter((o) => o.noradId === null)
    .slice(0, opts.limit ?? Number.POSITIVE_INFINITY);

  const result: BackfillResult = { updated: 0, skipped: 0, unresolved: [] };

  for (const row of rows) {
    // Import lazily: `queries` pulls in the whole read layer, and this module is
    // imported from routes that should not pay for it.
    const { latestTrajectoryStates } = await import("../queries");
    const states = latestTrajectoryStates(row.id);
    if (!states || states.length === 0) {
      result.skipped += 1;
      result.unresolved.push({
        objectId: row.id,
        objectName: row.objectName,
        error: "no trajectory to compare against the catalogue",
      });
      continue;
    }

    const resolution = await resolveNorad(row.objectName, states, opts);
    if (resolution.noradId === null) {
      result.unresolved.push({
        objectId: row.id,
        objectName: row.objectName,
        error: resolution.error ?? "unresolved",
      });
      continue;
    }

    if (!opts.dryRun) {
      db.update(objects)
        .set({ noradId: resolution.noradId, updatedAt: new Date().toISOString() })
        .where(eq(objects.id, row.id))
        .run();
    }
    result.updated += 1;
  }

  return result;
}
