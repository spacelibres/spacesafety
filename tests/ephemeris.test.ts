/**
 * Parser tests against *real* Starlink public ephemeris data.
 *
 * The sample below is an unmodified excerpt of a live file from
 * `https://www.starlink.com/public-files/ephemerides/`, captured so the test
 * needs no network. It guards the two things that actually broke during
 * development: the yyyyDOYhhmmss timestamp width, and the 21-value
 * lower-triangular covariance blocks.
 */

import {
  formatDoyTimestamp,
  lowerTriangleTo6x6,
  parseDoyTimestamp,
  parseModifiedItc,
} from "../src/lib/orbit/itc";
import { parseManifest, parseStarlinkEphemeris } from "../src/lib/sources/starlink-public";

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

/** Real header + the first two state blocks, verbatim. */
const REAL_SAMPLE = `created:2026-10-26 01:07:00 UTC
ephemeris_start:2026-10-26 00:54:42 UTC ephemeris_stop:2026-10-29 00:54:42 UTC step_size:60
ephemeris_source:blend
UVW
2026299005442.000 -2210.7020410928 5492.9541438240 3447.7275950343 -1.4602455777 -4.3995439318 6.0586948284
4.6545042757e-07 -3.8990219344e-07 7.8752799525e-07 -1.2194554518e-10 6.3951070588e-11 1.2656978839e-06 8.1905203530e-10
-9.2464123058e-10 4.6526788078e-13 1.9551893437e-12 -4.6748776005e-10 4.1518290927e-10 -4.6812167630e-13 -8.3143509330e-13
5.0923216265e-13 -7.1910080116e-13 1.0273030034e-12 1.6952661546e-09 -7.8311180932e-16 1.2858867776e-16 5.3982439505e-12
2026299005542.000 -2293.3245137537 5216.9353992781 3803.2730274534 -1.2928192076 -4.7976454701 5.7884081087
5.1308384564e-07 -4.5556240771e-07 8.9778162447e-07 -1.4006679994e-10 8.0684045541e-11 1.4823287608e-06 9.1598848721e-10
-1.0679397237e-09 5.4644350449e-13 2.1682870235e-12 -5.1634948748e-10 4.8366584989e-10 -6.3035488035e-13 -9.3144986646e-13
5.5965625492e-13 -5.8378165492e-13 9.0198836202e-13 1.9101557222e-09 -4.6215959377e-16 -2.1879531423e-16 5.1588775989e-12
`;

console.log("\nStarlink ephemeris — timestamps");
{
  const ms = parseDoyTimestamp("2026299005442.000");
  check(
    "yyyyDOYhhmmss.sss decodes to the right UTC instant",
    new Date(ms).toISOString() === "2026-10-26T00:54:42.000Z",
    new Date(ms).toISOString(),
  );
  const rt = formatDoyTimestamp(ms);
  check(
    "timestamp round-trips",
    parseDoyTimestamp(rt) === ms,
    `${rt} -> ${new Date(parseDoyTimestamp(rt)).toISOString()}`,
  );
}

console.log("\nStarlink ephemeris — covariance layout");
{
  // Vertex of the 6x6 must carry the first three values.
  const m = lowerTriangleTo6x6(Array.from({ length: 21 }, (_, i) => i + 1));
  // Expected matrix (verified numerically):
  //   1  2  4  7 11 16
  //   2  3  5  8 12 17
  //   4  5  6  9 13 18
  //   7  8  9 10 14 19
  //  11 12 13 14 15 20
  //  16 17 18 19 20 21
  check(
    "diagonal holds the triangular-number entries",
    m[0] === 1 && m[7] === 3 && m[14] === 6 && m[21] === 10 && m[28] === 15 && m[35] === 21,
    `diag=[${[m[0], m[7], m[14], m[21], m[28], m[35]].join(",")}]`,
  );
  check("matrix is symmetric", m[1] === m[6] && m[2] === m[12] && m[34] === m[29]);
  check(
    "upper triangle mirrors the lower one",
    m[1] === 2 && m[2] === 4 && m[6] === 2 && m[5] === 16,
    `m[1]=${m[1]}, m[2]=${m[2]}, m[6]=${m[6]}, m[5]=${m[5]}`,
  );
}

