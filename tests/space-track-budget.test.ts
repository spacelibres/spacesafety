/**
 * The Space-Track budget must actually refuse.
 *
 * On 2026-11-05 the account was warned: 667 queries in one hour, from a script that
 * paged the API for 42 000 objects. The dangerous property of that failure was that it
 * looked like success the whole time — the API answered, the loop continued, nothing
 * reported a problem. So this test does not check that the budget "exists"; it checks
 * that the (N+1)th claim is refused, in the place the requests actually go through.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";

const STATE = join("data", "space-track-budget.json");

function reset(): void {
  rmSync(STATE, { force: true });
}

function load() {
  // Fresh module per case, so no state carries between them. The cache-busting query
  // string makes Node re-evaluate the module instead of returning the first instance.
  return import(`../src/lib/sources/space-track-budget.ts?t=${Date.now()}`);
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${(err as Error).message}`);
    failed += 1;
  }
}

export async function run(): Promise<void> {
  console.log("\n  Space-Track 调用配额\n");

  await test("额度内放行，用尽后拒绝", async () => {
    reset();
    process.env.SPACE_SAFETY_ST_HOURLY_LIMIT = "2";
    const { claimQuery } = await load();
    assert.equal(claimQuery(), null, "第 1 次应放行");
    assert.equal(claimQuery(), null, "第 2 次应放行");
    const third = claimQuery();
    assert.ok(third, "第 3 次应被拒绝");
    assert.match(third.reason, /budget exhausted/);
  });

  await test("拒绝理由说明是额度而非网络错误", async () => {
    reset();
    process.env.SPACE_SAFETY_ST_HOURLY_LIMIT = "1";
    const { claimQuery } = await load();
    claimQuery();
    const r = claimQuery();
    assert.ok(r);
    // The distinction matters: a network error invites a retry, an exhausted budget
    // must not.
    assert.match(r.reason, /Refusing to send/);
    assert.match(r.reason, /SPACE_SAFETY_ST_HOURLY_LIMIT/);
  });

  await test("跨小时只重置小时计数，不重置当日计数", async () => {
    reset();
    process.env.SPACE_SAFETY_ST_HOURLY_LIMIT = "5";
    process.env.SPACE_SAFETY_ST_DAILY_LIMIT = "100";
    const { claimQuery, budgetStatus } = await load();

    const firstHour = new Date("2026-11-05T10:30:00Z");
    claimQuery(firstHour);
    claimQuery(firstHour);
    assert.equal(budgetStatus(firstHour).dayCount, 2);

    const nextHour = new Date("2026-11-05T11:05:00Z");
    const s = budgetStatus(nextHour);
    assert.equal(s.hourCount, 0, "小时计数应归零");
    assert.equal(s.dayCount, 2, "当日计数应保留");
  });

  await test("非法额度值回落到默认值，不会被当成 0", async () => {
    reset();
    process.env.SPACE_SAFETY_ST_HOURLY_LIMIT = "0.0001";
    const { budgetStatus } = await load();
    // A fractional limit used to floor to 0, which silently disabled the budget — the
    // exact opposite of what a typo should do.
    assert.equal(budgetStatus().hourly, 60);
  });

  delete process.env.SPACE_SAFETY_ST_HOURLY_LIMIT;
  delete process.env.SPACE_SAFETY_ST_DAILY_LIMIT;
  reset();

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

void run();
