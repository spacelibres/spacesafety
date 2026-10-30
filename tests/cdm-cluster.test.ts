/**
 * Conjunctions: many CDM messages, one conjunction.
 *
 * ## The bug this test pins down
 *
 * `space_track_cdm_public` stores one row per **message**, but a conjunction
 * receives a new message every time the screening centre's estimate moves. Read
 * row-per-row and sorted by Pc — which is what the page did — one conjunction
 * appears five times with five different probabilities, and the *historical worst*
 * estimate sits at the top presented as the current risk.
 *
 * Measured on pair 16910 / 42643, which is one conjunction in 14 messages:
 *
 *   | created (UTC)   | TCA           | Pc        | miss |
 *   |-----------------|---------------|-----------|------|
 *   | 2026-10-28 06:15| 22:49:39.105  | 0.0004271 | 218 km |
 *   | 2026-10-29 12:46| 22:49:39.098  | 0.0026593 |  92 km |
 *   | 2026-10-30 05:37| 22:49:39.096  | 0.0032998 |  71 km |
 *
 * TCA alone is not a key either: it jitters by milliseconds between issues
 * (`.094` → `.096` → `.105`), so grouping on the exact value split this one
 * conjunction into five. The production query clusters by pair plus TCA
 * proximity; these tests drive the same SQL against a fixture built from the
 * shape above, so the clustering rule is verified rather than assumed.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;

async function check(name: string, fn: () => Promise<void> | void, detail = ""): Promise<void> {
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

const workDir = mkdtempSync(join(tmpdir(), "spacesafety-cdm-"));
process.env.SPACE_SAFETY_DB = join(workDir, "cdm.sqlite");

interface Message {
  cdmId: string;
  created: string;
  tca: string;
  pc: number | null;
  minRangeKm: number | null;
  sat1: [number, string];
  sat2: [number, string];
}

/**
 * One conjunction, fourteen messages, in the shape the vendor actually emits:
 * TCA drifting by milliseconds, Pc climbing, and each update sent twice a few
 * minutes apart with the object pair swapped.
 */
function oneConjunction(): Message[] {
  const tca = [
    "2026-10-30T22:49:39.105000Z",
    "2026-10-30T22:49:39.104000Z",
    "2026-10-30T22:49:39.098000Z",
    "2026-10-30T22:49:39.096000Z",
  ];
  // 14 issues in total, matching the measured pair: 4 + 4 + 3 + 3.
  const steps = [
    { pc: 0.0004271, km: 218, tca: 0, n: 4 },
    { pc: 0.0026593, km: 92, tca: 2, n: 4 },
    { pc: 0.0028698, km: 85, tca: 3, n: 3 },
    { pc: 0.0032998, km: 71, tca: 3, n: 3 },
  ];
  const out: Message[] = [];
  // Every issue is 3 hours after the previous one: strictly increasing, and the
  // last one is the newest estimate for this conjunction.
  const base = Date.parse("2026-10-27T00:00:00Z");
  let i = 0;
  for (const step of steps) {
    for (let k = 0; k < step.n; k += 1) {
      i += 1;
      // Alternating orientation, as the vendor re-issues with the pair swapped.
      const swap = k % 2 === 1;
      out.push({
        cdmId: String(1776000000 + i),
        created: `${new Date(base + i * 3 * 3_600_000).toISOString().slice(0, 19)}.000000Z`,
        tca: tca[step.tca],
        pc: step.pc,
        minRangeKm: step.km,
        sat1: swap ? [16910, "H-1 R/B(MABES)"] : [42643, "DELTA 1 DEB"],
        sat2: swap ? [42643, "DELTA 1 DEB"] : [16910, "H-1 R/B(MABES)"],
      });
    }
  }
  return out;
}

async function seed(): Promise<void> {
  const { getDb } = await import("../src/db");
  const { sqlite } = getDb();

  sqlite.exec("DROP TABLE IF EXISTS space_track_cdm_public");
  sqlite.exec(`
    CREATE TABLE space_track_cdm_public (
      cdm_id TEXT PRIMARY KEY, created TEXT, tca TEXT, min_range_km REAL, pc REAL,
      emergency INTEGER, sat1_norad INTEGER, sat1_name TEXT, sat1_object_type TEXT,
      sat1_rcs REAL, sat1_excl_vol_km REAL,
      sat2_norad INTEGER, sat2_name TEXT, sat2_object_type TEXT,
      sat2_rcs REAL, sat2_excl_vol_km REAL
    );
  `);

  const insert = sqlite.prepare(
    `INSERT INTO space_track_cdm_public
       (cdm_id, created, tca, min_range_km, pc, emergency,
        sat1_norad, sat1_name, sat1_object_type, sat1_rcs, sat1_excl_vol_km,
        sat2_norad, sat2_name, sat2_object_type, sat2_rcs, sat2_excl_vol_km)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'DEBRIS', 1.0, 0.02, ?, ?, 'DEBRIS', 1.0, 0.02)`,
  );

  // The one conjunction above, plus two plainly separate ones.
  const rows: Message[] = [
    ...oneConjunction(),
    {
      cdmId: "1777000001",
      created: "2026-10-29T01:00:00.000000Z",
      tca: "2026-11-02T08:00:00.000000Z",
      pc: 0.0002,
      minRangeKm: 300,
      sat1: [25544, "ISS (ZARYA)"],
      sat2: [48274, "CSS (TIANHE)"],
    },
    {
      cdmId: "1777000002",
      created: "2026-10-29T02:00:00.000000Z",
      // Same pair, a different pass much later: must NOT join the first cluster.
      tca: "2026-11-09T08:00:00.000000Z",
      pc: 0.00015,
      minRangeKm: 850,
      sat1: [25544, "ISS (ZARYA)"],
      sat2: [48274, "CSS (TIANHE)"],
    },
  ];

  for (const r of rows) {
    insert.run(
      r.cdmId,
      r.created,
      r.tca,
      r.minRangeKm,
      r.pc,
      r.sat1[0],
      r.sat1[1],
      r.sat2[0],
      r.sat2[1],
    );
  }
}

