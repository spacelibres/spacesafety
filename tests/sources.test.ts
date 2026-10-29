/**
 * Multi-source registry, ledger and comparison.
 *
 * The comparison tests are the important ones. They pin down three behaviours
 * that were each a real bug during development:
 *
 *   1. **Two feeds at the same epoch must agree.** Spacebook's OMM and
 *      Space-Track's `gp` publish identical elements for the same object, so any
 *      separation there is a defect, not ageing. An early version excused it.
 *   2. **Ageing must be measured in km/day, not km.** A STARLINK element set
 *      3 days old is legitimately 4 000 km off; calling that "suspect" made 57%
 *      of the catalogue look broken.
 *   3. **A large separation has a cause.** Debris diverges quickly and high
 *      orbits diverge under drag-free propagation, so the reason is classified
 *      rather than left to the reader of a kilometre count.
 *
 * The ledger tests check that two sources storing the same object do not
 * overwrite one another — the bug that made cross-checking impossible.
 */

import Database from "better-sqlite3";

import type { Tle } from "../src/lib/orbit/tle";
import { compareSources, summarize, type OcmSampler } from "../src/lib/sources/compare";
import { SourceLedger } from "../src/lib/sources/ledger";
import {
  SOURCES,
  credentialVars,
  hasCredentials,
  isDue,
  pickTrajectorySource,
  sourceById,
  trajectorySources,
} from "../src/lib/sources/registry";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
  }
}

/** A TLE whose elements are specified directly, so a test can vary one field. */
function tleAt(opts: {
  noradId: number;
  epochMs: number;
  inclinationDeg?: number;
  meanMotionRevPerDay?: number;
  meanAnomalyDeg?: number;
}): Tle {
  const norad = opts.noradId;
  const epoch = new Date(opts.epochMs);
  const yy = String(epoch.getUTCFullYear()).slice(2);
  const dayOfYear =
    (Date.UTC(epoch.getUTCFullYear(), epoch.getUTCMonth(), epoch.getUTCDate()) -
      Date.UTC(epoch.getUTCFullYear(), 0, 1)) /
      86_400_000 +
    1;
  const frac = (dayOfYear + epoch.getUTCHours() / 24).toFixed(8).padStart(12, "0");

  const mm = (opts.meanMotionRevPerDay ?? 15.68).toFixed(8).padStart(11, "0");
  const inc = (opts.inclinationDeg ?? 53.14).toFixed(4).padStart(8);
  const ma = (opts.meanAnomalyDeg ?? 100).toFixed(4).padStart(8);

  const line1Body = `1 ${String(norad).padStart(5, "0")}U 19074B   ${yy}${frac}  .00032843  00000-0  29201-3 0  999`;
  const line2Body = `2 ${String(norad).padStart(5, "0")} ${inc} 141.5664 0002090 160.3523 ${ma} ${mm}    1`;
  const line1 = `${line1Body}${checksum(line1Body)}`;
  const line2 = `${line2Body}${checksum(line2Body)}`;

  return {
    noradId: norad,
    name: null,
    classification: "U",
    intlDesignator: "19074B",
    epochMs: opts.epochMs,
    inclinationDeg: opts.inclinationDeg ?? 53.14,
    raanDeg: 141.5664,
    eccentricity: 0.000209,
    argPerigeeDeg: 160.3523,
    meanAnomalyDeg: opts.meanAnomalyDeg ?? 100,
    meanMotionRevPerDay: opts.meanMotionRevPerDay ?? 15.68,
    revNumber: 1,
    elementSetNumber: 1,
    bstar: 0.00029201,
    meanMotionDot: 0.00032843,
    meanMotionDdot: 0,
    line1,
    line2,
  } as Tle;
}

function checksum(line: string): string {
  let sum = 0;
  for (const ch of line) {
    if (ch >= "0" && ch <= "9") sum += Number(ch);
    else if (ch === "-") sum += 1;
  }
  return String(sum % 10);
}

function state(noradId: number, sourceId: string, tle: Tle) {
  return {
    noradId,
    sourceId,
    epoch: new Date(tle.epochMs).toISOString(),
    inclination: tle.inclinationDeg,
    raan: tle.raanDeg,
    eccentricity: tle.eccentricity,
    argPerigee: tle.argPerigeeDeg,
    meanAnomaly: tle.meanAnomalyDeg,
    meanMotion: tle.meanMotionRevPerDay,
    bstar: tle.bstar ?? null,
  };
}

function ledgerDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE data_sources (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL, format TEXT NOT NULL,
      credential_env TEXT, refresh_minutes INTEGER NOT NULL DEFAULT 120,
      enabled INTEGER NOT NULL DEFAULT 1, notes TEXT, last_success_at TEXT,
      last_attempt_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE source_fetches (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, started_at TEXT NOT NULL,
      finished_at TEXT, status TEXT NOT NULL DEFAULT 'running', bytes INTEGER,
      records INTEGER, path TEXT, sha256 TEXT, error TEXT, seq INTEGER NOT NULL
    );
    CREATE INDEX source_fetches_source_idx ON source_fetches(source_id, started_at);
    CREATE INDEX source_fetches_seq_idx ON source_fetches(seq);
    CREATE TABLE object_sources (
      norad_id INTEGER NOT NULL, source_id TEXT NOT NULL, epoch TEXT, inclination REAL,
      raan REAL, eccentricity REAL, arg_perigee REAL, mean_anomaly REAL,
      mean_motion REAL, bstar REAL, pos_x REAL, pos_y REAL, pos_z REAL,
      delta_km REAL, fetched_at TEXT NOT NULL, PRIMARY KEY (norad_id, source_id)
    );
    CREATE INDEX object_sources_source_idx ON object_sources(source_id, norad_id);
    CREATE INDEX object_sources_norad_idx ON object_sources(norad_id);
  `);
  return db;
}

function main() {
  // ---- 1. registry ---------------------------------------------------------
  console.log("\nregistry");
  check("every source has a unique id", new Set(SOURCES.map((s) => s.id)).size === SOURCES.length);
  check("space-track is credentialed", sourceById("space-track")?.kind === "credentialed");
  check(
    "credential vars derive from the prefix",
    credentialVars(sourceById("space-track")!).user === "SPACE_SAFETY_SPACETRACK_USER",
  );
  check(
    "missing credentials are detected",
    !hasCredentials(sourceById("space-track")!, {} as NodeJS.ProcessEnv),
  );
  check(
    "present credentials are detected",
    hasCredentials(sourceById("space-track")!, {
      SPACE_SAFETY_SPACETRACK_USER: "u",
      SPACE_SAFETY_SPACETRACK_PASS: "p",
    } as unknown as NodeJS.ProcessEnv),
  );
  check(
    "public sources need no credentials",
    hasCredentials(sourceById("spacebook-xp-tle")!, {} as NodeJS.ProcessEnv),
  );

  // Cadence: 2-hour source not due after 1 h, due after 3 h.
  const st = sourceById("space-track")!;
  const now = Date.parse("2026-10-29T12:00:00Z");
  check("due when never fetched", isDue(st, null, now));
  check("not due 1 h after a 2 h source", !isDue(st, "2026-10-29T11:00:00Z", now));
  check("due 3 h after a 2 h source", isDue(st, "2026-10-29T09:00:00Z", now));
  check(
    "daily source not due after 12 h",
    !isDue(sourceById("spacebook-satcat")!, "2026-10-29T00:00:00Z", now),
  );

  // Precedence: an OCM must beat every element set, whatever the order given.
  check(
    "OCM outranks every TLE source",
    pickTrajectorySource(["spacebook-xp-tle", "space-track", "starlink-ocm"])?.id ===
      "starlink-ocm",
  );
  check(
    "Space-Track outranks Spacebook TLE",
    pickTrajectorySource(["spacebook-xp-tle", "space-track"])?.id === "space-track",
  );
  check(
    "unknown sources fall back to nothing",
    pickTrajectorySource(["nonsense"]) === undefined,
  );
  check(
    "trajectory sources are ordered by priority",
    trajectorySources().every((s, i, all) => i === 0 || all[i - 1].trajectoryPriority <= s.trajectoryPriority),
  );

  // ---- 2. ledger -----------------------------------------------------------
  console.log("\nledger");
  const db = ledgerDb();
  const ledger = new SourceLedger(db, () => "2026-10-29T12:00:00.000Z");
  check("registry seeded", ledger.seedRegistry() === SOURCES.length);

  const fetchId = ledger.begin("space-track", 1);
  ledger.finish(fetchId, { sourceId: "space-track", status: "ok", records: 42, bytes: 1000 });
  check(
    "success updates last_success_at",
    ledger.lastSuccess().get("space-track") === "2026-10-29T12:00:00.000Z",
  );

  const failId = ledger.begin("spacebook-omm", 2);
  ledger.finish(failId, { sourceId: "spacebook-omm", status: "failed", error: "timeout" });
  const ommlast = ledger.lastSuccess().get("spacebook-omm");
  const ommerr = db
    .prepare("SELECT last_error AS e FROM data_sources WHERE id = 'spacebook-omm'")
    .get() as { e: string };
  check("failure does not set last_success_at", ommlast === null);
  check("failure records the error", ommerr.e === "timeout", String(ommerr.e));

  // The critical property: two sources, one object, both rows survive.
  ledger.upsertObjectStates([
    {
      noradId: 44714,
      sourceId: "space-track",
      epoch: "2026-10-28T06:47:15.987Z",
      inclination: 53.1436,
      raan: 141.5,
      eccentricity: 0.0002,
      argPerigee: 160,
      meanAnomaly: 199,
      meanMotion: 15.6823168,
      bstar: 0.00029,
    },
  ]);
  ledger.upsertObjectStates([
    {
      noradId: 44714,
      sourceId: "spacebook-xp-tle",
      epoch: "2026-10-25T01:25:53.717Z",
      inclination: 53.1447,
      raan: 141.5,
      eccentricity: 0.0002,
      argPerigee: 160,
      meanAnomaly: 199,
      meanMotion: 15.67874247,
      bstar: 0.00029,
    },
  ]);
  check("both sources keep their own row", ledger.sourceCount(44714) === 2);
  check(
    "the second write did not overwrite the first",
    (db
      .prepare("SELECT mean_motion AS m FROM object_sources WHERE norad_id = 44714 AND source_id = 'space-track'")
      .get() as { m: number }).m === 15.6823168,
  );
  const coverage = ledger.coverage();
  check("coverage reports one object per source", coverage.length === 2 && coverage.every((c) => c.objects === 1));
  db.close();

  // ---- 3. comparison -------------------------------------------------------
  console.log("\ncomparison");
  const epoch = Date.parse("2026-10-28T06:47:15.987Z");
  const base = tleAt({ noradId: 44714, epochMs: epoch });

  // Two sources, same elements, same epoch: must agree exactly.
  const sameA = tleAt({ noradId: 44714, epochMs: epoch });
  const sameB = tleAt({ noradId: 44714, epochMs: epoch });
  const identical = compareSources(
    44714,
    [state(44714, "space-track", sameA), state(44714, "spacebook-omm", sameB)],
    new Map([
      ["space-track", sameA],
      ["spacebook-omm", sameB],
    ]),
  );
  check("identical elements at the same epoch agree", identical.verdict === "agree", identical.reason);
  check("separation is zero", (identical.worstDeltaKm ?? -1) < 1e-6, `${identical.worstDeltaKm}`);

  // Same epoch, different mean motion: a real disagreement, must be suspect.
  const drift = tleAt({ noradId: 44714, epochMs: epoch, meanMotionRevPerDay: 15.9 });
  const mismatch = compareSources(
    44714,
    [state(44714, "space-track", base), state(44714, "spacebook-omm", drift)],
    new Map([
      ["space-track", base],
      ["spacebook-omm", drift],
    ]),
  );
  check("same epoch with different elements is suspect", mismatch.verdict === "suspect", mismatch.reason);
  check(
    "and the cause is classified as a real mismatch",
    mismatch.suspectCause === "same-epoch-disagreement",
    String(mismatch.suspectCause),
  );

  // Three days apart: large separation, but normal ageing for LEO.
  const old = tleAt({ noradId: 44714, epochMs: epoch - 3 * 86_400_000 });
  const aged = compareSources(
    44714,
    [state(44714, "space-track", base), state(44714, "spacebook-xp-tle", old)],
    new Map([
      ["space-track", base],
      ["spacebook-xp-tle", old],
    ]),
  );
  check(
    "a 3-day-old element set is stale, not suspect",
    aged.verdict === "stale" || aged.verdict === "agree",
    `${aged.verdict}: ${aged.reason}`,
  );
  check(
    "and it is measured as a drift rate",
    aged.worstDriftPerDay !== null && aged.worstDriftPerDay > 0,
    `${aged.worstDriftPerDay?.toFixed(1)} km/day`,
  );

  // A single source cannot be cross-checked.
  const single = compareSources(1, [state(1, "space-track", base)], new Map([["space-track", base]]));
  check("a single source is reported as such", single.verdict === "single-source", single.reason);

  // Debris elsewhere in the catalogue must be labelled, not left unexplained.
  // The two feeds are given different epochs, because the whole point is to
  // distinguish "aged element set" from "real mismatch": at the same epoch the
  // disagreement is a mismatch whatever the object class.
  const debris = compareSources(
    26671,
    [state(26671, "space-track", base), state(26671, "spacebook-xp-tle", old)],
    new Map([
      ["space-track", base],
      ["spacebook-xp-tle", old],
    ]),
    { objectType: "DEBRIS", agreeKmPerDay: 1, staleKmPerDay: 1 },
  );
  check(
    "debris divergence is classified",
    debris.verdict !== "suspect" || debris.suspectCause === "uncontrolled-object",
    `${debris.verdict}/${debris.suspectCause}`,
  );

  // An OCM becomes the reference even when a TLE claims a newer epoch.
  const ocmPos: [number, number, number] = [7000, 0, 0];
  const sampler: OcmSampler = {
    sourceId: "starlink-ocm",
    startMs: epoch,
    stopMs: epoch + 7 * 86_400_000,
    positionAt: () => ocmPos,
  };
  const withOcm = compareSources(
    44714,
    [state(44714, "space-track", base), { ...state(44714, "starlink-ocm", base), inclination: null }],
    new Map([["space-track", base]]),
    { ocm: new Map([["starlink-ocm", sampler]]) },
  );
  check("OCM is chosen as the reference", withOcm.referenceSource === "starlink-ocm", withOcm.referenceSource);
  check("the TLE is measured against it", (withOcm.worstDeltaKm ?? 0) > 0);

  // Summaries must not lose the counts.
  const s = summarize([identical, mismatch, aged, single, debris]);
  check("summary counts every verdict", s.compared === 5, `${s.compared}`);
  check(
    "summary tallies match the inputs",
    s.agree + s.stale + s.suspect + s.singleSource + s.unpropagatable === 5,
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();

export {};
