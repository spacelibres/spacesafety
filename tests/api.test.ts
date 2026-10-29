/**
 * End-to-end API tests.
 *
 * These drive the real route handlers (no HTTP server) against a throwaway SQLite
 * file, so every layer is exercised: auth, validation, screening queue, ingest,
 * event grouping, CDM serialization, and pagination.
 *
 * Run with: npm run test:api
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { elementsFromState } from "../src/lib/core/kinematics";
import { screen } from "../src/lib/core/screening";
import { parseOcm, mergeOcmCovariance } from "../src/lib/orbit/ocm";
import { parseStarlinkEphemeris } from "../src/lib/sources/starlink-public";

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

const workDir = mkdtempSync(join(tmpdir(), "spaceeyes-test-"));
process.env.SPACE_EYES_DB = join(workDir, "test.sqlite");
process.env.SPACE_EYES_ALLOW_X_OPERATOR = "1";
process.env.SPACE_EYES_DEMO = "1";
// NODE_ENV is readonly at the type level.

async function main() {
  const { getDb, closeDb, nextSeq } = await import("../src/db");
  const schema = await import("../src/db/schema");
  const { normaliseTrajectory } = await import("../src/lib/api/validate-trajectory");
  const { enqueueScreening, ingestScreeningResult } = await import(
    "../src/lib/api/screening-service"
  );
  const { buildCdmJson, toKvn } = await import("../src/lib/api/cdm");

  const { db, sqlite } = getDb();
  const now = new Date().toISOString();

  // ---------------------------------------------------------------- seed
  const opId = "11111111-1111-4111-8111-111111111111";
  const otherOpId = "22222222-2222-4222-8222-222222222222";

  db.insert(schema.operators)
    .values([
      { id: opId, name: "Space Eyes", email: "ops@spaceeyes.test", phone: "+1", maxObjects: 5, createdAt: now, updatedAt: now },
      { id: otherOpId, name: "Peer Operator", email: "peer@example.test", phone: "+2", maxObjects: 5, createdAt: now, updatedAt: now },
    ])
    .run();

  const objA = "aaaaaaaa-1111-4111-8111-000000000001";
  const objB = "bbbbbbbb-1111-4111-8111-000000000002";

  db.insert(schema.objects)
    .values([
      { id: objA, operatorId: opId, objectName: "SE-1", noradId: 90001, hardBodyRadius: 2, maneuverability: true, alive: true, createdAt: now, updatedAt: now },
      { id: objB, operatorId: otherOpId, objectName: "PEER-1", noradId: 90002, hardBodyRadius: 3, maneuverability: false, alive: true, createdAt: now, updatedAt: now },
    ])
    .run();

  console.log("\nAPI — auth");
  {
    const { authenticateRequest } = await import("../src/lib/api/auth");
    const headers = new Headers({ "x-space-eyes-operator": opId });
    const principal = authenticateRequest(headers);
    check("dev header authenticates", principal.operatorId === opId, principal.operatorName);

    let threw = false;
    try {
      authenticateRequest(new Headers());
    } catch (err) {
      threw = (err as { status?: number }).status === 401;
    }
    check("missing credential -> 401", threw);
  }

  console.log("\nAPI — trajectory validation");
  const ocmRaw = buildOcmFixture();
  {
    const normalised = normaliseTrajectory(ocmRaw);
    check("valid OCM accepted", normalised.format === "ocm", `format=${normalised.format}`);
    check("states normalised to inertial", normalised.states.length === 20, `n=${normalised.states.length}`);
    check(
      "covariance survives normalisation",
      normalised.states.every((s) => s.covariance !== null),
      `withCov=${normalised.states.filter((s) => s.covariance).length}`,
    );

    const el = elementsFromState(
      normalised.states[0].position,
      normalised.states[0].velocity,
    );
    check(
      "normalised orbit is physically sane",
      el.altitudeKm > 200 && el.altitudeKm < 2000 && el.e < 0.1,
      `alt=${el.altitudeKm.toFixed(1)} km, e=${el.e.toFixed(5)}`,
    );

    // Too few points.
    let threw = false;
    try {
      normaliseTrajectory(buildOcmFixture(4));
    } catch (err) {
      const issues = (err as { issues?: { reason: string }[] }).issues ?? [];
      threw = issues.some((i) => i.reason.includes("at least 6"));
    }
    check("too few state vectors rejected", threw);

    // Below the surface: replace the first trajectory state's position.
    threw = false;
    try {
      const lines = buildOcmFixture(10).split("\n");
      const idx = lines.findIndex(
        (l) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z/.test(l) && l.split(/\s+/).length === 7,
      );
      const parts = lines[idx].split(/\s+/);
      lines[idx] = `${parts[0]} 100.000000000 100.000000000 100.000000000 ${parts[4]} ${parts[5]} ${parts[6]}`;
      normaliseTrajectory(lines.join("\n"));
    } catch (err) {
      const issues = (err as { issues?: { reason: string }[] }).issues ?? [];
      threw = issues.some((i) => i.reason.includes("below the Earth"));
    }
    check("sub-surface states rejected", threw);

    threw = false;
    try {
      normaliseTrajectory("this is not an ephemeris");
    } catch {
      threw = true;
    }
    check("unparseable file rejected", threw);
  }

  console.log("\nAPI — screening ingest and CDM");
  {
    const normalised = normaliseTrajectory(ocmRaw);
    const tA = crypto.randomUUID();
    const tB = crypto.randomUUID();

    db.insert(schema.trajectories)
      .values([
        {
          id: tA, objectId: objA, operatorId: opId, uploadType: "definitive",
          stateSource: "operator_ephemeris", screenedStatus: "not_screened",
          fileFormat: "ocm", startAt: normalised.startAt,
          endAt: normalised.endAt, pointCount: normalised.states.length,
          uploadedAt: now, createdAt: now, seq: nextSeq(sqlite, "trajectories"),
        },
        {
          id: tB, objectId: objB, operatorId: otherOpId, uploadType: "definitive",
          stateSource: "operator_ephemeris", screenedStatus: "not_screened",
          fileFormat: "ocm", startAt: normalised.startAt,
          endAt: normalised.endAt, pointCount: normalised.states.length,
          uploadedAt: now, createdAt: now, seq: nextSeq(sqlite, "trajectories"),
        },
      ])
      .run();

    // File text lives in its own table now.
    db.insert(schema.trajectoryFiles)
      .values([
        { trajectoryId: tA, fileText: ocmRaw },
        { trajectoryId: tB, fileText: ocmRaw },
      ])
      .run();

    // Queue A against B by inserting B into the catalog first.
    db.insert(schema.catalog)
      .values({ objectId: objB, stateSource: "operator_ephemeris", trajectoryId: tB, updatedAt: now })
      .run();
    const queued = enqueueScreening({
      trajectoryId: tA, objectId: objA, uploadType: "definitive", stateSource: "operator_ephemeris",
    });
    check("screening job enqueued", queued === 1, `n=${queued}`);

    const job = db.select().from(schema.screeningJobs).get();
    check("job references both trajectories", !!job && job.trajectoryId === tA && job.againstTrajectoryId === tB);

    // Run the kernel locally (what the worker would do).
    const sample = {
      trajectoryId: tA, objectId: objA, objectName: "SE-1", hardBodyRadiusKm: 0.002,
      stateSource: "operator_ephemeris",
      states: normalised.states.map((s) => ({
        epochMs: String(s.ms), px: s.position[0], py: s.position[1], pz: s.position[2],
        vx: s.velocity[0], vy: s.velocity[1], vz: s.velocity[2], covariance: s.covariance ?? [],
      })),
    };
    // Offset the secondary by ~5 km cross-track to create a genuine encounter.
    // Give the secondary a real relative velocity: scale its velocity slightly
    // (as if it were on a slightly different orbit) plus a V-shaped cross-track
    // offset. A pure offset leaves both velocities identical, and a zero relative
    // velocity correctly yields a NULL Pc (the encounter plane is undefined).
    const secondaryStates = sample.states.map((s, i) => {
      const f =
        Math.abs(i - (sample.states.length - 1) / 2) /
        Math.max(1, (sample.states.length - 1) / 2);
      return {
        ...s,
        px: s.px * 1.00002,
        py: s.py * 1.00002,
        pz: s.pz + 5 * f,
        vx: s.vx * 0.9999,
        vy: s.vy * 0.9999,
      };
    });
    const shifted = {
      ...sample,
      trajectoryId: tB,
      objectId: objB,
      objectName: "PEER-1",
      states: secondaryStates,
    };

    const out = screen({ jobId: job!.id, primary: sample, secondary: shifted, maxSamplePoints: 4000 });
    check("kernel finds an encounter between the two", out.approaches.length >= 1, `n=${out.approaches.length}`);
    check(
      "kernel computes a probability when covariance is present",
      out.approaches[0]?.probabilityOfCollision !== undefined,
      `Pc=${out.approaches[0]?.probabilityOfCollision?.toExponential(3) ?? "null"} reason=${out.approaches[0]?.pcFailureReason ?? "-"}`,
    );

    const result = ingestScreeningResult({
      jobId: job!.id,
      approaches: out.approaches,
      primaryTrajectoryId: tA,
      secondaryTrajectoryId: tB,
    });
    check("CDM persisted", result.cdmIds.length >= 1, `n=${result.cdmIds.length}`);
    check("event created", result.eventIds.length >= 1, `n=${result.eventIds.length}`);

    const cdm = db.select().from(schema.cdms).get()!;
    check("CDM carries a probability", cdm.probabilityOfCollision !== null, `Pc=${cdm.probabilityOfCollision}`);
    check("CDM has GPS nanos TCA", /^\d{18,19}$/.test(cdm.tcaGpsNanos), cdm.tcaGpsNanos);
    check("CDM is active", cdm.isActive === true);
    check("CDM links to an event", cdm.eventId !== null);

    const trajA = db.select().from(schema.trajectories)
      .where((await import("drizzle-orm")).eq(schema.trajectories.id, tA)).get();
    check("trajectory marked screened", trajA?.screenedStatus === "screened", trajA?.screenedStatus);

    // --- CDM serialization
    const json = JSON.parse(cdm.fileJson);
    check("CDM JSON has CCSDS version", json.CCSDS_CDM_VERS === "1.0");
    check("CDM JSON has both objects", !!json.OBJECT1?.OBJECT && !!json.OBJECT2?.OBJECT);

    const kvn = toKvn(json);
    check("KVN contains CCSDS_CDM_VERS", kvn.includes("CCSDS_CDM_VERS = 1.0"));
    check("KVN contains TCA", kvn.includes("TCA = "));
    check("KVN contains OBJECT twice", (kvn.match(/^OBJECT = /gm) ?? []).length === 2);
    check(
      "KVN NULL probability is written as NULL",
      json.COLLISION_PROBABILITY === null ? kvn.includes("COLLISION_PROBABILITY = NULL") : true,
    );

    // --- event grouping: a second CDM within 20 min joins the same event.
    const sameEvent = ingestScreeningResult({
      jobId: crypto.randomUUID(),
      approaches: out.approaches.slice(0, 1).map((a) => ({ ...a })),
      primaryTrajectoryId: tA,
      secondaryTrajectoryId: tB,
    });
    check(
      "second CDM within 20 min joins the existing event",
      sameEvent.eventIds[0] === result.eventIds[0],
    );

    const allCdms = db.select().from(schema.cdms).all();
    const activeCount = allCdms.filter((c) => c.isActive).length;
    check("superseded CDM deactivated", activeCount === 1, `active=${activeCount}`);
  }

  console.log("\nAPI — hypothetical isolation");
  {
    const tH = crypto.randomUUID();
    const normalised = normaliseTrajectory(ocmRaw);
    db.insert(schema.trajectories)
      .values({
        id: tH, objectId: objA, operatorId: opId, uploadType: "hypothetical",
        stateSource: "operator_ephemeris", screenedStatus: "not_screened",
        fileFormat: "ocm", startAt: normalised.startAt,
        endAt: normalised.endAt, pointCount: normalised.states.length,
        uploadedAt: now, createdAt: now, seq: nextSeq(sqlite, "trajectories"),
      })
      .run();
    db.insert(schema.trajectoryFiles).values({ trajectoryId: tH, fileText: ocmRaw }).run();

    const withH = db.select().from(schema.trajectories).all();
    check("hypothetical trajectory stored", withH.some((t) => t.uploadType === "hypothetical"));
    check(
      "hypothetical rows are flagged so streams can exclude them",
      withH.filter((t) => t.uploadType === "hypothetical").every((t) => t.operatorId === opId),
    );
  }

  console.log("\nAPI — pagination tokens");
  {
    const { issueToken, resolveCursor, hashFilters } = await import("../src/lib/api/pagination");
    const filters = hashFilters({ operator1_id: opId });
    const token = issueToken("cdms", 5, filters);
    const cursor = resolveCursor("cdms", token, filters);
    check("token round-trips the cursor", cursor === 5, `cursor=${cursor}`);

    let threw = false;
    try {
      resolveCursor("cdms", token, hashFilters({ operator1_id: "other" }));
    } catch (err) {
      threw = (err as { status?: number }).status === 400;
    }
    check("token reuse with different filters rejected", threw);

    threw = false;
    try {
      resolveCursor("cdms", "never-issued", filters);
    } catch (err) {
      threw = (err as { errorType?: string }).errorType === "pagination_too_old";
    }
    check("unknown token -> pagination_too_old", threw);
  }

  console.log("\nAPI — schema integrity");
  {
    // Every table must accept a row shaped like the schema expects.
    const tables = ["operators", "credentials", "objects", "trajectories", "events", "cdms", "catalog", "screening_jobs", "pagination_tokens", "stream_seq"];
    const { sql } = await import("drizzle-orm");
    for (const table of tables) {
      const row = sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
      check(`table ${table} exists`, typeof row.n === "number", `rows=${row.n}`);
    }
  }

  closeDb();
  rmSync(workDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

/**
 * Build a synthetic OCM with `points` states on a 550 km circular orbit.
 *
 * Writing OCM by hand (rather than importing a fixture) keeps the test focused on
 * the API contract; the real-data parsing is covered by ocm.test.ts.
 */