console.log("\nStarlink ephemeris — full file");
{
  const eph = parseStarlinkEphemeris(REAL_SAMPLE, {
    objectName: "STARLINK-38128",
  });

  // The manifest carries no NORAD id: the number in the filename is a delivery
  // sequence. An earlier version of this test asserted `noradId === 2990054`,
  // which is exactly the mistake that put bogus ids in the database.
  check("object name preserved", eph.objectName === "STARLINK-38128");
  check("covariance frame is UVW", eph.covarianceFrame === "UVW");
  check("source is blend", eph.source === "blend");
  check("step size is 60 s", eph.stepSeconds === 60);
  check("start/stop parsed", eph.ephemerisStart === "2026-10-26T00:54:42.000Z" && eph.ephemerisStop === "2026-10-29T00:54:42.000Z");
  check("two state vectors", eph.states.length === 2, `n=${eph.states.length}`);

  const s0 = eph.states[0];
  check(
    "state 0 position matches the file",
    Math.abs(s0.position[0] - -2210.7020410928) < 1e-6 &&
      Math.abs(s0.position[2] - 3447.7275950343) < 1e-6,
  );
  check(
    "state 0 covariance expanded to 6x6",
    s0.covariance !== null && s0.covariance.length === 36,
  );
  check(
    "covariance diagonal is positive",
    (s0.covariance?.[0] ?? 0) > 0 && (s0.covariance?.[7] ?? 0) > 0,
  );

  // Physical sanity: a Starlink shell-1 satellite sits ~470-580 km up.
  const radius = Math.hypot(...s0.position);
  const altitude = radius - 6378.137;
  check(
    "altitude is plausible for a Starlink shell",
    altitude > 300 && altitude < 700,
    `alt=${altitude.toFixed(1)} km`,
  );
  const speed = Math.hypot(...s0.velocity);
  check("speed is orbital", speed > 7 && speed < 8, `v=${speed.toFixed(3)} km/s`);
}

console.log("\nStarlink ephemeris — manifest");
{
  const manifest = parseManifest(
    [
      "MEME_100001_STARLINK-38128_2990054_Operational_1477270500_UNCLASSIFIED.txt",
      "garbage line that should be skipped",
      "MEME_100002_STARLINK-37711_2990101_Operational_1477270920_UNCLASSIFIED.txt",
    ].join("\n"),
  );
  check("recognises valid rows only", manifest.length === 2, `n=${manifest.length}`);
  check(
    "extracts name, NORAD id, delivery sequence and status",
    manifest[0].objectName === "STARLINK-38128" &&
      manifest[0].noradId === 100001 &&
      manifest[0].deliverySequence === 2990054 &&
      manifest[0].status === "Operational",
  );
  check(
    "does not misreport the delivery sequence as a NORAD id",
    manifest[0].noradId === 100001 && manifest[0].deliverySequence === 2990054,
    `norad=${manifest[0].noradId} delivery=${manifest[0].deliverySequence}`,
  );
  // The manifest lives on api.starlink.com; www.starlink.com 302s to a marketing
  // page that answers HTML with HTTP 200, so a fetch there succeeds and then
  // parses to zero entries.
  check(
    "builds an absolute download url on the api host",
    manifest[0].url.startsWith("https://api.starlink.com/public-files/ephemerides/"),
    manifest[0].url.slice(0, 60),
  );
}

console.log("\nStarlink ephemeris — error handling");
{
  let threw = false;
  try {
    parseModifiedItc("not a state line\nnor this", "UVW");
  } catch {
    threw = true;
  }
  check("malformed body raises ItcParseError", threw);

  let threw2 = false;
  try {
    parseStarlinkEphemeris("too\nshort", undefined);
  } catch {
    threw2 = true;
  }
  check("truncated file is rejected", threw2);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
