/**
 * Route-handler contract tests for the endpoints the vendor documents.
 *
 * ## Why this file exists
 *
 * `tests/api.test.ts` says it drives "the real route handlers", but it does not:
 * it calls the auth, screening and serialisation modules directly. So nothing in
 * the suite ever executed a `route.ts` — which is why a dangling comma in a SQL
 * template could turn `/catalogue` into a 500 while every suite stayed green
 * (that one was caught by `tests/wide-query.test.ts` reading the module's SQL).
 *
 * These tests call the handlers themselves, with a `Request`, against a
 * throwaway database, and assert the shape and the visibility rules the official
 * snapshot documents.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void, detail = ""): void {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
    console.log(`       ${(err as Error).message}`);
  }
}

const workDir = mkdtempSync(join(tmpdir(), "spacesafety-contract-"));
process.env.SPACE_SAFETY_DB = join(workDir, "contract.sqlite");
process.env.SPACE_SAFETY_ALLOW_X_OPERATOR = "1";
process.env.SPACE_SAFETY_DEMO = "1";

console.log("\nAPI — 端点契约（直接调用 route handler）\n");

async function main(): Promise<void> {
  const { getDb } = await import("../src/db");
  const schema = await import("../src/db/schema");
  const { SCREENED_STATUSES, statusForFailure } = await import("../src/lib/api/screening-service");

  const { db } = getDb();
  const now = new Date().toISOString();
  const me = "11111111-1111-4111-8111-111111111111";
  const peer = "22222222-2222-4222-8222-222222222222";

  db.insert(schema.operators)
    .values([
      { id: me, name: "Contract A", email: "a@example.test", phone: "+1", maxObjects: 5, createdAt: now, updatedAt: now },
      { id: peer, name: "Contract B", email: "b@example.test", phone: "+2", maxObjects: 5, createdAt: now, updatedAt: now },
    ])
    .run();

  const seq = () => (db.select().from(schema.cdms).all().length + 1) * 10;

  const baseCdm = {
    createdAt: now,
    isActive: true,
    trajectory1CreatedAt: now,
    trajectory2CreatedAt: now,
    tcaGpsNanos: "1462127401367770377",
    object1Name: "OBJ-1",
    object2Name: "OBJ-2",
    object1Maneuverable: true,
    object2Maneuverable: false,
    operator1Name: "Contract A",
    operator2Name: "Contract B",
    isHypothetical: false,
    // The serialised CDM is mandatory on the row; the stream only echoes it
    // when \`include_cdm_file\` is set, so a placeholder is enough here.
    fileJson: "{}",
  } as const;

  // One CDM for the caller, one for the peer, one that involves the caller but
  // was produced by a Stargaze (spacex_optical) trajectory.
  db.insert(schema.cdms)
    .values([
      {
        ...baseCdm,
        id: "cdm-mine",
        eventId: null,
        trajectory1Id: "t1",
        trajectory2Id: "t2",
        trajectory1Source: "operator_ephemeris",
        trajectory2Source: "operator_ephemeris",
        object1Id: "o1",
        object2Id: "o2",
        operator1Id: me,
        operator2Id: peer,
        probabilityOfCollision: 1e-5,
        seq: seq(),
      },
      {
        ...baseCdm,
        id: "cdm-peer-only",
        eventId: null,
        trajectory1Id: "t3",
        trajectory2Id: "t4",
        trajectory1Source: "operator_ephemeris",
        trajectory2Source: "operator_ephemeris",
        object1Id: "o3",
        object2Id: "o4",
        operator1Id: peer,
        operator2Id: peer,
        probabilityOfCollision: 2e-5,
        seq: seq(),
      },
      {
        ...baseCdm,
        id: "cdm-optical",
        eventId: null,
        trajectory1Id: "t5",
        trajectory2Id: "t6",
        trajectory1Source: "operator_ephemeris",
        trajectory2Source: "spacex_optical",
        object1Id: "o5",
        object2Id: "o6",
        operator1Id: me,
        operator2Id: peer,
        probabilityOfCollision: 3e-5,
        seq: seq(),
      },
    ])
    .run();

  const events = await import("../src/app/api/v1/event/route");
  const cdmsV1 = await import("../src/app/api/v1/cdm/route");
  const cdmsV2 = await import("../src/app/api/v2/cdm/route");
  const cdmsV2Plural = await import("../src/app/api/v2/cdms/route");

  const call = async (
    handler: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
    path: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await handler(
      new Request(`http://localhost${path}`, {
        headers: { "x-space-safety-operator": me },
      }),
      { params: Promise.resolve({}) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  // ---------------------------------------------------------- deprecated lists
  const v1Cdm = await call(cdmsV1.GET, "/api/v1/cdm");
  check("GET /api/v1/cdm 返回 200 与 {result, token}", () => {
    assert.equal(v1Cdm.status, 200);
    assert.ok(Array.isArray(v1Cdm.body.result));
    assert.equal(typeof v1Cdm.body.token, "string");
  });
  check("GET /api/v1/cdm 只返回调用方参与的交会", () => {
    const ids = (v1Cdm.body.result as Array<{ id: string }>).map((r) => r.id);
    assert.ok(ids.includes("cdm-mine"), `缺少自己的 CDM：${ids.join(",")}`);
    assert.ok(!ids.includes("cdm-peer-only"), "泄露了其他运营方的 CDM");
  });
  check("GET /api/v1/cdm 排除 spacex_optical 产生的 CDM", () => {
    const ids = (v1Cdm.body.result as Array<{ id: string }>).map((r) => r.id);
    assert.ok(!ids.includes("cdm-optical"), "已弃用端点不应返回 Stargaze CDM");
  });
  check("GET /api/v1/cdm 用 v1 字段名（created_at / tca）", () => {
    const row = (v1Cdm.body.result as Array<Record<string, unknown>>)[0];
    assert.ok("created_at" in row && "tca" in row, Object.keys(row).join(","));
  });

  const v1Event = await call(events.GET, "/api/v1/event");
  check("GET /api/v1/event 返回 200 与 {result, token}", () => {
    assert.equal(v1Event.status, 200);
    assert.ok(Array.isArray(v1Event.body.result));
    assert.equal(typeof v1Event.body.token, "string");
  });

  // ------------------------------------------------------------ plural alias
  const singular = await call(cdmsV2.GET, `/api/v2/cdm?operator1_id=${me}`);
  const plural = await call(cdmsV2Plural.GET, `/api/v2/cdms?operator1_id=${me}`);
  check("GET /api/v2/cdms 与 /api/v2/cdm 结果一致", () => {
    assert.equal(plural.status, singular.status);
    const ids = (b: Record<string, unknown>) =>
      (b.result as Array<{ id: string }>).map((r) => r.id).sort();
    assert.deepEqual(ids(plural.body), ids(singular.body));
  });
  const pluralNoFilter = await call(cdmsV2Plural.GET, "/api/v2/cdms");
  check("GET /api/v2/cdms 缺少必填过滤参数时返回 400", () => {
    assert.equal(pluralNoFilter.status, 400);
    assert.equal(pluralNoFilter.body.error_type, "bad_request");
  });

  // --------------------------------------------------------- screened_status
  check("screened_status 覆盖官方文档的 6 个取值", () => {
    const expected = [
      "screened",
      "not_screened",
      "candidate_to_definitive",
      "unknown_trajectory_fetching_error",
      "superseded",
      "failed_interpolation",
    ];
    assert.deepEqual([...SCREENED_STATUSES].sort(), [...expected].sort());
  });

  check("计算节点失败能映射到官方状态值", () => {
    assert.equal(
      statusForFailure("trajectory not available on this worker (primary=abc)"),
      "unknown_trajectory_fetching_error",
    );
    assert.equal(statusForFailure("fetch 013a0648 error: ECONNRESET"), "unknown_trajectory_fetching_error");
    assert.equal(statusForFailure("interpolation failed at tca"), "failed_interpolation");
    assert.equal(statusForFailure("TCA outside the trajectory span"), "failed_interpolation");
  });

  check("无法识别的失败不臆造状态", () => {
    assert.equal(statusForFailure("compute pool is shutting down"), null);
    assert.equal(statusForFailure(""), null);
    assert.equal(statusForFailure(undefined), null);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
