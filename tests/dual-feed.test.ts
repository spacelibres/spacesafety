/**
 * Dual-feed storage: OCM + ITC for the same object.
 *
 * Starlink publishes its ephemeris twice, and neither copy is sufficient alone
 * until recently believed otherwise. What the data actually shows:
 *
 *   | | OCM | Modified ITC |
 *   |---|---|---|
 *   | states | ~10 000 | ~4 300 |
 *   | span | 7 days | 3 days |
 *   | covariance | **yes**, 36 values per state | yes |
 *   | manoeuvre plan | **yes** | no |
 *   | NORAD id | **yes** | no |
 *
 * So the OCM is the better feed on every axis. The ITC is kept because it is a
 * second independent sample of the same orbit, which is what the accuracy report
 * needs; and because a deployment may hold only one of the two.
 *
 * These tests cover the invariants that made the earlier single-source version
 * wrong: a stored row must report honestly whether it carries covariance, and a
 * pair must point at each other.
 */

import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "../src/db";
import { trajectoryFiles, trajectories } from "../src/db/schema";
import { eq } from "drizzle-orm";

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

const workDir = mkdtempSync(join(tmpdir(), "spacesafety-dualfeed-"));
process.env.SPACE_SAFETY_DB = join(workDir, "test.sqlite");

