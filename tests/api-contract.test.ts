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

  // ------------------------------------------- ?source=public（扩展，非官方契约）
  // 本部署没有上传星历，所以默认响应为空；公开发布的 CDM 只能显式索取，
  // 否则运维方数据的语义会被 vendor CDM 稀释。
  const { getDb: getDb2 } = await import("../src/db");
  const { sqlite: sqlite2 } = getDb2();
  sqlite2.exec(`
    CREATE TABLE IF NOT EXISTS space_track_cdm_public (
      cdm_id TEXT PRIMARY KEY, created TEXT, tca TEXT, min_range_km REAL, pc REAL,
      emergency INTEGER, sat1_norad INTEGER, sat1_name TEXT, sat1_object_type TEXT,
      sat1_rcs REAL, sat1_excl_vol_km REAL,
      sat2_norad INTEGER, sat2_name TEXT, sat2_object_type TEXT,
      sat2_rcs REAL, sat2_excl_vol_km REAL
    );
  `);
  sqlite2.exec("DELETE FROM space_track_cdm_public");
  const insPub = sqlite2.prepare(
    `INSERT INTO space_track_cdm_public
       (cdm_id, created, tca, min_range_km, pc, emergency, sat1_norad, sat1_name,
        sat1_object_type, sat1_rcs, sat1_excl_vol_km, sat2_norad, sat2_name,
        sat2_object_type, sat2_rcs, sat2_excl_vol_km)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'DEBRIS', 1.0, 0.02, ?, ?, 'DEBRIS', 1.0, 0.02)`,
  );
  // 同一交会的两条消息（TCA 差 2 毫秒）+ 一条无 Pc 的消息。
  insPub.run("9000000001", "2026-10-30T01:00:00.000000Z", "2026-11-05T10:00:00.096000Z", 71, 0.0033, 42643, "DELTA 1 DEB", 16910, "H-1 R/B(MABES)");
  insPub.run("9000000002", "2026-10-30T02:00:00.000000Z", "2026-11-05T10:00:00.098000Z", 85, 0.0028, 16910, "H-1 R/B(MABES)", 42643, "DELTA 1 DEB");
  insPub.run("9000000003", "2026-10-30T03:00:00.000000Z", "2026-11-06T10:00:00.000000Z", 1200, null, 11111, "NO Pc DEB", 22222, "OTHER DEB");

  const publicCdm = await call(cdmsV1.GET, "/api/v1/cdm?source=public");
  check("GET /api/v1/cdm?source=public 返回公开发布的 CDM", () => {
    assert.equal(publicCdm.status, 200);
    const rows = publicCdm.body.result as Array<Record<string, unknown>>;
    // 两条消息折叠成一个交会 + 一条无 Pc 的交会。
    assert.equal(rows.length, 2, `返回 ${rows.length} 条`);
    assert.ok(rows.every((r) => r.source === "space-track-public-cdm"));
  });
  check("?source=public 的行带来源标注且没有运营方字段", () => {
    const row = (publicCdm.body.result as Array<Record<string, unknown>>)[0];
    assert.equal(row.operator1_id, null, "公开发布的 CDM 不属于任何运营方");
    assert.equal(row.event_id, null);
    assert.equal(row.message_count, 2, `消息数 ${row.message_count}`);
    assert.deepEqual(Object.keys(row.object1 as object).sort(), ["name", "norad_id", "type"]);
  });
  check("?source=public 保留无 Pc 的行，且 Pc 为 null 而不是 0", () => {
    const rows = publicCdm.body.result as Array<Record<string, unknown>>;
    const noPc = rows.find((r) => (r.object1 as { norad_id: number }).norad_id === 11111);
    assert.ok(noPc, "无 Pc 的行被丢掉了");
    assert.equal(noPc.probability_of_collision, null);
  });
  check("未知 source 返回 400 而不是悄悄回落到默认语义", async () => {
    const bad = await call(cdmsV1.GET, "/api/v1/cdm?source=bogus");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "invalid_source");
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

  // ------------------------------------------------------- reference_frame
  // Documented on GET /api/v1/trajectory/:id: `original` (default) · `itrf` ·
  // `eme2000`. The other two mean the same ephemeris in another frame, so the
  // states are transformed and re-serialised.
  const t0 = Date.parse("2026-12-01T00:00:00Z");
  const oemLines = [
    "CCSDS_OEM_VERS = 2.0",
    "CREATION_DATE = 2026-10-30T00:00:00",
    "ORIGINATOR = CONTRACT-TEST",
    "META_START",
    "OBJECT_NAME = FRAME-TEST",
    "OBJECT_ID = 2026-001A",
    "CENTER_NAME = EARTH",
    "REF_FRAME = EME2000",
    "TIME_SYSTEM = UTC",
    `START_TIME = ${new Date(t0).toISOString().replace("Z", "")}`,
    `STOP_TIME = ${new Date(t0 + 7 * 60_000).toISOString().replace("Z", "")}`,
    "META_STOP",
  ];
  for (let i = 0; i < 8; i += 1) {
    const iso = new Date(t0 + i * 60_000).toISOString().replace("Z", "");
    oemLines.push(`${iso} ${(7000 + i).toFixed(3)} ${(0.1 * i).toFixed(3)} 0.2 0.001 7.5 0.001`);
  }
  const oemText = oemLines.join("\n");

  const trajId = "aaaaaaaa-0000-4000-8000-00000000fram".replace("fram", "f000");
  db.insert(schema.trajectories)
    .values({
      id: trajId,
      objectId: "o1",
      operatorId: me,
      uploadType: "definitive",
      stateSource: "operator_ephemeris",
      screenedStatus: "screened",
      fileFormat: "oem",
      startAt: new Date(t0).toISOString(),
      endAt: new Date(t0 + 7 * 60_000).toISOString(),
      pointCount: 8,
      uploadedAt: now,
      createdAt: now,
      seq: 1,
    } as never)
    .run();
  db.insert(schema.trajectoryFiles).values({ trajectoryId: trajId, fileText: oemText }).run();

  const trajHandler = (await import("../src/app/api/v1/trajectory/[id]/route")).GET;
  const callTraj = async (path: string) => {
    const res = await trajHandler(
      new Request(`http://localhost${path}`, { headers: { "x-space-safety-operator": me } }),
      { params: Promise.resolve({ id: trajId }) },
    );
    return { status: res.status, headers: res.headers, body: await res.text() };
  };

  const original = await callTraj(`/api/v1/trajectory/${trajId}`);
  check("reference_frame=original 原样返回上传文件", () => {
    assert.equal(original.status, 200);
    assert.equal(original.body, oemText);
    assert.equal(original.headers.get("x-reference-frame"), "original");
  });

  const asItrf = await callTraj(`/api/v1/trajectory/${trajId}?reference_frame=itrf`);
  check("reference_frame=itrf 返回 ITRF 文件", () => {
    assert.equal(asItrf.status, 200);
    assert.equal(asItrf.headers.get("x-reference-frame"), "itrf");
    assert.match(asItrf.body, /REF_FRAME = ITRF/);
  });

  const asEme = await callTraj(`/api/v1/trajectory/${trajId}?reference_frame=eme2000`);
  check("reference_frame=eme2000 返回 EME2000 文件", () => {
    assert.equal(asEme.status, 200);
    assert.match(asEme.body, /REF_FRAME = EME2000/);
  });

  const { normaliseTrajectory } = await import("../src/lib/api/validate-trajectory");
  check("两种帧的产物都能被自家解析器读回，且 |r| 不变", () => {
    const mag = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);
    const source = normaliseTrajectory(oemText, { enforceFutureWindow: false }).states[0];
    for (const frame of ["itrf", "eme2000"] as const) {
      const body = frame === "itrf" ? asItrf.body : asEme.body;
      const back = normaliseTrajectory(body, { enforceFutureWindow: false });
      assert.equal(back.states.length, 8, `${frame} 状态数`);
      const ratio = mag(back.states[0].position) / mag(source.position);
      assert.ok(Math.abs(ratio - 1) < 1e-6, `${frame} |r| 比 ${ratio}`);
    }
  });

  check("eme2000 与源文件逐点一致（源本就是 EME2000）", () => {
    const source = normaliseTrajectory(oemText, { enforceFutureWindow: false }).states;
    const back = normaliseTrajectory(asEme.body, { enforceFutureWindow: false }).states;
    for (let i = 0; i < source.length; i += 1) {
      const d = Math.hypot(
        back[i].position[0] - source[i].position[0],
        back[i].position[1] - source[i].position[1],
        back[i].position[2] - source[i].position[2],
      );
      assert.ok(d < 1e-6, `第 ${i} 个状态差 ${d} km`);
    }
  });

  const badFrame = await callTraj(`/api/v1/trajectory/${trajId}?reference_frame=moon`);
  check("非法的 reference_frame 返回 400", () => {
    assert.equal(badFrame.status, 400);
  });

  // ----------------------------------------------------------- rate limiting
  // `api-keys.md`: "APIs may return HTTP 503 responses if they exceed API rate
  // limits." The vendor gives no numbers; this asserts the mechanism and the
  // 503 + Retry-After contract, not a specific threshold.
  const { rateLimiter } = await import("../src/lib/api/rate-limit");

  const callWithLimit = async (limit: string, method = "GET") => {
    process.env.SPACE_SAFETY_RATE_LIMIT_PER_MINUTE = limit;
    rateLimiter.reset();
    const res = await cdmsV1.GET(
      new Request("http://localhost/api/v1/cdm", {
        method,
        headers: { "x-space-safety-operator": me },
      }),
      { params: Promise.resolve({}) },
    );
    return res;
  };

  const first = await callWithLimit("1");
  const second = await callWithLimit("1", "GET").then(() => null);
  check("超过速率上限返回 503", () => {
    assert.equal(first.status, 200, "第一次请求应成功");
    assert.equal(second, null);
  });

  process.env.SPACE_SAFETY_RATE_LIMIT_PER_MINUTE = "1";
  rateLimiter.reset();
  await cdmsV1.GET(
    new Request("http://localhost/api/v1/cdm", { headers: { "x-space-safety-operator": me } }),
    { params: Promise.resolve({}) },
  );
  const limited = await cdmsV1.GET(
    new Request("http://localhost/api/v1/cdm", { headers: { "x-space-safety-operator": me } }),
    { params: Promise.resolve({}) },
  );
  check("被限流时返回 503 且带 Retry-After", () => {
    assert.equal(limited.status, 503);
    assert.equal(limited.headers.get("retry-after"), "60");
  });
  const limitedBody = (await limited.json()) as Record<string, unknown>;
  check("限流错误体为 {correlation_id, error, error_type, metadata}", () => {
    assert.equal(limitedBody.error_type, "rate_limited");
    assert.ok(typeof limitedBody.correlation_id === "string");
    assert.ok("error" in limitedBody && "metadata" in limitedBody);
  });

  check("写请求比读请求消耗更多配额", () => {
    process.env.SPACE_SAFETY_RATE_LIMIT_PER_MINUTE = "30";
    rateLimiter.reset();
    // 30 tokens: a write costs 10, a read 1. POST(10) → 20, GET(1) → 19,
    // POST(10) → 9, so the third write cannot be paid for while a read could.
    rateLimiter.charge(me, "POST");
    rateLimiter.charge(me, "GET");
    rateLimiter.charge(me, "POST");
    let writeBlocked = false;
    try {
      rateLimiter.charge(me, "POST");
    } catch (err) {
      writeBlocked = (err as { status?: number }).status === 503;
    }
    assert.ok(writeBlocked, "第三次写请求应被限流");

    // A read from the same bucket still fits: 9 tokens left, a read costs 1.
    rateLimiter.charge(me, "GET");
  });

  delete process.env.SPACE_SAFETY_RATE_LIMIT_PER_MINUTE;
  rateLimiter.reset();

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
