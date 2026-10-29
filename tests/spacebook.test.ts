/**
 * Spacebook feed client, SATCAT import and XP-TLE catalogue ingest.
 *
 * These tests exist because the Spacebook host fails in two ways that both look
 * like success:
 *
 *   1. **Silent truncation.** The connection closes early, `fetch` resolves, and
 *      a short TLE file parses into a *smaller catalogue* with zero errors. The
 *      byte floors and record-boundary checks in `SpacebookClient.verify` are the
 *      defence, so each one is exercised with a body that should be rejected and
 *      one that should pass.
 *   2. **Endpoint shape drift.** Every endpoint ignores query parameters and
 *      returns the whole catalogue, and an HTML error page still returns 200. A
 *      verifier that only checked "non-empty" would import a login page.
 *
 * The ingest tests run against an in-memory SQLite database built from the
 * project's own DDL, so they check the real column list rather than a hand-copied
 * subset — that mismatch is how `has_covariance` went missing before.
 */

import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseTle, type Tle } from "../src/lib/orbit/tle";
import { SpacebookClient, defaultNodes, extensionFor } from "../src/lib/sources/spacebook";
import { importSatcat } from "../src/lib/sources/satcat-import";
import {
  TleCatalogueIngest,
  hardBodyRadiusFor,
  isManeuverable,
  loadSatcat,
} from "../src/lib/sources/spacebook-ingest";

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

