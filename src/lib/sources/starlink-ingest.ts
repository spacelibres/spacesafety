/**
 * Starlink dual-feed ingestion.
 *
 * ## Why two feeds, stored together
 *
 * Starlink is the only operator here that publishes propagated ephemerides, and it
 * publishes them twice in different shapes:
 *
 * | | OCM (`<NAME>.txt`) | Modified ITC (manifest) |
 * |---|---|---|
 * | NORAD catalogue number | **yes** (`OBJECT_DESIGNATOR`) | no |
 * | covariance | no | **yes** (UVW) |
 * | span | 7 days | 3 days |
 * | frame | ITRF2000 | EME2000 |
 *
 * Neither is sufficient. Screening needs covariance to produce a probability, so
 * without the ITC every CDM would report a NULL Pc. Identity and a long arc need
 * the OCM, because the manifest's filename number is a delivery sequence, not a
 * catalogue number.
 *
 * So both are stored, as two rows in `trajectories` linked by `companion_id`. The
 * OCM row carries the identity and the long arc; the ITC row carries the
 * covariance. A screening job asks for the pair rather than guessing which single
 * row to use.
 *
 * ## Why not merge into one row
 *
 * The two feeds have different epochs, cadences and frames. Merging would require
 * resampling one onto the other, which invents data and throws away the fine
 * cadence of whichever feed was coarser. Keeping both and letting the kernel
 * interpolate over the union is honest and lossless.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getDb, nextSeq } from "@/db";
import { catalog, objects, operators, trajectoryFiles, trajectories } from "@/db/schema";
import { selectReference } from "@/lib/orbit/catalog-policy";
import { normaliseTrajectory } from "@/lib/api/validate-trajectory";
import { sourcePolicy } from "@/lib/orbit/source-policy";
import {
  fetchEphemeris as fetchEphemeris,
  fetchStarlinkOcm,
  parseStarlinkOcmHeader,
  type ManifestEntry,
} from "@/lib/sources/starlink-public";
import { eq } from "drizzle-orm";

/** Which vendor feed a stored trajectory came from. */
export type FeedKind = "ocm" | "itc";

export interface IngestOptions {
  /** Operator the object belongs to; created if missing. */
  operatorId?: string;
  operatorName?: string;
  /** Skip the OCM write, e.g. for a quick test. */
  skipOcm?: boolean;
  skipItc?: boolean;
  /** Overall per-request timeout, ms. */
  timeoutMs?: number;
  onLog?: (message: string) => void;
  /**
   * Directory of previously downloaded `<OBJECT_NAME>.txt` files.
   *
   * Ingest used to re-download everything: a 100-object import meant 700 MB of
   * network traffic for files already on disk, each throttled to ~1 MB/s per
   * connection. When a complete file is present it is used as-is, so ingest is
   * pure CPU and database work.
   */
  cacheDir?: string;
}

export interface IngestedFeed {
  feed: FeedKind;
  trajectoryId: string;
  pointCount: number;
  startAt: string;
  endAt: string;
  hasCovariance: boolean;
  /** True when this exact file was already stored and nothing was written. */
  reused: boolean;
}

export interface IngestResult {
  objectId: string;
  objectName: string;
  noradId: number | null;
  feeds: IngestedFeed[];
  warnings: string[];
}

/**
 * Content hash used to detect an unchanged file.
 *
 * The vendor regenerates its files every few hours even when the orbit has barely
 * moved, so hashing the text is what stops the table growing by a few megabytes per
 * satellite per day.
 */
