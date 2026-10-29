/**
 * Regression tests for the findings in `docs/ANALYSIS.md`.
 *
 * The analysis says specific things about the data — Spacebook's `entity/tle`
 * shares Space-Track's epoch, 92.8% of the XP-TLE disagreement is pure phase, the
 * three OMM encodings describe the same records. If any of those stop holding,
 * because a provider changed its publishing or a loader was altered, the claim in
 * the document becomes false while still reading as fact.
 *
 * So each headline number is asserted here, against the live database and the
 * archive. The tests skip, rather than fail, when the underlying data has not been
 * downloaded yet — a fresh checkout must not report a broken finding.
 */

import { existsSync } from "node:fs";

import { getDb } from "../src/db";
import { SourceArchive } from "../src/lib/sources/archive";
import { parseTleFile } from "../src/lib/orbit/tle";
import { propagateTle } from "../src/lib/orbit/sgp4";
import { SOURCES, sourceById } from "../src/lib/sources/registry";

let pass = 0;
let fail = 0;
let skipped = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
  }
}
function skip(name: string, why: string) {
  skipped += 1;
  console.log(`  skip ${name}  (${why})`);
}

async function main() {
  const { sqlite } = getDb();

  // ---------------------------------------------------------------- coverage
  console.log("\ncoverage");
  const counts = sqlite
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM object_sources WHERE source_id='space-track') AS st,
         (SELECT COUNT(*) FROM object_sources WHERE source_id='spacebook-entity-tle') AS sb,
         (SELECT COUNT(*) FROM object_sources a JOIN object_sources b ON a.norad_id=b.norad_id
           WHERE a.source_id='space-track' AND b.source_id='spacebook-entity-tle') AS both`,
    )
    .get() as { st: number; sb: number; both: number };

  if (counts.st === 0 || counts.sb === 0) {
    skip("Spacebook covers objects Space-Track lacks", "element sets not ingested");
  } else {
    const onlySb = counts.sb - counts.both;
    const onlySt = counts.st - counts.both;
    const union = onlySb + onlySt + counts.both;
    const missRate = onlySb / union;

    check(
      "Spacebook covers strictly more objects than Space-Track",
      onlySb > onlySt,
      `${onlySb} vs ${onlySt}`,
    );
    // The document claims 6.29%. Guard the order of magnitude, not the digit: the
    // catalogue changes daily and an exact assertion would fail for the wrong reason.
    check(
      "the gap is several percent of the catalogue",
      missRate > 0.03 && missRate < 0.15,
      `${(missRate * 100).toFixed(2)}%`,
    );
  }

  // --------------------------------------------------------------- freshness
  console.log("\nfreshness");
  if (counts.both === 0) {
    skip("entity/tle shares Space-Track's epoch", "not ingested");
  } else {
    const lag = sqlite
      .prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN ABS(julianday(a.epoch)-julianday(b.epoch)) < 1e-7
                                       THEN 1 ELSE 0 END) AS identical
           FROM object_sources a JOIN object_sources b ON a.norad_id=b.norad_id
          WHERE a.source_id='space-track' AND b.source_id='spacebook-entity-tle'
            AND a.epoch IS NOT NULL AND b.epoch IS NOT NULL`,
      )
      .get() as { n: number; identical: number };

    const share = lag.identical / Math.max(1, lag.n);
    check(
      "entity/tle and Space-Track agree on the epoch for nearly every object",
      share > 0.95,
      `${lag.identical}/${lag.n} = ${(share * 100).toFixed(2)}%`,
    );
  }

  // XP-TLE must be measurably older, or the "deprecated" note is wrong.
  const xpLag = sqlite
    .prepare(
      `SELECT AVG((julianday(a.epoch)-julianday(b.epoch))*24) AS h, COUNT(*) AS n
         FROM object_sources a JOIN object_sources b ON a.norad_id=b.norad_id
        WHERE a.source_id='space-track' AND b.source_id='spacebook-xp-tle'
          AND a.epoch IS NOT NULL AND b.epoch IS NOT NULL`,
    )
    .get() as { h: number | null; n: number };

  if (!xpLag.n) {
    skip("xp-tle is older than Space-Track", "xp-tle not ingested");
  } else {
    check("xp-tle is older than Space-Track", (xpLag.h ?? 0) > 24, `${(xpLag.h ?? 0).toFixed(1)} h`);
  }

  // The registry must encode what the data shows.
  const entity = sourceById("spacebook-entity-tle");
  const xp = sourceById("spacebook-xp-tle");
  check("registry: entity/tle is not marked stale", entity?.typicalLagHours === 0);
  check("registry: xp-tle is marked stale", (xp?.typicalLagHours ?? 0) > 24);
  check(
    "registry: entity/tle outranks xp-tle for trajectories",
    (entity?.trajectoryPriority ?? 99) < (xp?.trajectoryPriority ?? 99),
    `${entity?.trajectoryPriority} < ${xp?.trajectoryPriority}`,
  );

  // ------------------------------------------------------------- consistency
  console.log("\nconsistency");
  const shared = sqlite
    .prepare(
      `SELECT a.norad_id AS n
         FROM object_sources a JOIN object_sources b ON a.norad_id=b.norad_id
        WHERE a.source_id='space-track' AND b.source_id='spacebook-xp-tle'
          AND a.epoch IS NOT NULL AND b.epoch IS NOT NULL
          AND ABS(julianday(a.epoch)-julianday(b.epoch)) > 1e-7
        ORDER BY a.norad_id LIMIT 400`,
    )
    .all() as Array<{ n: number }>;

  if (shared.length < 20) {
    skip("phase dominates the XP-TLE disagreement", "not enough sample");
  } else {
    const fileStmt = sqlite.prepare(
      `SELECT t.state_source AS src, f.file_text AS text
         FROM trajectories t JOIN trajectory_files f ON f.trajectory_id = t.id
        WHERE t.object_id = (SELECT id FROM objects WHERE norad_id = ? LIMIT 1)
          AND t.state_source IN ('space-track','spacebook-xp-tle')`,
    );

    let phaseDominated = 0;
    let radialDominated = 0;
    let measured = 0;

    for (const { n } of shared) {
      const files = fileStmt.all(n) as Array<{ src: string; text: string }>;
      if (files.length < 2) continue;
      const tles = new Map<string, ReturnType<typeof parseTleFile>["tles"][number]>();
      for (const f of files) {
        const parsed = parseTleFile(f.text);
        if (parsed.tles[0]) tles.set(f.src, parsed.tles[0]);
      }
      const a = tles.get("space-track");
      const b = tles.get("spacebook-xp-tle");
      if (!a || !b) continue;

      const joint = Math.max(a.epochMs, b.epochMs);
      const sa = propagateTle(a, { startMs: joint, spanHours: 1, stepSeconds: 3_600 }).states[0];
      const sb = propagateTle(b, { startMs: joint, spanHours: 1, stepSeconds: 3_600 }).states[0];
      if (!sa || !sb) continue;

      const ra = Math.hypot(...sa.position);
      const rb = Math.hypot(...sb.position);
      const total = Math.hypot(
        sa.position[0] - sb.position[0],
        sa.position[1] - sb.position[1],
        sa.position[2] - sb.position[2],
      );
      if (total < 1) continue;
      measured += 1;
      const radial = Math.abs(ra - rb);
      if (radial / total < 0.1) phaseDominated += 1;
      if (radial / total > 0.5) radialDominated += 1;
    }

    check("the comparison produced positions", measured > 20, `${measured} objects`);
    const share = phaseDominated / Math.max(1, measured);
    check(
      "most disagreement is along-track phase, not a different orbit",
      share > 0.8,
      `${phaseDominated}/${measured} = ${(share * 100).toFixed(1)}%`,
    );
    // A few radial outliers are documented as needing review; the test guards
    // against them becoming the majority, which would invalidate the conclusion.
    check(
      "radial outliers stay a small minority",
      radialDominated / Math.max(1, measured) < 0.1,
      `${radialDominated}/${measured}`,
    );
  }

  // ------------------------------------------------------------ physical model
  console.log("\nphysical model");
  const phys = sqlite
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM discos_objects WHERE mass IS NOT NULL) AS withMass,
         (SELECT COUNT(*) FROM discos_objects) AS total,
         (SELECT COUNT(*) FROM discos_objects WHERE object_class='Payload' AND mass IS NOT NULL) AS payloadMass,
         (SELECT COUNT(*) FROM discos_objects WHERE object_class='Payload') AS payload,
         (SELECT COUNT(*) FROM discos_objects
           WHERE object_class='Payload Fragmentation Debris' AND mass IS NOT NULL) AS fragMass,
         (SELECT COUNT(*) FROM discos_objects
           WHERE object_class='Payload Fragmentation Debris') AS frag`,
    )
    .get() as Record<string, number>;

  if (phys.total === 0) {
    skip("payloads carry a mass", "DISCOS not imported");
  } else {
    check(
      "payloads almost always carry a mass",
      phys.payloadMass / Math.max(1, phys.payload) > 0.9,
      `${phys.payloadMass}/${phys.payload}`,
    );
    // The document's central caveat: debris has no physical model. If this ever
    // becomes false, the Pc-accuracy caveat must be revised.
    check(
      "fragmentation debris almost never carries a mass",
      phys.fragMass / Math.max(1, phys.frag) < 0.05,
      `${phys.fragMass}/${phys.frag}`,
    );
  }

  // ------------------------------------------------------------------ archive
  console.log("\ncross-format");
  const archive = new SourceArchive();
  const have = existsSync("data/archive/spacebook-omm-json");
  if (!have) {
    skip("OMM encodings describe the same records", "archive absent");
  } else {
    const countsByFormat: Record<string, number> = {};
    for (const [name, id] of [
      ["json", "spacebook-omm-json"],
      ["kvn", "spacebook-omm-kvn"],
      ["xml", "spacebook-omm-xml"],
    ] as const) {
      const text = await archive.latestText(id);
      if (!text) {
        countsByFormat[name] = -1;
        continue;
      }
      const ids = new Set<string>();
      for (const m of text.matchAll(/NORAD_CAT_ID["'>\s:=]*\s*<?["']?\s*(\d{1,6})/g)) ids.add(m[1]);
      countsByFormat[name] = ids.size;
    }
    const sizes = Object.values(countsByFormat);
    check(
      "all three encodings are present",
      sizes.every((s) => s > 0),
      JSON.stringify(countsByFormat),
    );
    check(
      "and report the same record count",
      new Set(sizes).size === 1,
      sizes.join(" / "),
    );
  }

  // -------------------------------------------------------------- invariants
  console.log("\nregistry invariants");
  check("every source declares a refresh cadence", SOURCES.every((s) => s.refreshMinutes > 0));
  check(
    "the OCM outranks every element-set source",
    SOURCES.filter((s) => s.format === "ocm" || s.format === "itc").every((ocm) =>
      SOURCES.filter((s) => s.format === "tle" || s.format === "omm").every(
        (tle) => ocm.trajectoryPriority < tle.trajectoryPriority,
      ),
    ),
  );

  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  if (fail > 0) process.exit(1);
}

void main();

export {};