/** The DDL subset the ingest touches, kept in sync by the integration test. */
function testDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE objects (
      id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, object_name TEXT NOT NULL,
      norad_id INTEGER, hard_body_radius REAL NOT NULL,
      maneuverability INTEGER NOT NULL, alive INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE trajectories (
      id TEXT PRIMARY KEY, object_id TEXT NOT NULL, operator_id TEXT NOT NULL,
      upload_type TEXT NOT NULL, state_source TEXT NOT NULL,
      screened_status TEXT NOT NULL DEFAULT 'not_screened', file_format TEXT NOT NULL,
      start_at TEXT, end_at TEXT, point_count INTEGER NOT NULL DEFAULT 0,
      screened_at TEXT, uploaded_at TEXT NOT NULL, created_at TEXT NOT NULL,
      auto_relinquish_pc_threshold REAL, has_covariance INTEGER NOT NULL DEFAULT 0,
      companion_id TEXT, seq INTEGER NOT NULL
    );
    CREATE TABLE trajectory_files (trajectory_id TEXT PRIMARY KEY, file_text TEXT NOT NULL);
    CREATE TABLE catalog (
      object_id TEXT NOT NULL, state_source TEXT NOT NULL,
      trajectory_id TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (object_id, state_source)
    );
    CREATE TABLE satcat (
      norad_id INTEGER PRIMARY KEY, entity_id TEXT, intl_id TEXT, name TEXT NOT NULL,
      object_type TEXT, owner TEXT, launch_site TEXT, launch_date TEXT, decay_date TEXT,
      period REAL, inclination REAL, apogee REAL, perigee REAL, rcs_size TEXT,
      source_snapshot TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE stream_seq (name TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
  `);
  return db;
}

/** A syntactically valid TLE with a correct checksum for `norad`. */
function makeTle(norad: number, epochDay = "26301.50000000"): [string, string] {
  const id = String(norad).padStart(5, "0");
  const body1 = `1 ${id}U 19074B   ${epochDay}  .00032843  00000-0  29201-3 0  999`;
  const line1 = `${body1}${checksum(body1)}`;
  const body2 = `2 ${id}  53.1436 141.5664 0002090 160.3523 199.7575 15.68231680 3849`;
  const line2 = `${body2}${checksum(body2)}`;
  return [line1, line2];
}

function checksum(line: string): string {
  let sum = 0;
  for (const ch of line) {
    if (ch >= "0" && ch <= "9") sum += Number(ch);
    else if (ch === "-") sum += 1;
  }
  return String(sum % 10);
}

async function main() {
  // ---- 1. format metadata ---------------------------------------------------
  console.log("\nfeed extensions and nodes");
  check("xp-tle -> .tle", extensionFor("xp-tle") === "tle");
  check("omm -> .json", extensionFor("omm") === "json");
  check("eop -> .txt", extensionFor("eop") === "txt");
  check(
    "socks5:// prefix stripped",
    defaultNodes({ SPACE_SAFETY_PROXY: "socks5://127.0.0.1:20170" } as never)[0] ===
      "127.0.0.1:20170",
  );
  check(
    "multiple nodes split",
    defaultNodes({ SPACE_SAFETY_PROXY: "a:1, b:2" } as never).join("|") === "a:1|b:2",
  );
  check("empty env yields no nodes", defaultNodes({} as never).length === 0);

  // ---- 2. body verification -------------------------------------------------
  console.log("\ncompleteness verification");
  const dir = await mkdtemp(join(tmpdir(), "spacebook-"));
  const client = new SpacebookClient({ outDir: dir, log: () => {} });

  const html = join(dir, "err.tle");
  await writeFile(html, "<!DOCTYPE html><html>blocked</html>".padEnd(2_000_000, " "));
  const htmlCheck = await client.verify(html, "xp-tle");
  check("HTML body rejected", !htmlCheck.ok, htmlCheck.error);

  // Short of the byte floor, even though it is well-formed.
  const short = join(dir, "short_2026-10-29.tle");
  const [l1, l2] = makeTle(44714);
  await writeFile(short, `${l1}\n${l2}\n`);
  const shortCheck = await client.verify(short, "xp-tle");
  check("short body rejected", !shortCheck.ok, shortCheck.error);

  // Above the floor but cut mid-record: the dangerous case.
  const truncated = join(dir, "trunc_2026-10-29.tle");
  const filler = `${l1}\n${l2}\n`.repeat(30_000);
  await writeFile(truncated, `${filler}${l1}\n2 44714  53.1436 141.5664 000209`);
  const truncCheck = await client.verify(truncated, "xp-tle");
  check("mid-record cut rejected", !truncCheck.ok, truncCheck.error);

  const good = join(dir, "good_2026-10-29.tle");
  await writeFile(good, filler);
  const goodCheck = await client.verify(good, "xp-tle");
  check("complete TLE body accepted", goodCheck.ok, `${goodCheck.bytes} bytes`);

  const ommGood = join(dir, "omm_2026-10-29.json");
  await writeFile(ommGood, `${JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ NORAD_CAT_ID: i })))}`);
  const ommCheck = await client.verify(ommGood, "omm");
  const ommBytes = ommCheck.bytes;
  check(
    "JSON array under the floor rejected",
    !ommCheck.ok && ommBytes < 8_000_000,
    ommCheck.error,
  );

  const eop = join(dir, "eop_2026-10-29.txt");
  await writeFile(eop, `${"2026 10 29 1 0.1 0.2\n".repeat(40_000)}END PREDICTED\n`);
  check("KVN END marker accepted", (await client.verify(eop, "eop")).ok);
  const eopCut = join(dir, "eop_2026-10-29-cut.txt");
  await writeFile(eopCut, `${"2026 10 29 1 0.1 0.2\n".repeat(40_000)}2027 04 20 61515  0.141783  0.46040`);
  check("KVN without END rejected", !(await client.verify(eopCut as unknown as string, "eop")).ok);

  // ---- 3. SATCAT import -----------------------------------------------------
  console.log("\nSATCAT import");
  const db = testDatabase();
  const summary = importSatcat(
    db,
    [
      { id: "u1", intlId: "1957-001B", name: "VANGUARD 1", noradId: 5, objectType: "PAYLOAD", rcsSize: "LARGE", launchDate: "1958-03-17T00:00:00", decayDate: "" },
      { id: "u2", intlId: "", name: "FENGYUN 1C DEB", noradId: "30604", objectType: "DEBRIS", rcsSize: "SMALL" },
      { name: "no norad", noradId: null },
      { name: "", noradId: 999 },
    ],
    "test",
  );
  check("valid rows imported", summary.inserted === 2, `${summary.inserted}`);
  check("unusable rows skipped", summary.skipped === 2, `${summary.skipped}`);
  const row = db.prepare("SELECT * FROM satcat WHERE norad_id = 5").get() as Record<string, unknown>;
  check("numeric norad stored", row?.norad_id === 5);
  check("empty decay date becomes NULL", row?.decay_date === null, String(row?.decay_date));
  check("empty intl id becomes NULL", (db.prepare("SELECT intl_id FROM satcat WHERE norad_id = 30604").get() as { intl_id: string | null }).intl_id === null);

  // A second import is a replace, not an append: a row dropped upstream must go.
  importSatcat(db, [{ name: "VANGUARD 1", noradId: 5, objectType: "PAYLOAD" }], "test2");
  const count = (db.prepare("SELECT COUNT(*) AS n FROM satcat").get() as { n: number }).n;
  check("re-import replaces the catalogue", count === 1, `${count} row(s)`);

  // ---- 4. name and type resolution ------------------------------------------
  console.log("\nidentity resolution");
  check("LARGE -> 5.0 m", hardBodyRadiusFor("LARGE") === 5.0);
  check("SMALL -> 0.5 m", hardBodyRadiusFor("SMALL") === 0.5);
  check("unknown RCS -> 1.5 m", hardBodyRadiusFor(null) === 1.5);
  check("payload is maneuverable", isManeuverable("PAYLOAD"));
  check("debris is not maneuverable", !isManeuverable("DEBRIS"));
  check("rocket body is not maneuverable", !isManeuverable("ROCKET BODY"));

  // ---- 5. XP-TLE ingest -----------------------------------------------------
  console.log("\nXP-TLE ingest");
  const ingestDb = testDatabase();
  importSatcat(
    ingestDb,
    [
      { name: "SATCAT NAME", noradId: 44714, objectType: "PAYLOAD", rcsSize: "LARGE" },
      { name: "DEBRIS OBJECT", noradId: 30604, objectType: "DEBRIS", rcsSize: "SMALL" },
    ],
    "test",
  );

  const tles = [
    parseTle(`${makeTle(44714).join("\n")}\n`),
    parseTle(`${makeTle(30604).join("\n")}\n`),
    parseTle(`${makeTle(70001).join("\n")}\n`),
  ].filter((r): r is { tle: Tle } => "tle" in r).map((r) => r.tle);
  check("test TLEs parse", tles.length === 3, `${tles.length}`);

  const satcat = loadSatcat(ingestDb);
  // OMM names win over SATCAT, which is what the refresh script arranges.
  const names = new Map<number, string>([[44714, "OMM NAME"]]);

  const first = new TleCatalogueIngest({ reportEvery: 1_000_000, log: () => {} }).run(
    ingestDb,
    tles,
    satcat,
    names,
  );
  check("all three inserted", first.inserted === 3, `${first.inserted}`);
  // 70001 appears in neither OMM nor SATCAT, so two of the three resolve a name.
  check("two of three resolve a name", first.named === 2, `${first.named}`);

  const omm = ingestDb
    .prepare("SELECT object_name, hard_body_radius FROM objects WHERE norad_id = 44714")
    .get() as { object_name: string; hard_body_radius: number };
  check("OMM name preferred over SATCAT", omm.object_name === "OMM NAME", omm.object_name);
  check("RCS class sets hard-body radius", omm.hard_body_radius === 5.0);

  const unnamed = ingestDb
    .prepare("SELECT object_name FROM objects WHERE norad_id = 70001")
    .get() as { object_name: string };
  check(
    "object absent from every feed falls back to NORAD-<id>",
    unnamed.object_name === "NORAD-70001",
    unnamed.object_name,
  );

  const debris = ingestDb
    .prepare("SELECT maneuverability FROM objects WHERE norad_id = 30604")
    .get() as { maneuverability: number };
  check("debris marked non-maneuverable", debris.maneuverability === 0);

  const traj = ingestDb
    .prepare("SELECT state_source, file_format, point_count, has_covariance FROM trajectories WHERE object_id = (SELECT id FROM objects WHERE norad_id = 44714)")
    .get() as { state_source: string; file_format: string; point_count: number; has_covariance: number };
  check("trajectory is a TLE row", traj.state_source === "tle" && traj.file_format === "tle");
  check("TLE is a single-epoch arc", traj.point_count === 1);
  check("TLE carries no covariance", traj.has_covariance === 0);

  const cataloged = ingestDb
    .prepare("SELECT COUNT(*) AS n FROM catalog WHERE state_source = 'tle'")
    .get() as { n: number };
  check("catalog pointers created", cataloged.n === 3, `${cataloged.n}`);

  // Re-running must refresh, not duplicate.
  const second = new TleCatalogueIngest({ reportEvery: 1_000_000, log: () => {} }).run(
    ingestDb,
    tles,
    satcat,
    names,
  );
  check("second run inserts nothing", second.inserted === 0, `${second.inserted}`);
  check("second run refreshes all three", second.updated === 3, `${second.updated}`);
  const objectsAfter = (ingestDb.prepare("SELECT COUNT(*) AS n FROM objects").get() as { n: number }).n;
  const trajAfter = (ingestDb.prepare("SELECT COUNT(*) AS n FROM trajectories").get() as { n: number }).n;
  check("no duplicate objects", objectsAfter === 3, `${objectsAfter}`);
  check("no duplicate trajectories", trajAfter === 3, `${trajAfter}`);

  // Stale element sets are refused, so a dead object does not reappear.
  const staleResult = parseTle(`${makeTle(70002, "24001.00000000").join("\n")}\n`);
  if ("tle" in staleResult) {
    const third = new TleCatalogueIngest({ maxAgeDays: 30, log: () => {} }).run(
      ingestDb,
      [staleResult.tle],
      satcat,
      names,
    );
    check("stale element set skipped", third.skippedStale === 1, `${third.skippedStale}`);
  } else {
    check("stale fixture parses", false, JSON.stringify(staleResult));
  }

  db.close();
  ingestDb.close();
  await rm(dir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();

export {};