function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Ensure an object row exists, returning its id. */
function ensureObject(opts: {
  objectName: string;
  operatorId: string;
  noradId: number | null;
  hardBodyRadiusM: number;
}): string {
  const { db } = getDb();
  const existing = db
    .select()
    .from(objects)
    .where(eq(objects.objectName, opts.objectName))
    .all()
    .find((o) => o.operatorId === opts.operatorId);

  const now = new Date().toISOString();
  if (existing) {
    // Fill in the catalogue number if we learned it, but never overwrite one an
    // operator set by hand.
    if (existing.noradId === null && opts.noradId !== null) {
      db.update(objects)
        .set({ noradId: opts.noradId, updatedAt: now })
        .where(eq(objects.id, existing.id))
        .run();
    }
    return existing.id;
  }

  const id = crypto.randomUUID();
  db.insert(objects)
    .values({
      id,
      operatorId: opts.operatorId,
      objectName: opts.objectName,
      noradId: opts.noradId,
      hardBodyRadius: opts.hardBodyRadiusM,
      maneuverability: true,
      alive: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

/** Ensure the Starlink operator row exists. */
function ensureOperator(opts: IngestOptions): string {
  if (opts.operatorId) return opts.operatorId;
  const { db } = getDb();
  const name = opts.operatorName ?? "Starlink";
  const existing = db.select().from(operators).where(eq(operators.name, name)).get();
  if (existing) return existing.id;

  const id = "22222222-2222-4222-8222-222222222222";
  const now = new Date().toISOString();
  db.insert(operators)
    .values({
      id,
      name,
      email: "satellite-operators@starlink.com",
      phone: "+1 310 363 6000",
      maxObjects: 20000,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  return id;
}

/** Insert one trajectory row, deduplicating on unchanged content. */
function storeTrajectory(args: {
  objectId: string;
  operatorId: string;
  raw: string;
  format: string;
  fileFormat: FeedKind;
  stateSource: string;
}): {
  trajectoryId: string;
  pointCount: number;
  startAt: string;
  endAt: string;
  hasCovariance: boolean;
  /** States without a usable matrix; the caller turns this into a warning. */
  missingCovariance: number;
  reused: boolean;
} {
  const { db, sqlite } = getDb();

  const normalised = normaliseTrajectory(args.raw);
  // "Has covariance" means *some* states carry a usable 6x6.
  //
  // It used to be `every()`, which is wrong twice over: Starlink OCMs routinely
  // lose covariance on part of the arc (measured: 12-36% of states have a matrix
  // with a negative eigenvalue, concentrated after day 4), and the validator now
  // drops those matrices rather than rejecting the file. With `every()` a
  // trajectory with 74% good covariance reported "no covariance at all" and the
  // UI said Pc would be NULL — a false statement, since Pc is computable at the
  // 74% of epochs that do have one.
  const withCovariance = normalised.states.filter((s) => s.covariance !== null).length;
  const hasCovariance = withCovariance > 0;
  const missingCovariance = normalised.states.length - withCovariance;
  const pointCount = normalised.states.length;
  const startAt = normalised.startAt;
  const endAt = normalised.endAt;

  // Deduplicate: the same object + feed + identical bytes means nothing changed.
  const previous = db
    .select({
      id: trajectories.id,
      pointCount: trajectories.pointCount,
      startAt: trajectories.startAt,
      endAt: trajectories.endAt,
      hasCovariance: trajectories.hasCovariance,
      fileText: trajectoryFiles.fileText,
    })
    .from(trajectories)
    .innerJoin(trajectoryFiles, eq(trajectoryFiles.trajectoryId, trajectories.id))
    .where(eq(trajectories.objectId, args.objectId))
    .all()
    .filter((t) => t.fileText !== null && t.fileText !== undefined);

  // Only compare against trajectories of the same feed; the join above already
  // restricted rows to those that still have a file.
  const sameFormat = db
    .select({ id: trajectories.id, fileFormat: trajectories.fileFormat })
    .from(trajectories)
    .where(eq(trajectories.objectId, args.objectId))
    .all()
    .filter((t) => t.fileFormat === args.fileFormat)
    .map((t) => t.id);

  const hash = contentHash(args.raw);
  const same = previous.find(
    (t) => sameFormat.includes(t.id) && contentHash(t.fileText!) === hash,
  );
  if (same) {
    if (same.hasCovariance !== hasCovariance) {
      db.update(trajectories)
        .set({ hasCovariance })
        .where(eq(trajectories.id, same.id))
        .run();
    }
    return {
      trajectoryId: same.id,
      pointCount: same.pointCount,
      startAt: same.startAt ?? startAt,
      endAt: same.endAt ?? endAt,
      // Report the freshly computed value, not the stored flag: the flag's meaning
      // changed (from "every state has a matrix" to "some state does"), and a reused
      // row would otherwise keep reporting the old, stricter answer.
      hasCovariance,
      missingCovariance,
      reused: true,
    };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.insert(trajectories)
    .values({
      id,
      objectId: args.objectId,
      operatorId: args.operatorId,
      uploadType: "definitive",
      stateSource: args.stateSource,
      screenedStatus: "not_screened",
      fileFormat: args.fileFormat,
      startAt,
      endAt,
      pointCount,
      uploadedAt: now,
      createdAt: now,
      autoRelinquishPcThreshold: null,
      seq: nextSeq(sqlite, "trajectories"),
      hasCovariance,
      companionId: null,
    })
    .run();

  // The file goes in its own table; see `trajectoryFiles` for why.
  db.insert(trajectoryFiles).values({ trajectoryId: id, fileText: args.raw }).run();

  return {
    trajectoryId: id,
    pointCount,
    startAt,
    endAt,
    hasCovariance,
    missingCovariance,
    reused: false,
  };
}

/**
 * Recompute one object's `catalog` entry from what is stored for it.
 *
 * `catalog` is keyed `(object_id, state_source)`, so an object can hold several
 * rows; screening reads *all* of them when choosing partners, which would screen
 * the same pair once per source. So exactly one row per object is kept — the
 * reference returned by `selectReference` — and the rest remain in `trajectories`
 * for the accuracy report and for cross-checks.
 */
export function refreshCatalogEntry(objectId: string): void {
  const { db } = getDb();
  const rows = db
    .select({
      id: trajectories.id,
      stateSource: trajectories.stateSource,
      uploadedAt: trajectories.uploadedAt,
      startAt: trajectories.startAt,
      endAt: trajectories.endAt,
      pointCount: trajectories.pointCount,
    })
    .from(trajectories)
    .where(eq(trajectories.objectId, objectId))
    .all();

  const pick = selectReference(
    rows.map((r) => ({
      trajectoryId: r.id,
      stateSource: r.stateSource,
      uploadedAt: r.uploadedAt,
      pointCount: r.pointCount,
      spanMs:
        r.startAt && r.endAt
          ? new Date(r.endAt).getTime() - new Date(r.startAt).getTime()
          : undefined,
    })),
  );

  db.delete(catalog).where(eq(catalog.objectId, objectId)).run();
  if (!pick) return;

  db.insert(catalog)
    .values({
      objectId,
      stateSource: pick.stateSource,
      trajectoryId: pick.trajectoryId,
      updatedAt: new Date().toISOString(),
    })
    .run();
}

/** Point each feed's `companion_id` at the other. */
function link(feedA: string, feedB: string): void {
  const { db } = getDb();
  db.update(trajectories).set({ companionId: feedB }).where(eq(trajectories.id, feedA)).run();
  db.update(trajectories).set({ companionId: feedA }).where(eq(trajectories.id, feedB)).run();
}

/**
 * Ingest both vendor feeds for one Starlink object.
 *
 * The ITC is fetched from the manifest entry when one is supplied, and the OCM from
 * the direct path. Either may be skipped or may fail independently: an OCM-only
 * ingest still gives identity and a long arc, and is recorded with a warning that
 * Pc will be NULL.
 */
export async function ingestStarlinkObject(
  objectName: string,
  manifestEntry: ManifestEntry | null,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const log = opts.onLog ?? (() => {});
  const operatorId = ensureOperator(opts);
  const warnings: string[] = [];
  const feeds: IngestedFeed[] = [];

  let noradId: number | null = null;
  let objectId: string | null = null;

  // The manifest states the catalogue number directly, so identity is known even
  // when the OCM fetch fails. The OCM then re-confirms it via OBJECT_DESIGNATOR,
  // which is the authority; a mismatch means the manifest is stale and is
  // reported rather than silently preferred.
  if (manifestEntry?.noradId) noradId = manifestEntry.noradId;

  /**
   * Read a previously downloaded ephemeris, if one is complete.
   *
   * "Complete" means the file reaches its own terminator: `TRAJ_STOP` for an OCM,
   * or a final covariance row for an ITC. A truncated file is ignored (and reported)
   * rather than stored, because a short arc parses fine and would silently
   * narrow every later screening result.
   */
  const readCached = (name: string): string | null => {
    if (!opts.cacheDir) return null;
    const file = join(opts.cacheDir, `${name}.txt`);
    if (!existsSync(file)) return null;
    try {
      const text = readFileSync(file, "utf8");
      const isOcm = text.includes("CCSDS_OCM") || /^META_START/m.test(text);
      const complete = isOcm
        ? /^TRAJ_STOP/m.test(text)
        : /^ephemeris_start:/m.test(text);
      if (!complete) {
        log(`  ${name}: cached file is truncated, will re-download`);
        return null;
      }
      log(`  ${name}: using cached file (${(text.length / 1e6).toFixed(1)} MB)`);
      return text;
    } catch {
      return null;
    }
  };

  /** Read a pre-downloaded Modified ITC (`<name>.itc`), if complete. */
  const readCachedItc = (name: string): string | null => {
    if (!opts.cacheDir) return null;
    const file = join(opts.cacheDir, `${name}.itc`);
    if (!existsSync(file)) return null;
    try {
      const text = readFileSync(file, "utf8");
      if (!/^ephemeris_start:/m.test(text)) {
        log(`  ${name}: cached ITC is truncated, will re-download`);
        return null;
      }
      log(`  ${name}: using cached ITC (${(text.length / 1e6).toFixed(1)} MB)`);
      return text;
    } catch {
      return null;
    }
  };

  // --- OCM first: it is the only feed that states the catalogue number, so it
  // establishes identity before anything else is written.
  if (!opts.skipOcm) {
    try {
      const cachedOcm = readCached(objectName);
      const ocm = cachedOcm
        ? { ...parseStarlinkOcmHeader(cachedOcm), raw: cachedOcm }
        : await fetchStarlinkOcm(objectName, {
            timeoutMs: opts.timeoutMs ?? 180_000,
            retries: 1,
          });
      if (ocm.noradId !== null) {
        if (noradId !== null && noradId !== ocm.noradId) {
          warnings.push(
            `manifest NORAD ${noradId} disagrees with the OCM's ${ocm.noradId}; ` +
              `using the OCM value`,
          );
        }
        noradId = ocm.noradId;
      }

      objectId = ensureObject({
        objectName,
        operatorId,
        noradId,
        hardBodyRadiusM: 8.83,
      });

      const stored = storeTrajectory({
        objectId,
        operatorId,
        raw: ocm.raw,
        format: "ocm",
        fileFormat: "ocm",
        stateSource: "operator_ephemeris",
      });
      feeds.push({ feed: "ocm", ...stored });
      log(`  ${objectName} OCM: ${stored.pointCount} states${stored.reused ? " (unchanged)" : ""}`);

      if (!stored.hasCovariance) {
        warnings.push(
          "This OCM carries no covariance anywhere on its arc; Pc will be NULL unless the ITC companion supplies it.",
        );
      } else if (stored.missingCovariance > 0) {
        warnings.push(
          `${stored.missingCovariance} of ${stored.pointCount} OCM state(s) have a covariance ` +
            `matrix that is not positive semi-definite (negative eigenvalue) and were dropped. ` +
            `Pc is NULL at those epochs only; the states are kept.`,
        );
      }
    } catch (err) {
      warnings.push(`OCM fetch failed: ${(err as Error).message}`);
      log(`  ${objectName} OCM: FAILED ${(err as Error).message}`);
    }
  }

  // --- ITC: the only feed with covariance.
  if (!opts.skipItc && manifestEntry) {
    try {
      // The ITC lives beside the OCM as `<name>.itc` when it was pre-downloaded.
      const cachedItc = readCachedItc(objectName);
      const itc = cachedItc
        ? { raw: cachedItc }
        : await fetchEphemeris(manifestEntry, {
            timeoutMs: opts.timeoutMs ?? 180_000,
            retries: 1,
          });

      if (!objectId) {
        objectId = ensureObject({
          objectName,
          operatorId,
          noradId,
          hardBodyRadiusM: 8.83,
        });
      }

      const stored = storeTrajectory({
        objectId,
        operatorId,
        raw: itc.raw,
        format: "itc",
        fileFormat: "itc",
        stateSource: "operator_ephemeris",
      });
      feeds.push({ feed: "itc", ...stored });
      log(`  ${objectName} ITC: ${stored.pointCount} states${stored.reused ? " (unchanged)" : ""}`);

      if (!stored.hasCovariance) {
        warnings.push("ITC carried no covariance; Pc will be NULL.");
      }
    } catch (err) {
      warnings.push(`ITC fetch failed: ${(err as Error).message}`);
      log(`  ${objectName} ITC: FAILED ${(err as Error).message}`);
    }
  }

  if (!objectId) {
    throw new Error(`could not ingest ${objectName}: no feed succeeded`);
  }

  // Link the pair so a screening job can take states from one and covariance from
  // the other.
  const ocmFeed = feeds.find((f) => f.feed === "ocm");
  const itcFeed = feeds.find((f) => f.feed === "itc");
  if (ocmFeed && itcFeed) {
    link(ocmFeed.trajectoryId, itcFeed.trajectoryId);
  }

  const policy = sourcePolicy({
    objectName,
    operatorName: opts.operatorName ?? "Starlink",
    hasCovariance: feeds.some((f) => f.hasCovariance),
  });
  warnings.push(...policy.warnings);

  // Point `catalog` at the best feed for this object.
  //
  // Without this the data lands in `trajectories` and screening never sees it:
  // `enqueueScreening` pairs objects by reading `catalog`, so an empty catalog
  // means a full database and zero conjunctions — which is exactly what happened
  // after the first bulk import. See `catalog-policy.ts` for the selection rule.
  if (objectId) refreshCatalogEntry(objectId);

  return { objectId, objectName, noradId, feeds, warnings };
}