async function main(): Promise<void> {
  console.log("\n交会去重：多条 CDM 消息 = 一个交会\n");
  await seed();

  const { listPublishedConjunctions, publishedConjunctionCounts } = await import("../src/lib/queries");
  // Mid-window "now": every TCA above is still in the future.
  const now = new Date("2026-10-30T00:00:00Z");

  await check("14 条消息折叠成一个交会，另加两个独立交会", async () => {
    const counts = publishedConjunctionCounts(now);
    assert.equal(counts.messages, 16, `消息数 ${counts.messages}`);
    assert.equal(counts.conjunctions, 3, `交会数 ${counts.conjunctions}`);
  });

  await check("每个交会只出现一次", async () => {
    const rows = listPublishedConjunctions(100, now);
    assert.equal(rows.length, 3);
    const pairs = rows.map((r) => `${Math.min(r.object1Norad, r.object2Norad)}-${Math.max(r.object1Norad, r.object2Norad)}`).sort();
    assert.deepEqual(pairs, ["16910-42643", "25544-48274", "25544-48274"]);
  });

  await check("TCA 抖动 ±10 毫秒不会被当成不同交会", async () => {
    const deltas = listPublishedConjunctions(100, now).filter((r) => r.object1Norad === 42643 || r.object2Norad === 42643);
    assert.equal(deltas.length, 1, `同一物体对出现了 ${deltas.length} 次`);
    assert.equal(deltas[0].messageCount, 14, `消息数 ${deltas[0].messageCount}`);
  });

  await check("保留的是最新一条消息，不是最高 Pc 那条", async () => {
    const row = listPublishedConjunctions(100, now).find((r) => r.object1Norad === 42643 || r.object2Norad === 42643)!;
    // The last issue carries the newest estimate: Pc 0.0032998 at 71 km.
    assert.equal(row.pc?.toFixed(7), "0.0032998", `Pc=${row.pc}`);
    assert.equal(row.minRangeKm, 71);
    assert.equal(row.createdIso, "2026-10-28T18:00:00.000000Z", String(row.createdIso));
  });

  await check("同一对物体的两次远隔交会不被合并", async () => {
    const same = listPublishedConjunctions(100, now).filter(
      (r) => r.object1Name === "ISS (ZARYA)" || r.object2Name === "ISS (ZARYA)",
    );
    assert.equal(same.length, 2, `合并成了 ${same.length} 条`);
    const tcas = same.map((r) => r.tcaIso).sort();
    assert.deepEqual(tcas, ["2026-11-02T08:00:00.000000Z", "2026-11-09T08:00:00.000000Z"]);
  });

  await check("没有 Pc 的消息不会被当成 0", async () => {
    const { getDb } = await import("../src/db");
    const { sqlite } = getDb();
    sqlite
      .prepare(
        `INSERT INTO space_track_cdm_public
           (cdm_id, created, tca, min_range_km, pc, emergency,
            sat1_norad, sat1_name, sat1_object_type, sat1_rcs, sat1_excl_vol_km,
            sat2_norad, sat2_name, sat2_object_type, sat2_rcs, sat2_excl_vol_km)
         VALUES ('1778000001','2026-10-29T03:00:00.000000Z','2026-11-03T00:00:00.000000Z',
                 1200, NULL, 1, 11111,'NO Pc DEB','DEBRIS',1.0,0.02, 22222,'OTHER DEB','DEBRIS',1.0,0.02)`,
      )
      .run();

    const row = listPublishedConjunctions(100, now).find((r) => r.object1Norad === 11111)!;
    assert.equal(row.pc, null, `Pc 变成了 ${row.pc}`);
    assert.equal(row.band, "unknown", row.band);

    // …and it sorts *below* every measured probability, never above.
    const rows = listPublishedConjunctions(100, now);
    assert.equal(rows[rows.length - 1].object1Norad, 11111, "无 Pc 的行没有被排在最后");
  });

  await check("计数与列表用的是同一套折叠规则", async () => {
    const counts = publishedConjunctionCounts(now);
    const rows = listPublishedConjunctions(100, now);
    assert.equal(rows.length, counts.conjunctions);
    assert.equal(counts.upcoming, rows.filter((r) => r.tcaInFuture).length);
  });

  await check("TCA 已过的交会仍然列出，但标记为非未来", async () => {
    const later = new Date("2026-12-01T00:00:00Z");
    const rows = listPublishedConjunctions(100, later);
    assert.equal(rows.filter((r) => r.tcaInFuture).length, 0);
    assert.equal(rows.length, 4, "历史交会不该因为过期就消失");
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
