/**
 * Event, environment and launch feeds: the shapes a reader relies on.
 *
 * ## Why these assertions and not just "the query returns rows"
 *
 * Every one of these feeds has a way of being *quietly* wrong that a row count
 * cannot show:
 *
 *   - `space_track_tip` is 26 189 rows of prediction, of which only a handful
 *     predict an epoch still in the future. A "predicted re-entries" list built
 *     from the newest messages would look busy and be entirely historical.
 *   - `space_track_decay` merges four feeds and two message types. A list headed
 *     "recent re-entries" that included `msg_type = 'Prediction'` would report a
 *     forecast as something that happened.
 *   - `space_track_boxscore` contains an `ALL` row. Left in a country list, the
 *     top bar of any "biggest owners" chart means "everyone".
 *   - a daily series can be missing a day and still look perfect in a table.
 *
 * So the assertions below are about semantics: which subset, ordered by what,
 * and with what excluded.
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

const workDir = mkdtempSync(join(tmpdir(), "spacesafety-feeds-"));
process.env.SPACE_SAFETY_DB = join(workDir, "feeds.sqlite");

/** "Now" for every assertion: fixed, so "upcoming" cannot drift with the clock. */
const NOW = new Date("2026-10-30T12:00:00Z");

async function seed(): Promise<void> {
  const { getDb } = await import("../src/db");
  const { sqlite } = getDb();

  // Catalogue names come from `master_object`; only the ids used below exist.
  sqlite.exec("DROP TABLE IF EXISTS master_object");
  sqlite.exec("CREATE TABLE master_object (norad_id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  const name = sqlite.prepare("INSERT INTO master_object VALUES (?, ?)");
  for (const [id, n] of [
    [45414, "STARLINK-1309"],
    [45389, "STARLINK-1283"],
    [90001, "FOREIGN-1"],
  ] as const) {
    name.run(id, n);
  }

  // TIP: one prediction in the future, two in the past.
  sqlite.exec("DROP TABLE IF EXISTS space_track_tip");
  sqlite.exec(`CREATE TABLE space_track_tip (
    norad_id INTEGER, msg_epoch TEXT, decay_epoch TEXT, window_min REAL, rev TEXT,
    direction TEXT, lat_deg REAL, lon_deg REAL, incl_deg REAL, high_interest INTEGER, tip_id TEXT)`);
  const tip = sqlite.prepare("INSERT INTO space_track_tip VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  tip.run(45389, "2026-10-29T13:15:00.000Z", "2026-11-01T13:17:00.000Z", 900, "1", "descending", -21.5, 107.8, 53, 0, "t1");
  tip.run(45414, "2026-10-27T04:03:00.000Z", "2026-10-30T04:16:00.000Z", 840, "1", "descending", -35.3, 258.7, 53, 1, "t2");
  tip.run(45414, "2026-10-28T04:50:00.000Z", "2026-10-30T04:59:00.000Z", 540, "1", "descending", 38.0, 63.9, 53, 0, "t3");

  // Decay: the same object as both a forecast and a completed re-entry, plus a
  // second object with two historical messages (the epoch is revisable).
  sqlite.exec("DROP TABLE IF EXISTS space_track_decay");
  sqlite.exec(`CREATE TABLE space_track_decay (
    norad_id INTEGER, msg_epoch TEXT, decay_epoch TEXT, name TEXT, intldes TEXT,
    country TEXT, rcs_size TEXT, source TEXT, msg_type TEXT,
    PRIMARY KEY (norad_id, msg_epoch))`);
  const dec = sqlite.prepare("INSERT INTO space_track_decay VALUES (?,?,?,?,?,?,?,?,?)");
  dec.run(45414, "2026-10-27T00:00:00.000Z", "2026-10-29T04:16:00.000Z", "STARLINK-1309", "2019-029", "US", "LARGE", "decay_msg", "Historical");
  dec.run(45414, "2026-10-26T00:00:00.000Z", "2026-10-29T04:20:00.000Z", "STARLINK-1309", "2019-029", "US", "LARGE", "tip", "Prediction");
  dec.run(90001, "2026-09-01T00:00:00.000Z", "2025-03-04T00:00:00.000Z", "OLD-NAME", "2018-001", "FR", "SMALL", "satcat", "Historical");
  dec.run(90001, "2026-09-02T00:00:00.000Z", "2025-03-05T00:00:00.000Z", "NEW-NAME", "2018-001", "FR", "SMALL", "decay_msg", "Historical");

  // KeepTrack re-entry: one in the future.
  sqlite.exec("DROP TABLE IF EXISTS keeptrack_reentry");
  sqlite.exec(`CREATE TABLE keeptrack_reentry (
    norad_id INTEGER PRIMARY KEY, name TEXT, decay_epoch TEXT, window_hours REAL,
    msg_epoch TEXT, lat REAL, lon REAL, inclination_deg REAL, direction TEXT,
    high_interest INTEGER, fetched_at TEXT)`);
  sqlite
    .prepare("INSERT INTO keeptrack_reentry VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(45414, "STARLINK-1309", "2026-10-31T02:00:00.000Z", 4, "2026-10-30T09:54:11.035Z", 12.5, 40.1, 53, "descending", 1, "2026-10-30T09:54:11.035Z");

  // Space weather: five consecutive days, deliberately with no gap.
  sqlite.exec("DROP TABLE IF EXISTS space_weather");
  sqlite.exec(`CREATE TABLE space_weather (
    day TEXT PRIMARY KEY, bsrn TEXT, nd REAL, kp_sum REAL, ap_avg REAL, cp REAL,
    c9 REAL, isn REAL, f107_obs REAL, f107_ctr81 REAL, f107_adj_ctr81 REAL, kp_json TEXT)`);
  const sw = sqlite.prepare("INSERT INTO space_weather (day, f107_obs, f107_adj_ctr81, kp_sum, ap_avg, cp, isn) VALUES (?,?,?,?,?,?,?)");
  sw.run("2026-10-26", 90.1, 92.0, 30, 4, 0.1, 10);
  sw.run("2026-10-27", 91.2, 93.0, 40, 5, 0.2, 15);
  sw.run("2026-10-28", 91.4, 94.0, 137, 7, 0.3, 6);
  sw.run("2026-10-29", 88.2, 95.0, 43, 2, 0.0, 20);
  sw.run("2026-10-30", 95.0, 97.7, 97, 5, 0.2, 27);

  // EOP: five consecutive MJD days.
  sqlite.exec("DROP TABLE IF EXISTS earth_orientation");
  sqlite.exec(`CREATE TABLE earth_orientation (
    mjd INTEGER PRIMARY KEY, x_arcsec REAL, y_arcsec REAL, ut1_utc_s REAL, lod_s REAL,
    dpsi_arcsec REAL, deps_arcsec REAL, dx_arcsec REAL, dy_arcsec REAL, dat_s REAL)`);
  const eop = sqlite.prepare("INSERT INTO earth_orientation (mjd, x_arcsec, y_arcsec, ut1_utc_s, lod_s) VALUES (?,?,?,?,?)");
  for (const mjd of [61338, 61339, 61340, 61341, 61342]) {
    eop.run(mjd, 0.14, 0.31, -0.05, 0.00072);
  }

  // Launches.
  sqlite.exec("DROP TABLE IF EXISTS keeptrack_upcoming_launch");
  sqlite.exec(`CREATE TABLE keeptrack_upcoming_launch (
    id TEXT PRIMARY KEY, name TEXT, net TEXT, status TEXT, vehicle TEXT, pad TEXT, fetched_at TEXT)`);
  const up = sqlite.prepare("INSERT INTO keeptrack_upcoming_launch VALUES (?,?,?,?,?,?,?)");
  up.run("a", "Falcon 9 | Starlink Group 15-18", "2026-10-31T03:48:00Z", "Go", "Falcon 9", "SLC-4E", "2026-10-30T09:54:14.095Z");
  up.run("b", "Electron | iQPS 9", "2026-11-02T16:00:00Z", "TBC", "Electron", "Unknown Pad", "2026-10-30T09:54:14.095Z");
  up.run("c", "GSLV Mk II | NVS-03", "2026-10-30T18:21:00Z", "Go", "GSLV Mk II", "SDP-2", "2026-10-30T09:54:14.095Z");

  sqlite.exec("DROP TABLE IF EXISTS keeptrack_launch_stat");
  sqlite.exec(`CREATE TABLE keeptrack_launch_stat (
    kind TEXT NOT NULL, key1 TEXT NOT NULL, key2 TEXT, launches INTEGER NOT NULL,
    successes INTEGER, failures INTEGER, fetched_at TEXT NOT NULL, PRIMARY KEY (kind, key1, key2))`);
  const stat = sqlite.prepare("INSERT INTO keeptrack_launch_stat VALUES (?,?,?,?,?,?,?)");
  stat.run("year", "2024", null, 262, 256, 6, "2026-10-30T09:54:13.088Z");
  stat.run("year", "2025", null, 330, 318, 12, "2026-10-30T09:54:13.088Z");
  stat.run("year", "2026", null, 254, 247, 7, "2026-10-30T09:54:13.088Z");
  stat.run("vehicle", "2025", "Falcon 9", 165, 165, 0, "2026-10-30T09:54:13.088Z");
  stat.run("vehicle", "2024", "Falcon 9", 132, 131, 1, "2026-10-30T09:54:13.088Z");
  stat.run("month", "2026-10", null, 21, 21, 0, "2026-10-30T09:54:13.088Z");

  sqlite.exec("DROP TABLE IF EXISTS space_track_boxscore");
  sqlite.exec(`CREATE TABLE space_track_boxscore (
    country TEXT PRIMARY KEY, spadoc_cd TEXT, orbital_payload INTEGER,
    orbital_rocket_body INTEGER, orbital_debris INTEGER, orbital_total INTEGER,
    decayed_payload INTEGER, decayed_rocket_body INTEGER, decayed_debris INTEGER,
    decayed_total INTEGER, country_total INTEGER)`);
  const box = sqlite.prepare("INSERT INTO space_track_boxscore VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  box.run("ALL", null, 19778, 2431, 12533, 35458, 19000, 3000, 13740, 35740, 71198);
  box.run("UNITED STATES OF AMERICA", null, 13968, 781, 3916, 18673, 6000, 900, 3916, 10816, 29489);
  box.run("PEOPLES REPUBLIC OF CHINA", null, 6203, 500, 2000, 6203, 2000, 300, 900, 3236, 9439);

  sqlite.exec("DROP TABLE IF EXISTS discos_fragmentation");
  sqlite.exec(`CREATE TABLE discos_fragmentation (
    discos_id TEXT PRIMARY KEY, epoch TEXT, event_type TEXT, latitude_deg REAL,
    longitude_deg REAL, altitude_km REAL, comment TEXT, objects_url TEXT,
    member_count INTEGER NOT NULL DEFAULT 0)`);
  const frag = sqlite.prepare("INSERT INTO discos_fragmentation (discos_id, epoch, event_type, altitude_km) VALUES (?,?,?,?)");
  frag.run("53", "1979-12-15", "Unknown", null);
  frag.run("1108", "2026-03-29", "Propulsion", 780);
  frag.run("1201", "2025-12-18", "Anomalous", null);
}

async function main(): Promise<void> {
  console.log("\n事件 / 环境 / 发射数据：读者依赖的那些形状\n");
  await seed();
  const q = await import("../src/lib/queries-events");

  // ------------------------------------------------------------- 再入
  await check("汇总区分预测行与历史行", () => {
    const s = q.reentrySummary(NOW);
    assert.equal(s.tipMessages, 3);
    assert.equal(s.tipUpcoming, 1, `未来 TIP ${s.tipUpcoming}`);
    assert.equal(s.decayRows, 4);
    assert.equal(s.decayHistorical, 3, `历史行 ${s.decayHistorical}`);
    assert.equal(s.decayPrediction, 1, `预测行 ${s.decayPrediction}`);
    assert.equal(s.decayedObjects, 2, `去重后的物体数 ${s.decayedObjects}`);
  });

  await check("预测中的再入只含未来时刻，两个源并列", () => {
    const rows = q.listUpcomingReentries(50, NOW);
    assert.equal(rows.length, 2, `返回 ${rows.length} 条`);
    assert.deepEqual(rows.map((r) => r.source).sort(), ["keeptrack", "space-track"]);
    for (const r of rows) {
      assert.ok(Date.parse(r.decayIso!) > NOW.getTime(), `过期行混入：${r.decayIso}`);
    }
    // Space-Track 靠 NORAD 对编目表取名，TIP 本身只有编号。
    const st = rows.find((r) => r.source === "space-track")!;
    assert.equal(st.name, "STARLINK-1283", String(st.name));
  });

  await check("最近再入只取历史记录，且不把预测当既成事实", () => {
    const rows = q.listRecentReentries(50);
    assert.equal(rows.length, 2, `返回 ${rows.length} 条`);
    assert.equal(rows[0].noradId, 45414, "最新再入应排在最前");
    // 45414 有历史行与预测行各一；预测行（04:20）不得被当成它的时刻。
    assert.equal(rows[0].decayIso, "2026-10-29T04:16:00.000Z", String(rows[0].decayIso));
    assert.ok(
      rows.every((r) => r.feed !== "tip"),
      "预测行混进了历史列表",
    );
  });

  await check("同一物体的多条历史消息只保留最新一条", () => {
    const rows = q.listRecentReentries(50);
    const old = rows.find((r) => r.noradId === 90001)!;
    assert.equal(old.decayIso, "2025-03-05T00:00:00.000Z", String(old.decayIso));
    assert.equal(old.name, "NEW-NAME", String(old.name));
  });

  await check("按年统计按物体去重，而不是按消息数", () => {
    const years = q.reentriesByYear(20);
    const total = years.reduce((s, y) => s + y.reentries, 0);
    // 三个历史行属于两个物体 → 合计必须是 2。
    assert.equal(total, 2, `合计 ${total}`);
    assert.equal(years[0].year, "2026");
  });

  // --------------------------------------------------------- 空间环境
  await check("天气序列连续且无缺口", () => {
    const s = q.spaceWeatherSummary();
    assert.equal(s.rows, 5);
    assert.equal(s.gaps, 0, `缺 ${s.gaps} 天`);
    assert.equal(s.firstDay, "2026-10-26");
    assert.equal(s.lastDay, "2026-10-30");
    assert.equal(s.latest?.f107Obs, 95);
  });

  await check("EOP 逐日连续，MJD 换算成日期", () => {
    const s = q.eopSummary();
    assert.equal(s.rows, 5);
    assert.equal(s.gaps, 0, `缺 ${s.gaps} 天`);
    // MJD 61342 = 2026-10-29
    assert.equal(s.latest?.day, "2026-10-29", String(s.latest?.day));
    assert.equal(q.mjdToDay(40587), "1970-01-01");
  });

  await check("空值保持为 null，不当成 0", async () => {
    const { getDb } = await import("../src/db");
    const { sqlite } = getDb();
    sqlite.prepare("INSERT INTO space_weather (day, f107_obs) VALUES ('2026-10-31', NULL)").run();
    const rows = q.listSpaceWeather(1);
    assert.equal(rows[0].f107Obs, null, `变成了 ${rows[0].f107Obs}`);
  });

  // ------------------------------------------------------ 发射与解体
  await check("待发射按计划时刻升序", () => {
    const rows = q.listUpcomingLaunches(10);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.netIso),
      ["2026-10-30T18:21:00Z", "2026-10-31T03:48:00Z", "2026-11-02T16:00:00Z"],
    );
  });

  await check("发射统计逐年倒序，只取 kind='year'", () => {
    const rows = q.launchStatsByYear(10);
    assert.deepEqual(rows.map((r) => r.year), [2026, 2025, 2024]);
    const vehicles = q.launchStatsByVehicle(10);
    assert.ok(vehicles.every((v) => v.vehicle === "Falcon 9"), "混入了非载具行");
    assert.equal(vehicles[0].year, 2025);
  });

  await check("boxscore 的 ALL 行不进国家列表", () => {
    const { rows, all } = q.listBoxscore(10);
    assert.equal(rows.length, 2);
    assert.ok(!rows.some((r) => r.country === "ALL"), "ALL 混进了国家列表");
    assert.equal(all?.orbitalTotal, 35458);
    assert.equal(rows[0].country, "UNITED STATES OF AMERICA");
  });

  await check("解体事件：缺坐标就是 null，成员数不臆造", () => {
    const s = q.fragmentationSummary();
    assert.equal(s.total, 3);
    assert.equal(s.withPosition, 1, `有坐标 ${s.withPosition}`);
    assert.equal(s.byType[0].events, 1);
    const rows = q.listFragmentations(10);
    assert.equal(rows[0].discosId, "1108", "应按 epoch 倒序");
    const noPosition = rows.find((r) => r.discosId === "53")!;
    assert.equal(noPosition.altitudeKm, null);
    assert.equal(noPosition.epoch, "1979-12-15", "日期不该被补上时刻");
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
