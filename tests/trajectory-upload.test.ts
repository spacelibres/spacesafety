/**
 * The trajectory upload endpoint, executed as a route handler.
 *
 * ## Why this file exists
 *
 * `POST /api/v1/trajectory` is the application's only write path that matters: an
 * operator uploads an ephemeris, it becomes a `trajectories` row plus a
 * `trajectory_files` row, and a screening job is queued. Nothing in the suite ever
 * called it.
 *
 * The gap hid two things worth a test:
 *
 *   1. **The file text lives in a second table.** Every writer has to insert both
 *      rows; a writer that stores only the metadata leaves a trajectory that reads
 *      back empty, and screening then finds nothing to propagate — a failure that
 *      shows up long after the upload looked successful. A helper that claimed to
 *      enforce this (`writeTrajectoryFile`) was never called by anything, so the
 *      rule was asserted in a comment and verified nowhere. This test verifies it.
 *   2. **Errors were never exercised.** Bad `upload_type`, someone else's object,
 *      a past-dated file — each of those is a distinct rejection path.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
async function check(
  name: string,
  fn: () => Promise<void> | void,
  detail = "",
): Promise<void> {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
    console.log(`       ${(err as Error).message}`);
  }
}

const workDir = mkdtempSync(join(tmpdir(), "spacesafety-upload-"));
process.env.SPACE_SAFETY_DB = join(workDir, "upload.sqlite");
// The `x-space-safety-operator` principal shortcut needs both flags: the bypass
// alone is not enough, by design (see `src/lib/api/auth.ts`).
process.env.SPACE_SAFETY_ALLOW_X_OPERATOR = "1";
process.env.SPACE_SAFETY_DEMO = "1";

/**
 * A valid OCM file, future-dated.
 *
 * The same shape `tests/api.test.ts` uses: 20 states on a circular 550 km orbit,
 * one per minute, plus a strict-lower-triangle covariance so the upload exercises
 * the covariance path rather than only the states.
 */
function ocmFile(points = 20, startOffsetMs = 3_600_000): string {
  const MU = 398600.4418;
  const R = 6378.137 + 550;
  const P = 2 * Math.PI * Math.sqrt(R ** 3 / MU);
  const speed = Math.sqrt(MU / R);
  const t0 = Date.now() + startOffsetMs;

  const iso = (ms: number) => new Date(ms).toISOString().replace(/Z$/, "000Z");

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
  lines.push("TRAJ_STOP", "", "COV_START", "COV_REF_FRAME = EME2000", "COV_TYPE = CARTPV",
    "COV_ORDERING = LTM", "COV_UNITS = [km,km,km,km/s,km/s,km/s]");
  const P1 = "1.0000000000e-02";
  const Z = "0.0000000000e+00";
  const V = "1.0000000000e-08";
  lines.push([P1, Z, P1, Z, Z, P1, Z, Z, Z, V, Z, Z, Z, Z, V, Z, Z, Z, Z, Z, V].join(" "));
  lines.push("COV_STOP");
  return lines.join("\n");
}

console.log("\nAPI — 星历上传（直接调用 route handler）\n");

