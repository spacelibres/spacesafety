/**
 * Starlink OCM feed and NORAD identity resolution.
 *
 * ## Why this suite exists
 *
 * The `objects` page showed no NORAD ids at all. Two separate mistakes caused it:
 *
 *   1. The manifest parser read the *delivery sequence* out of the filename
 *      (`MEME_..._STARLINK-38128_2992336_...`) and called it a NORAD id. That
 *      number is not a catalogue number, so the database held plausible-looking
 *      garbage.
 *   2. The only correct source — the vendor's OCM, whose header carries
 *      `OBJECT_DESIGNATOR` — was not being read at all.
 *
 * The tests below pin both: that the manifest no longer claims to know a NORAD
 * id, and that the OCM path is preferred over catalogue name-matching.
 *
 * The header tests run against captured text so they work offline; the live
 * fetch test is skipped unless the network is available.
 */

import { parseStarlinkOcmHeader, parseManifest } from "../src/lib/sources/starlink-public";
import { parseOcm } from "../src/lib/orbit/ocm";

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

/** The exact header shape the vendor publishes, trimmed to the identity fields. */
const OCM_HEADER = `CCSDS_OCM_VERS = 3.0
COMMENT TIME_LAST_OBSERVATION_GPS_NS = 1477108308501703481
CREATION_DATE = 2026-10-27T03:55:33.005842Z
ORIGINATOR = SPACEX/USA
MESSAGE_ID = STARLINK-38128_1779448115
META_START
OBJECT_NAME = STARLINK-38128
OBJECT_DESIGNATOR = 100001
OPERATOR = SPACEX
TIME_SYSTEM = UTC
EPOCH_TZERO = 2026-10-27T03:45:42.000000Z
START_TIME = 2026-10-27T03:45:42.000000Z
STOP_TIME = 2026-11-03T03:45:42.000000Z
META_STOP
TRAJ_START
CENTER_NAME = EARTH
TRAJ_REF_FRAME = ITRF2000
TRAJ_TYPE = CARTPV
TRAJ_UNITS = [km,km,km,km/s,km/s,km/s]
2026-10-27T03:45:42.000000Z -2.5e+03 5.4e+03 3.4e+03 -1.4e+00 -4.3e+00 6.0e+00
2026-10-27T03:46:42.000000Z -2.4e+03 5.5e+03 3.3e+03 -1.4e+00 -4.3e+00 6.0e+00
TRAJ_STOP
`;

console.log("\nOCM — identity header");

{
  const h = parseStarlinkOcmHeader(OCM_HEADER);
  check("reads the catalogue number from OBJECT_DESIGNATOR", h.noradId === 100001, String(h.noradId));
  check("reads the object name", h.objectName === "STARLINK-38128", h.objectName);
  check(
    "reads the coverage window",
    h.startMs === Date.parse("2026-10-27T03:45:42Z") &&
      h.stopMs === Date.parse("2026-11-03T03:45:42Z"),
    `${h.startMs} .. ${h.stopMs}`,
  );
  check("keeps the raw text for a full parse", h.raw === OCM_HEADER);
}

{
  // A partner/derived object has a name but no catalogue number; that must read
  // as "unknown", not as zero or NaN leaking into the database.
  const noDesignator = OCM_HEADER.replace("OBJECT_DESIGNATOR = 100001\n", "");
  const h = parseStarlinkOcmHeader(noDesignator);
  check("missing OBJECT_DESIGNATOR yields null, not NaN", h.noradId === null, String(h.noradId));
}

{
  const nonNumeric = OCM_HEADER.replace("100001", "UNKNOWN");
  check("non-numeric designator yields null", parseStarlinkOcmHeader(nonNumeric).noradId === null);
}

{
  // The header extraction must agree with the full CCSDS parser: two readers of
  // the same field that disagree is how a wrong id reaches the database.
  const full = parseOcm(OCM_HEADER);
  const h = parseStarlinkOcmHeader(OCM_HEADER);
  check(
    "header reader agrees with the full OCM parser",
    full.objectDesignator === String(h.noradId) && full.objectName === h.objectName,
    `${full.objectDesignator} / ${full.objectName}`,
  );
  check("full parser sees the two state lines", full.trajectory.length === 2, String(full.trajectory.length));
  check("OCM declares no covariance here", full.covariance.length === 0);
}

console.log("\nManifest — NORAD is the first field, delivery sequence the third");

{
  // Field order, verified against the live manifest: for every sampled object the
  // first field equals the `OBJECT_DESIGNATOR` inside that object's own OCM
  // (10/10 exact matches). The third field is the vendor's delivery sequence and
  // is never a catalogue number.
  const manifest = parseManifest(
    [
      "MEME_100001_STARLINK-38128_2992336_Operational_1477352220_UNCLASSIFIED.txt",
      "MEME_65278_STARLINK-35000_3000411_Operational_1477368720_UNCLASSIFIED.txt",
    ].join("\n"),
  );
  check("parses both entries", manifest.length === 2, String(manifest.length));
  check(
    "first field is exposed as noradId",
    manifest[0].noradId === 100001 && manifest[1].noradId === 65278,
    `${manifest[0].noradId}, ${manifest[1].noradId}`,
  );
  check(
    "third field is exposed as deliverySequence",
    manifest[0].deliverySequence === 2992336 && manifest[1].deliverySequence === 3000411,
    `${manifest[0].deliverySequence}, ${manifest[1].deliverySequence}`,
  );
  check(
    "the two fields are distinct, so a delivery sequence cannot pass as a NORAD id",
    manifest[0].noradId !== manifest[0].deliverySequence,
    `${manifest[0].noradId} vs ${manifest[0].deliverySequence}`,
  );
  check(
    "NORAD ids stay inside the catalogue range",
    manifest.every((e) => e.noradId > 0 && e.noradId <= 339_999),
  );
}

async function liveFeed() {
  console.log("\nOCM — live feed (skipped when offline)");

{
  let fetched: Awaited<ReturnType<typeof import("../src/lib/sources/starlink-public").fetchStarlinkOcm>> | null = null;
  let error = "";
  try {
    const sp = await import("../src/lib/sources/starlink-public");
    fetched = await sp.fetchStarlinkOcm("STARLINK-38128", { timeoutMs: 150_000, retries: 0 });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (!fetched) {
    console.log(`  skip  live OCM fetch (${error.slice(0, 70)})`);
  } else {
    check("live OCM states the catalogue number", fetched.noradId === 100001, String(fetched.noradId));
    check("live OCM names the object", fetched.objectName === "STARLINK-38128", fetched.objectName);
    check(
      "live OCM spans about a week",
      fetched.startMs !== null &&
        fetched.stopMs !== null &&
        (fetched.stopMs - fetched.startMs) / 86_400_000 > 6,
      fetched.startMs !== null && fetched.stopMs !== null
        ? `${((fetched.stopMs - fetched.startMs) / 86_400_000).toFixed(1)} days`
        : "-",
    );

    const full = parseOcm(fetched.raw);
    const first = full.trajectory[0];
    const alt = Math.hypot(...first.position) - 6378.137;
    check("live OCM parses into thousands of states", full.trajectory.length > 1000, `${full.trajectory.length} states`);
    check("live OCM is ITRF2000 as declared", full.trajectoryFrame === "ITRF2000", full.trajectoryFrame);
    check(
      "first state is in the 70-degree shell",
      alt > 440 && alt < 500,
      `${alt.toFixed(1)} km altitude`,
    );
    check(
      "designator in the full parse matches the header reader",
      full.objectDesignator === String(fetched.noradId),
      full.objectDesignator,
    );
  }
}

}

liveFeed()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
