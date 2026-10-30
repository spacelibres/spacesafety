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

import { SCHEMA_DDL } from "../src/db/ddl";
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

/**
 * An in-memory database built from the **real** schema.
 *
 * This used to be a hand-copied subset of the tables, and it drifted exactly as
 * you would expect: `source_fetches` gained `etag` / `last_modified` in
 * `src/db/index.ts` and not here, so `ledger.finish()` died on
 * `no such column: etag` while the production database was fine.
 * `SCHEMA_DDL` is the single definition; the fixture cannot disagree with it.
 */
function ledgerDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_DDL);
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

  // ---- validators: what the next poll sends back -----------------------------
  console.log("\nconditional-request validators");
  const none = ledger.lastValidators("space-track-gp");
  check("no validator before any capture", none.etag === null && none.lastModified === null);

  const first = ledger.begin("space-track-gp", 3);
  ledger.finish(first, {
    sourceId: "space-track-gp",
    status: "ok",
    bytes: 1234,
    etag: '"abc123"',
    lastModified: "Thu, 30 Oct 2026 00:00:00 GMT",
  });
  const stored = ledger.lastValidators("space-track-gp");
  check("a successful capture stores its validators", stored.etag === '"abc123"', String(stored.etag));
  check(
    "and the Last-Modified alongside it",
    stored.lastModified === "Thu, 30 Oct 2026 00:00:00 GMT",
    String(stored.lastModified),
  );

  // A 304 carries the same validator forward. Losing it would mean the next poll
  // had nothing to compare and would transfer the body again.
  const second = ledger.begin("space-track-gp", 4);
  ledger.finish(second, {
    sourceId: "space-track-gp",
    status: "unchanged",
    bytes: 0,
    etag: '"abc123"',
    lastModified: "Thu, 30 Oct 2026 00:00:00 GMT",
  });
  check(
    "304 keeps the validator for the next poll",
    ledger.lastValidators("space-track-gp").etag === '"abc123"',
  );

  // A failure must never contribute a validator: it describes bytes we did not get.
  const failed = ledger.begin("spacebook-eop", 5);
  ledger.finish(failed, { sourceId: "spacebook-eop", status: "failed", error: "timeout" });
  const afterFail = ledger.lastValidators("spacebook-eop");
  check("a failed capture yields no validator", afterFail.etag === null && afterFail.lastModified === null);

  // A host that sends no validator at all (all four vendors today) must simply
  // report null, so the next request goes out unconditional instead of 304-ing
  // against a validator the server never issued.
  const plain = ledger.begin("spacebook-omm-json", 6);
  ledger.finish(plain, { sourceId: "spacebook-omm-json", status: "ok", bytes: 30_371_355 });
  const plainV = ledger.lastValidators("spacebook-omm-json");
  check("a capture without validators stores none", plainV.etag === null && plainV.lastModified === null);

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

  // An OCM that states no epoch must not become the comparison's clock. Doing so
  // made `jointMs` NaN, nulled every position, and reported 526 of 1 492 objects
  // as unpropagatable when their element sets agreed perfectly.
  const ocmNoEpoch = compareSources(
    44714,
    [
      state(44714, "space-track", base),
      { ...state(44714, "spacebook-omm", sameB), epoch: null },
      { ...state(44714, "starlink-ocm", base), epoch: null, inclination: null },
    ],
    new Map([
      ["space-track", base],
      ["spacebook-omm", sameB],
    ]),
    { ocm: new Map([["starlink-ocm", sampler]]) },
  );
  check(
    "an epochless source is never the reference",
    ocmNoEpoch.referenceSource !== "starlink-ocm",
    ocmNoEpoch.referenceSource,
  );
  check(
    "and the comparison still produces a position",
    ocmNoEpoch.worstDeltaKm !== null,
    String(ocmNoEpoch.worstDeltaKm),
  );
  check(
    "so the object is not reported as unpropagatable",
    ocmNoEpoch.verdict !== "unpropagatable",
    ocmNoEpoch.verdict,
  );

  // Phase error is the headline number for an aged pair.
  check(
    "a stale pair reports a phase error in minutes",
    aged.worstPhaseMinutes !== null && aged.worstPhaseMinutes > 0,
    `${aged.worstPhaseMinutes?.toFixed(1)} min`,
  );

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