async function main(): Promise<void> {
  const { getDb } = await import("../src/db");
  const schema = await import("../src/db/schema");

  const { db } = getDb();
  const now = new Date().toISOString();
  const me = "11111111-1111-4111-8111-111111111111";
  const peer = "22222222-2222-4222-8222-222222222222";
  const myObject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const peerObject = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  db.insert(schema.operators)
    .values([
      { id: me, name: "Upload A", email: "a@example.test", phone: "+1", maxObjects: 5, createdAt: now, updatedAt: now },
      { id: peer, name: "Upload B", email: "b@example.test", phone: "+2", maxObjects: 5, createdAt: now, updatedAt: now },
    ])
    .run();
  db.insert(schema.objects)
    .values([
      {
        id: myObject,
        operatorId: me,
        objectName: "UPLOAD-MINE",
        hardBodyRadius: 1,
        maneuverability: false,
        alive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: peerObject,
        operatorId: peer,
        objectName: "UPLOAD-PEER",
        hardBodyRadius: 1,
        maneuverability: false,
        alive: true,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();

  // A catalogue entry for a *different* object and trajectory: `enqueueScreening`
  // creates one job per catalogued partner, and an empty catalogue would queue
  // nothing while still returning 201 — which is how the first version of this
  // test "passed" a 201 with zero jobs.
  const partnerTrajectory = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  db.insert(schema.operators)
    .values({
      id: "33333333-3333-4333-8333-333333333333",
      name: "Upload C",
      email: "c@example.test",
      phone: "+3",
      maxObjects: 5,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(schema.trajectories)
    .values({
      id: partnerTrajectory,
      objectId: peerObject,
      operatorId: "33333333-3333-4333-8333-333333333333",
      uploadType: "definitive",
      stateSource: "operator_ephemeris",
      screenedStatus: "screened",
      fileFormat: "ocm",
      startAt: now,
      endAt: now,
      pointCount: 20,
      uploadedAt: now,
      createdAt: now,
      autoRelinquishPcThreshold: null,
      seq: 1,
    })
    .run();
  db.insert(schema.trajectoryFiles)
    .values({ trajectoryId: partnerTrajectory, fileText: ocmFile() })
    .run();
  db.insert(schema.catalog)
    .values({
      objectId: peerObject,
      stateSource: "operator_ephemeris",
      trajectoryId: partnerTrajectory,
      updatedAt: now,
    })
    .run();

  const { POST } = await import("../src/app/api/v1/trajectory/route");
  const { GET: GET_ONE } = await import("../src/app/api/v1/trajectory/[id]/route");
  const { getTrajectoryFile } = await import("../src/lib/queries");

  async function upload(body: unknown): Promise<{ status: number; headers: Headers; body: Record<string, unknown> | Record<string, unknown>[] }> {
    const res = await POST(
      new Request("http://localhost/api/v1/trajectory", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-space-safety-operator": me,
        },
        body: JSON.stringify(body),
      }),
      // `route()` awaits `ctx.params`; a collection route has none, but the
      // handler is typed as taking the context, so pass an empty one.
      { params: Promise.resolve({}) },
    );
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // an error response may not be JSON; keep the raw text for the assertion
    }
    return {
      status: res.status,
      headers: res.headers,
      body: parsed as Record<string, unknown>,
    };
  }

  const file = ocmFile();

  // ------------------------------------------------------------ the happy path
  const created = await upload({
    object_id: myObject,
    file,
    upload_type: "definitive",
  });
  const createdId = (created.body as { id?: string }).id ?? "";

  await check("上传返回 201 与 Location", async () => {
    assert.equal(created.status, 201, `status=${created.status} body=${JSON.stringify(created.body)}`);
    assert.match(createdId, /^[0-9a-f-]{36}$/, `id=${createdId}`);
    assert.equal(created.headers.get("location"), `/api/v1/trajectory/${createdId}`);
  });

  await check("上传对着编目里的每一个伙伴各排一个筛查任务", async () => {
    // One catalogued partner in this fixture, so exactly one job.
    assert.equal(created.headers.get("x-screening-jobs-queued"), "1");
    const jobs = db.select().from(schema.screeningJobs).all();
    assert.equal(jobs.length, 1, `任务数 ${jobs.length}`);
    assert.equal(jobs[0].trajectoryId, createdId);
    assert.equal(jobs[0].againstTrajectoryId, partnerTrajectory);
    assert.equal(jobs[0].status, "pending");
  });

  await check("定版上传成为编目里该物体的参考星历", async () => {
    const entry = db
      .select()
      .from(schema.catalog)
      .all()
      .find((c) => c.objectId === myObject);
    assert.ok(entry, "编目里没有写入新上传");
    assert.equal(entry.trajectoryId, createdId, "参考星历没有被替换");
  });

  await check("元数据行写入了 states 数与时间范围", async () => {
    const row = db.select().from(schema.trajectories).all().find((r) => r.id === createdId);
    assert.ok(row, "trajectories 行缺失");
    assert.equal(row.objectId, myObject);
    assert.equal(row.operatorId, me);
    assert.equal(row.uploadType, "definitive");
    assert.equal(row.screenedStatus, "not_screened");
    assert.equal(row.pointCount, 20, `pointCount=${row.pointCount}`);
    assert.ok(row.startAt && row.endAt, "起止时间缺失");
    assert.ok(typeof row.seq === "number" && row.seq > 0, `seq=${row.seq}`);
  });

  // -------------------------------------- the invariant that had no enforcement
  await check("文件文本写入了 trajectory_files，逐字节一致", async () => {
    const rows = db
      .select()
      .from(schema.trajectoryFiles)
      .all()
      .filter((r) => r.trajectoryId === createdId);
    assert.equal(rows.length, 1, `该星历的文件行数 ${rows.length}`);
    assert.equal(rows[0].fileText, file, "存下来的文本与上传的不一致");
  });

  await check("每一条 trajectory 都有对应的文件行", async () => {
    // The rule matters for the writers `exec` reaches too, so it is asserted over
    // the table, not over the one row this test uploaded.
    const ids = new Set(db.select().from(schema.trajectoryFiles).all().map((r) => r.trajectoryId));
    const orphans = db.select().from(schema.trajectories).all().filter((t) => !ids.has(t.id));
    assert.equal(orphans.length, 0, `没有文件行的星历：${orphans.map((o) => o.id).join(",")}`);
  });

  await check("读回接口原样返回上传的文件（text/plain，非 JSON）", async () => {
    // `?reference_frame=original` is the documented default and hands back the
    // stored bytes untouched — asserting JSON here was the test's mistake, not
    // the endpoint's.
    const res = await GET_ONE(
      new Request(`http://localhost/api/v1/trajectory/${createdId}`, {
        headers: { "x-space-safety-operator": me },
      }),
      { params: Promise.resolve({ id: createdId }) },
    );
    assert.equal(res.status, 200, `status=${res.status}`);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/, "content-type 不是 text/plain");
    assert.equal(res.headers.get("x-trajectory-format"), "ocm");
    assert.equal(await res.text(), file, "读回的文本与上传的不一致");
  });

  await check("getTrajectoryFile 返回的正是上传的文本", async () => {
    const stored = getTrajectoryFile(createdId);
    assert.ok(stored, "读不到文件");
    assert.equal(stored.text, file);
    assert.equal(stored.format, "ocm", `format=${stored.format}`);
  });

  // ---------------------------------------------------------- rejection paths
  await check("upload_type 非法被拒绝，且不留下半条记录", async () => {
    const before = db.select().from(schema.trajectories).all().length;
    const res = await upload({ object_id: myObject, file, upload_type: "definitive-ish" });
    assert.equal(res.status, 400, `status=${res.status}`);
    assert.equal(db.select().from(schema.trajectories).all().length, before, "被拒绝的上传留下了行");
  });

  await check("缺 file 被拒绝", async () => {
    const res = await upload({ object_id: myObject, upload_type: "definitive" });
    assert.equal(res.status, 400, `status=${res.status}`);
  });

  await check("别人的物体不允许上传", async () => {
    const res = await upload({ object_id: peerObject, file, upload_type: "definitive" });
    assert.equal(res.status, 403, `status=${res.status}`);
  });

  await check("不存在的物体返回 404", async () => {
    const res = await upload({
      object_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      file,
      upload_type: "definitive",
    });
    assert.equal(res.status, 404, `status=${res.status}`);
  });

  await check("结束时刻在 24 小时以前的星历被拒绝", async () => {
    // The rule is on the *end* of the window: `lastMs < now - 24h`. A window that
    // started 24 h ago but ends 23h40m ago is still accepted, so the fixture has to
    // sit comfortably outside the boundary.
    const past = ocmFile(20, -2 * 86_400_000);
    const res = await upload({ object_id: myObject, file: past, upload_type: "definitive" });
    assert.equal(res.status, 400, `status=${res.status}`);
  });

  await check("窗口刚过去 23 小时仍然接受（24 小时是边界，不是起点）", async () => {
    const recent = ocmFile(20, -23 * 3_600_000);
    const res = await upload({ object_id: myObject, file: recent, upload_type: "definitive" });
    assert.equal(res.status, 201, `status=${res.status}`);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