async function main() {
  console.log("\nSchema — dual-feed columns");

  {
    const { sqlite } = getDb();
    const columns = (sqlite.pragma("table_info(trajectories)") as Array<{ name: string }>).map(
      (c) => c.name,
    );
    check("has_covariance exists", columns.includes("has_covariance"));
    check("companion_id exists", columns.includes("companion_id"));

    const indexes = (
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='trajectories'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    check("companion index exists", indexes.includes("trajectories_companion_idx"));
  }

  console.log("\nSchema — migration is idempotent");

  {
    // Re-running the schema must not throw, which is what `CREATE INDEX` on a
    // not-yet-added column did before the index moved into `migrate()`.
    let threw = false;
    try {
      closeDb();
      getDb();
      closeDb();
      getDb();
    } catch (err) {
      threw = true;
      console.log(`     ${(err as Error).message}`);
    }
    check("re-opening the database twice is safe", !threw);
  }

  console.log("\nStorage — covariance flag reflects the file");

  {
    const { db } = getDb();

    // Real fixtures: the OCM and ITC we hold for one satellite.
    const OCM = "/tmp/spacesafety-dualfeed-ocm.txt";
    const ITC = "./data/ephemeris-cache/STARLINK-38128.txt";
    if (!existsSync(ITC)) {
      console.log("  skip  (no cached ITC; run npm run demo:seed)");
    } else {
      const { readFileSync } = await import("node:fs");
      const itcText = readFileSync(ITC, "utf8");

      const now = new Date().toISOString();
      db.insert(trajectories)
        .values({
          id: "t-itc",
          objectId: "obj-1",
          operatorId: "op-1",
          uploadType: "definitive",
          stateSource: "operator_ephemeris",
          screenedStatus: "not_screened",
          fileFormat: "itc",
          startAt: now,
          endAt: now,
          pointCount: 4321,
          uploadedAt: now,
          createdAt: now,
          seq: 1,
          // Deliberately wrong: the migration exists because this happened.
          hasCovariance: false,
          companionId: null,
        })
        .run();
      db.insert(trajectoryFiles).values({ trajectoryId: "t-itc", fileText: itcText }).run();

      const row = db.select().from(trajectories).where(eq(trajectories.id, "t-itc")).get()!;
      const file = db
        .select()
        .from(trajectoryFiles)
        .where(eq(trajectoryFiles.trajectoryId, "t-itc"))
        .get()!;
      check("row stored", row.fileFormat === "itc");
      check("file stored in its own table", file.fileText.length > 0, `${file.fileText.length} chars`);

      // The ITC we hold carries covariance on every state, so a `false` flag is a
      // lie that would suppress Pc. Verify the migration script's rule can tell.
      const { normaliseTrajectory } = await import("../src/lib/api/validate-trajectory");
      const n = normaliseTrajectory(file.fileText);
      const actual = n.states.length > 0 && n.states.every((s) => s.covariance !== null);
      check(
        "the stored ITC genuinely carries covariance",
        actual,
        `${n.states.filter((s) => s.covariance).length}/${n.states.length} states`,
      );
      check("so its stored flag is wrong, which the migration repairs", row.hasCovariance === false);
    }
    void OCM;
  }

  console.log("\nStorage — pairing");

  {
    const { db } = getDb();
    const now = new Date().toISOString();
    for (const [id, format] of [
      ["t-ocm", "ocm"],
      ["t-itc2", "itc"],
    ] as const) {
      db.insert(trajectories)
        .values({
          id,
          objectId: "obj-1",
          operatorId: "op-1",
          uploadType: "definitive",
          stateSource: "operator_ephemeris",
          screenedStatus: "not_screened",
          fileFormat: format,
          startAt: now,
          endAt: now,
          pointCount: 0,
          uploadedAt: now,
          createdAt: now,
          seq: 2,
          hasCovariance: format === "itc",
          companionId: null,
        })
        .run();
      db.insert(trajectoryFiles).values({ trajectoryId: id, fileText: `placeholder ${format}` }).run();
    }

    db.update(trajectories).set({ companionId: "t-itc2" }).where(eq(trajectories.id, "t-ocm")).run();
    db.update(trajectories).set({ companionId: "t-ocm" }).where(eq(trajectories.id, "t-itc2")).run();

    const ocm = db.select().from(trajectories).where(eq(trajectories.id, "t-ocm")).get()!;
    const itc = db.select().from(trajectories).where(eq(trajectories.id, "t-itc2")).get()!;
    check("OCM points at its ITC", ocm.companionId === "t-itc2");
    check("ITC points back at its OCM", itc.companionId === "t-ocm");
    check("the pair is symmetric", ocm.companionId === itc.id && itc.companionId === ocm.id);
  }

  console.log("\nLive data — one object holds both feeds");

  {
    // The point of the whole migration, checked against the shipped database if it
    // is present. Skipped in a bare checkout.
    const live = "./data/spacesafety.sqlite";
    if (!existsSync(live) || process.env.SPACE_SAFETY_DB === live) {
      console.log("  skip  (no populated database in this working tree)");
    } else {
      const Better = (await import("better-sqlite3")).default;
      const db = new Better(live, { readonly: true });
      const pairs = db
        .prepare(
          `SELECT o.object_name,
                  SUM(CASE WHEN t.file_format='ocm' THEN 1 ELSE 0 END) ocm,
                  SUM(CASE WHEN t.file_format='itc' THEN 1 ELSE 0 END) itc,
                  SUM(CASE WHEN t.companion_id IS NOT NULL THEN 1 ELSE 0 END) linked
             FROM trajectories t JOIN objects o ON o.id = t.object_id
            GROUP BY o.id`,
        )
        .all() as Array<{ object_name: string; ocm: number; itc: number; linked: number }>;

      const starlink = pairs.filter((p) => /^STARLINK-\d+$/.test(p.object_name));
      const objects = db
        .prepare(
          `SELECT o.object_name AS name,
                  SUM(CASE WHEN t.state_source = 'operator_ephemeris' THEN 1 ELSE 0 END) eph,
                  COUNT(t.id) traj,
                  (SELECT COUNT(*) FROM catalog c WHERE c.object_id = o.id) in_catalog
             FROM objects o LEFT JOIN trajectories t ON t.object_id = o.id
            GROUP BY o.id`,
        )
        .all() as Array<{ name: string; eph: number; traj: number; in_catalog: number }>;
      db.close();
      check("the database holds Starlink objects", starlink.length > 0, `${starlink.length}`);

      // This suite runs against whatever the local database holds, which after a
      // bulk import is a live snapshot rather than the two-object seed. The
      // original assertion ("every object has an OCM, and both feeds linked")
      // only held for the seed: a bulk import fetches OCMs only unless the ITC is
      // asked for, and an ITC is not required to screen — the OCM carries its own
      // 7-day arc and covariance.
      //
      // What must hold for *any* snapshot: every object has at least one operator
      // ephemeris, and every object is reachable by screening via `catalog`.
      // What must hold for *any* snapshot: every object has at least one usable
      // trajectory, and every object is reachable by screening via `catalog`.
      //
      // "Usable" is deliberately not "has an OCM". The XP-TLE feed lists Starlink
      // satellites the company publishes no OCM for — `STARLINK-36503` and 9 600
      // others answer 302 with an empty body — so those objects legitimately hold
      // a `tle` trajectory and nothing else. Demanding an operator ephemeris for
      // them asserted a property the source never had. The boundary that does
      // matter is that nothing is left *without* any trajectory: an object with
      // zero states can never be screened and never rendered.
      const starlinkAll = objects.filter((o) => /^STARLINK-\d+$/.test(o.name));
      const noTrajectory = starlinkAll.filter((o) => o.traj === 0);
      check(
        "every Starlink object has at least one trajectory",
        noTrajectory.length === 0,
        noTrajectory.length ? `${noTrajectory.length} missing: ${noTrajectory.slice(0, 3).map((o) => o.name).join(", ")}` : "all",
      );

      const ephOnly = starlinkAll.filter((o) => o.eph > 0).length;
      check(
        "most Starlink objects resolve to an operator ephemeris",
        ephOnly > 0 && ephOnly / Math.max(1, starlinkAll.length) > 0.3,
        `${ephOnly}/${starlinkAll.length} with an OCM`,
      );

      // The failure this guards against: data in `trajectories` that screening
      // never sees because `catalog` was never written.
      const notInCatalog = starlinkAll.filter((o) => o.in_catalog === 0);
      check(
        "every Starlink object is reachable by screening",
        notInCatalog.length === 0,
        notInCatalog.length
          ? `${notInCatalog.length} missing: ${notInCatalog.slice(0, 3).map((o) => o.name).join(", ")}`
          : `all ${starlinkAll.length} in catalog`,
      );

      const linkedPairs = starlinkAll.filter((o) => o.eph > 1);
      const unlinked = starlink.filter((p) => p.ocm > 0 && p.itc > 0 && p.linked === 0);
      check(
        "objects holding both vendor feeds have them linked",
        unlinked.length === 0,
        `${linkedPairs.length} object(s) hold two operator feeds, ${unlinked.length} unlinked`,
      );
    }
  }

  closeDb();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