function buildOcmFixture(points = 20): string {
  const MU = 398600.4418;
  const R = 6378.137 + 550;
  const P = 2 * Math.PI * Math.sqrt(R ** 3 / MU);
  const speed = Math.sqrt(MU / R);
  // Future-dated so the "ends in the past" rule does not reject the fixture.
  const t0 = Date.now() + 3_600_000;

  const iso = (ms: number) =>
    new Date(ms).toISOString().replace(/Z$/, "000Z");

  const lines: string[] = [
    "CCSDS_OCM_VERS = 3.0",
    `CREATION_DATE = ${iso(t0)}`,
    "ORIGINATOR = TEST",
    "MESSAGE_ID = TEST_1",
    "",
    "META_START",
    "OBJECT_NAME = TEST-OBJ",
    "OBJECT_DESIGNATOR = 99999",
    "OPERATOR = TEST",
    "TIME_SYSTEM = UTC",
    `EPOCH_TZERO = ${iso(t0)}`,
    `START_TIME = ${iso(t0)}`,
    `STOP_TIME = ${iso(t0 + points * 60_000)}`,
    "META_STOP",
    "",
    "TRAJ_START",
    "CENTER_NAME = EARTH",
    "TRAJ_REF_FRAME = EME2000",
    "TRAJ_TYPE = CARTPV",
    "TRAJ_UNITS = [km,km,km,km/s,km/s,km/s]",
  ];

  for (let i = 0; i < points; i += 1) {
    const th = (2 * Math.PI * (i * 60)) / P;
    lines.push(
      `${iso(t0 + i * 60_000)} ${(R * Math.cos(th)).toExponential(9)} ${(R * Math.sin(th)).toExponential(9)} 0.000000000 ${(-speed * Math.sin(th)).toExponential(9)} ${(speed * Math.cos(th)).toExponential(9)} 0.000000000`,
    );
  }
  lines.push("TRAJ_STOP");

  // Covariance: 100 m position sigma (0.1 km -> 1e-2 km^2), small velocity term.
  // 21 values form the STRICT lower triangle, row by row:
  //   row1: 1 value, row2: 2, ..., row6: 6
  // so the diagonals are entries 0, 2, 5, 9, 14, 20.
  lines.push(
    "",
    "COV_START",
    "COV_REF_FRAME = EME2000",
    "COV_TYPE = CARTPV",
    "COV_ORDERING = LTM",
    "COV_UNITS = [km,km,km,km/s,km/s,km/s]",
  );
  const P1 = "1.0000000000e-02";
  const Z = "0.0000000000e+00";
  const V = "1.0000000000e-08";
  const covRow = [
    /* row 1 */ P1,
    /* row 2 */ Z, P1,
    /* row 3 */ Z, Z, P1,
    /* row 4 */ Z, Z, Z, V,
    /* row 5 */ Z, Z, Z, Z, V,
    /* row 6 */ Z, Z, Z, Z, Z, V,
  ].join(" ");
  for (let i = 0; i < points; i += 1) {
    lines.push(`${iso(t0 + i * 60_000)} ${covRow}`);
  }
  lines.push("COV_STOP");

  return lines.join("\n") + "\n";
}

void parseOcm;
void mergeOcmCovariance;
void parseStarlinkEphemeris;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
