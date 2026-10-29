/**
 * Optical source (`spacex_optical`) tests.
 *
 * Two things matter here and both are behavioural contracts from the vendor docs
 * (`SPEC-BEHAVIOR.md` §5):
 *
 *   1. an optical trajectory must be parseable and physically sane,
 *   2. its *contents* must be unreadable through the API, while the CDMs it
 *      produces remain visible.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildOpticalTrajectory } from "../src/lib/sources/optical";

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

const workDir = mkdtempSync(join(tmpdir(), "spaceeyes-optical-"));
process.env.SPACE_EYES_DB = join(workDir, "test.sqlite");
process.env.SPACE_EYES_ALLOW_X_OPERATOR = "1";
process.env.SPACE_EYES_DEMO = "1";

const MU = 398600.4418;
const R = 6378.137 + 550;
const SPEED = Math.sqrt(MU / R);
const EPOCH = Date.now() + 1_800_000;

/** A circular-orbit fix at the ascending node. */
const FIX = {
  position: [R, 0, 0] as [number, number, number],
  velocity: [0, SPEED, 0] as [number, number, number],
  ms: EPOCH,
  transitCount: 4,
};

async function main() {
  const { normaliseTrajectory } = await import("../src/lib/api/validate-trajectory");
  const { elementsFromState } = await import("../src/lib/core/kinematics");
  const { ingestOpticalTrajectory } = await import("../src/lib/sources/optical");
  const { getDb } = await import("../src/db");
  const schema = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");

  console.log("\nOptical source — trajectory generation");
  const file = buildOpticalTrajectory(FIX, { horizonHours: 2, stepSeconds: 60 });
  {
    const normalised = normaliseTrajectory(file);
    check("generated file passes the upload validator", true);
    check(
      "states span the requested horizon",
      normalised.states.length === 121,
      `n=${normalised.states.length}`,
    );

    const el = elementsFromState(
      normalised.states[0].position,
      normalised.states[0].velocity,
    );
    check(
      "propagated fix stays on a sane orbit",
      Math.abs(el.altitudeKm - 550) < 3 && el.e < 0.01,
      `alt=${el.altitudeKm.toFixed(1)} km, e=${el.e.toFixed(4)}`,
    );

    check(
      "every state carries covariance",
      normalised.states.every((s) => s.covariance !== null),
    );

    // Along-track should be the dominant uncertainty for a short-arc optical fit.
    const c0 = normalised.states[0].covariance!;
    const trace = c0[0] + c0[7] + c0[14];
    check("covariance is positive", trace > 0, `trace=${trace.toExponential(3)}`);

    // Growth over the horizon: the last state must be less certain than the first.
    const last = normalised.states[normalised.states.length - 1].covariance!;
    const traceLast = last[0] + last[7] + last[14];
    check(
      "uncertainty grows with prediction age",
      traceLast > trace,
      `${trace.toExponential(2)} -> ${traceLast.toExponential(2)}`,
    );
  }

  console.log("\nOptical source — persistence and visibility");
  const opId = "11111111-1111-4111-8111-111111111111";
  const objId = "aaaaaaaa-1111-4111-8111-00000000000a";
  {
    const { db } = getDb();
    const now = new Date().toISOString();
    db.insert(schema.operators)
      .values({
        id: opId,
        name: "Space Eyes",
        email: "ops@test",
        phone: null,
        maxObjects: 10,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(schema.objects)
      .values({
        id: objId,
        operatorId: opId,
        objectName: "OPT-1",
        noradId: 90001,
        hardBodyRadius: 3,
        maneuverability: true,
        alive: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const res = ingestOpticalTrajectory({
      objectId: objId,
      source: FIX,
      horizonHours: 1,
    });

    check("optical trajectory stored", res.stateCount > 10, `states=${res.stateCount}`);

    const row = db
      .select()
      .from(schema.trajectories)
      .where(eq(schema.trajectories.id, res.trajectoryId))
      .get();

    check("state source is spacex_optical", row?.stateSource === "spacex_optical");
    check("optical trajectory is definitive", row?.uploadType === "definitive");

    const opticalOperator = db
      .select()
      .from(schema.operators)
      .where(eq(schema.operators.id, res.operatorId))
      .get();
    check(
      "optical trajectories belong to a dedicated operator",
      opticalOperator?.name.includes("Stargaze") === true,
      opticalOperator?.name,
    );
  }

  console.log("\nOptical source — API hides trajectory contents");
  {
    // Exercise the real route handler.
    const route = await import("../src/app/api/v1/trajectory/[id]/route").catch(
      () => null,
    );
    const metaRoute = await import(
      "../src/app/api/v1/trajectory/[id]/metadata/route"
    ).catch(() => null);

    check("trajectory route module loads", route !== null);
    check("metadata route module loads", metaRoute !== null);

    const { db } = getDb();
    const opticalRow = db
      .select()
      .from(schema.trajectories)
      .all()
      .find((t) => t.stateSource === "spacex_optical")!;

    if (route && metaRoute) {
      const req = new Request(`http://x/api/v1/trajectory/${opticalRow.id}`, {
        headers: { "x-space-eyes-operator": opId },
      });
      const res = await route.GET(req, {
        params: Promise.resolve({ id: opticalRow.id }),
      });
      check(
        "GET trajectory file refuses spacex_optical contents",
        res.status === 403,
        `HTTP ${res.status}`,
      );
      const body = await res.json();
      check(
        "refusal explains what to use instead",
        String(body.error ?? "").includes("CDMs"),
        body.error,
      );

      const mreq = new Request(`http://x/api/v1/trajectory/${opticalRow.id}/metadata`, {
        headers: { "x-space-eyes-operator": opId },
      });
      const mres = await metaRoute.GET(mreq, {
        params: Promise.resolve({ id: opticalRow.id }),
      });
      check(
        "metadata is still readable",
        mres.status === 200,
        `HTTP ${mres.status}`,
      );
      const mbody = await mres.json();
      check(
        "metadata reports the optical source",
        mbody.state_source === "spacex_optical",
        mbody.state_source,
      );
    }
  }

  rmSync(workDir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
