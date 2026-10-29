/**
 * TLE parsing and SGP4 propagation.
 *
 * Two things are being protected here.
 *
 * **Parsing.** A TLE is fixed-column, so a malformed record still parses into
 * plausible numbers. Every structural invariant is checked instead: checksum,
 * matching catalogue numbers, field ranges. Alpha-5 catalogue numbers are
 * covered because Space-Track has been issuing them since the catalogue passed
 * 99 999 objects, and a plain `parseInt` returns NaN for `A1193`.
 *
 * **Propagation.** SGP4 outputs TEME, while the screening kernel works in J2000.
 * Mixing the two is a silent ~28 km error at LEO — half the screening box — so
 * the rotation is checked directly (orthonormality, length preservation) and its
 * magnitude against the published equation of the equinoxes.
 */

import {
  epochFromTle,
  formatCatalogueNumber,
  parseCatalogueNumber,
  parseTle,
  parseTleFile,
  tleChecksum,
} from "../src/lib/orbit/tle";
import { propagateTle, tleElements, toItcStates } from "../src/lib/orbit/sgp4";
import { frameOffsetArcsec, temeToEme2000, temeToEme2000Matrix } from "../src/lib/orbit/frames-sgp4";

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

/** ISS, a long-standing reference object. */
const ISS = [
  "0 ISS (ZARYA)",
  "1 25544U 98067A   26299.59614366  .00006146  00000-0  11933-3 0  9995",
  "2 25544  51.6336   9.8132 0006932 312.5452  47.4951 15.49065369592128",
];

/** An Alpha-5 analyst object from Space-Track (`A1193` = 101193). */
const ALPHA5 = [
  "0 HULIANWANG DIGUI 231",
  "1 A1193U 26243J   26299.30991535  .00001065  00000-0  16921-2 0  9997",
  "2 A1193  50.0044   9.3220 0012135 249.6342 110.3238 13.56487790   184",
];

console.log("\nTLE — checksum");

{
  const c1 = tleChecksum(ISS[1]);
  const c2 = tleChecksum(ISS[2]);
  check("line 1 checksum matches the last column", c1 === Number(ISS[1][68]), `${c1} vs ${ISS[1][68]}`);
  check("line 2 checksum matches the last column", c2 === Number(ISS[2][68]), `${c2} vs ${ISS[2][68]}`);
}

{
  // One digit changed must be caught. This is the whole point of the checksum.
  const tampered = ISS[1].slice(0, 20) + "9" + ISS[1].slice(21);
  const parsed = parseTle(`${tampered}\n${ISS[2]}`);
  check(
    "a tampered field is rejected",
    "error" in parsed && /checksum/.test(parsed.error.message),
    "error" in parsed ? parsed.error.message : "accepted (bad)",
  );
}

console.log("\nTLE — catalogue numbers (Alpha-5)");

{
  check("plain numeric decodes", parseCatalogueNumber("25544") === 25544);
  check("leading zeros decode", parseCatalogueNumber("04413") === 4413);
  // The mapping: A=10, B=11, ... omitting I and O.
  check("A1193 -> 101193", parseCatalogueNumber("A1193") === 101193, String(parseCatalogueNumber("A1193")));
  check("B0000 -> 110000", parseCatalogueNumber("B0000") === 110000);
  // A=10 .. Z=33 (I and O skipped), so the series tops out at 339999.
  check("Z9999 -> 339999", parseCatalogueNumber("Z9999") === 339999, String(parseCatalogueNumber("Z9999")));
  check("I is not a valid prefix (reads as 1)", parseCatalogueNumber("I0000") === null);
  check("garbage is rejected", parseCatalogueNumber("?????") === null);
  check("round-trips through formatCatalogueNumber", formatCatalogueNumber(101193) === "A1193", formatCatalogueNumber(101193));
  check("plain numbers round-trip", formatCatalogueNumber(44713) === "44713");
}

{
  const parsed = parseTle(ALPHA5.join("\n"));
  check("Alpha-5 TLE parses", "tle" in parsed);
  if ("tle" in parsed) {
    check("Alpha-5 norad id is 101193", parsed.tle.noradId === 101193, String(parsed.tle.noradId));
    check("name keeps the object name without the `0 ` marker", parsed.tle.name === "HULIANWANG DIGUI 231", String(parsed.tle.name));
  }
}

console.log("\nTLE — fields");

{
  const parsed = parseTle(ISS.join("\n"));
  if (!("tle" in parsed)) {
    check("ISS TLE parses", false, "error" in parsed ? parsed.error.message : "?");
  } else {
    const t = parsed.tle;
    check("norad id", t.noradId === 25544, String(t.noradId));
    check("name", t.name === "ISS (ZARYA)", String(t.name));
    check("classification", t.classification === "U");
    check("international designator", t.intlDesignator === "98067A", t.intlDesignator);
    check("inclination", Math.abs(t.inclinationDeg - 51.6336) < 1e-9, String(t.inclinationDeg));
    check("raan", Math.abs(t.raanDeg - 9.8132) < 1e-9, String(t.raanDeg));
    check("eccentricity uses an assumed decimal point", Math.abs(t.eccentricity - 0.0006932) < 1e-12, String(t.eccentricity));
    check("argument of perigee", Math.abs(t.argPerigeeDeg - 312.5452) < 1e-9, String(t.argPerigeeDeg));
    check("mean anomaly", Math.abs(t.meanAnomalyDeg - 47.4951) < 1e-9, String(t.meanAnomalyDeg));
    check("mean motion", Math.abs(t.meanMotionRevPerDay - 15.49065369) < 1e-8, String(t.meanMotionRevPerDay));
    check("B* uses an assumed point and exponent", Math.abs(t.bstar - 0.00011933) < 1e-12, String(t.bstar));
    check(
      "epoch is 2026 day 299.59614366",
      t.epochMs === epochFromTle(26, 299.59614366),
      new Date(t.epochMs).toISOString(),
    );
  }
}

console.log("\nTLE — epoch pivots");

{
  // The catalogue starts in 1957, so `57` is 1957 and anything lower is 2000+.
  const y57 = new Date(epochFromTle(57, 1)).getUTCFullYear();
  const y99 = new Date(epochFromTle(99, 1)).getUTCFullYear();
  const y00 = new Date(epochFromTle(0, 1)).getUTCFullYear();
  const y26 = new Date(epochFromTle(26, 1)).getUTCFullYear();
  check("yy=57 -> 1957", y57 === 1957, String(y57));
  check("yy=99 -> 1999", y99 === 1999, String(y99));
  check("yy=00 -> 2000", y00 === 2000, String(y00));
  check("yy=26 -> 2026", y26 === 2026, String(y26));
  check(
    "day 1.0 is 1 January 00:00",
    epochFromTle(26, 1) === Date.UTC(2026, 0, 1),
    new Date(epochFromTle(26, 1)).toISOString(),
  );
}

console.log("\nTLE — file parsing");

{
  // Space-Track sends `3le` with CRLF line endings and `0 ` name markers.
  const file = `${ALPHA5.join("\r\n")}\r\n${ISS.join("\r\n")}\r\n`;
  const { tles, errors } = parseTleFile(file);
  check("CRLF file parses both entries", tles.length === 2 && errors.length === 0, `${tles.length} tles, ${errors.length} errors`);
  check("names are populated", tles.every((t) => t.name !== null), tles.map((t) => t.name).join(", "));
}

{
  // A bare pair without a name line is also valid.
  const { tles, errors } = parseTleFile(`${ISS[1]}\n${ISS[2]}\n`);
  check("2-line layout parses", tles.length === 1 && errors.length === 0);
  check("2-line layout has no name", tles[0]?.name === null);
}

{
  const { tles, errors } = parseTleFile("garbage\nnot a tle\n");
  check("nonsense is rejected, not silently dropped", tles.length === 0 && errors.length > 0, `${errors.length} errors`);
}

console.log("\nSGP4 — propagation");

{
  const parsed = parseTle(ISS.join("\n"));
  if (!("tle" in parsed)) {
    check("propagates", false);
  } else {
    const tle = parsed.tle;
    const result = propagateTle(tle, { startMs: tle.epochMs, spanHours: 2, stepSeconds: 60 });
    check(
      "produces one state per minute over the window",
      result.states.length === 121,
      `${result.states.length} states, ${result.failures.length} failures`,
    );
    check("no propagation failures", result.failures.length === 0);

    const s = result.states[0];
    const radius = Math.hypot(...s.position);
    // The ISS orbits at ~400 km, so the radius must be 6700-6900 km.
    check("radius is in the ISS range", radius > 6700 && radius < 6900, `${radius.toFixed(1)} km`);

    const speed = Math.hypot(...s.velocity);
    check("speed is orbital (~7.6 km/s)", speed > 7.0 && speed < 8.0, `${speed.toFixed(3)} km/s`);

    // Two-body sanity: the radius should not drift wildly over two hours.
    const radii = result.states.map((x) => Math.hypot(...x.position));
    const spread = Math.max(...radii) - Math.min(...radii);
    check("radius is stable over 2h", spread < 60, `${spread.toFixed(1)} km spread`);
  }
}

{
  const parsed = parseTle(ISS.join("\n"));
  if ("tle" in parsed) {
    // Elements derived from the TLE mean motion must agree with the propagation.
    const el = tleElements(parsed.tle);
    check("mean altitude is ISS-like", el.altitudeKm > 380 && el.altitudeKm < 460, `${el.altitudeKm.toFixed(1)} km`);
    check("period is ~92 min", el.periodMin > 88 && el.periodMin < 96, `${el.periodMin.toFixed(2)} min`);
  }
}

{
  const parsed = parseTle(ISS.join("\n"));
  if ("tle" in parsed) {
    const itc = toItcStates(propagateTle(parsed.tle, { spanHours: 0.1 }));
    check("kernel states carry no covariance (SGP4 has none)", itc.every((s) => s.covariance === null));
    check("kernel state shape is [x,y,z]", itc[0].position.length === 3);
  }
}

{
  // Asking far beyond the usable window must refuse rather than invent numbers.
  const parsed = parseTle(ISS.join("\n"));
  if ("tle" in parsed) {
    const far = propagateTle(parsed.tle, {
      startMs: parsed.tle.epochMs + 60 * 24 * 3_600_000,
      spanHours: 1,
    });
    check(
      "refuses to propagate months past epoch",
      far.states.length === 0 && far.failures.every((f) => f.reason === "epoch-out-of-range"),
      `${far.states.length} states, ${far.failures.length} failures`,
    );
  }
}

console.log("\nFrames — TEME to J2000");

{
  // The equation of the equinoxes is bounded by the nutation amplitude (~17"), so
  // anything outside that means the model has been applied wrongly. This is the
  // check that caught an arcsecond/radian mix that put the rotation off by 869°.
  for (const iso of ["2000-01-01T12:00:00Z", "2024-06-01T00:00:00Z", "2026-10-26T00:00:00Z", "2030-01-01T00:00:00Z"]) {
    const offset = frameOffsetArcsec(Date.parse(iso));
    check(`offset at ${iso} is within nutation bounds`, offset >= 0 && offset < 20, `${offset.toFixed(1)}"`);
  }
}

{
  const ms = Date.parse("2026-10-26T00:00:00Z");
  const m = temeToEme2000Matrix(ms);

  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  check("rotation matrix has unit determinant", Math.abs(det - 1) < 1e-12, det.toFixed(15));

  let worst = 0;
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      let dot = 0;
      for (let k = 0; k < 3; k += 1) dot += m[i * 3 + k] * m[j * 3 + k];
      worst = Math.max(worst, Math.abs(dot - (i === j ? 1 : 0)));
    }
  }
  check("rows are orthonormal", worst < 1e-12, worst.toExponential(1));

  const p: [number, number, number] = [6800, 1000, -2000];
  const out = temeToEme2000(p, [0, 7.5, 1], ms);
  const delta = out ? Math.abs(Math.hypot(...p) - Math.hypot(...out.position)) : Infinity;
  check("rotation preserves position magnitude", delta < 1e-9, `delta ${delta.toExponential(1)} km`);
}

{
  // The correction must be small but not negligible: big enough to matter for a
  // 2 km radial box, small enough to be a frame fix and not a coordinate blunder.
  const parsed = parseTle(ISS.join("\n"));
  if ("tle" in parsed) {
    const result = propagateTle(parsed.tle, { spanHours: 0.05 });
    const s = result.states[0];
    const offset = frameOffsetArcsec(s.ms);
    const arcKm = (offset / 3600) * (Math.PI / 180) * 6800;
    check(
      "TEME->J2000 correction is kilometres, not metres or degrees",
      arcKm > 0.05 && arcKm < 50,
      `${offset.toFixed(1)}" ~ ${arcKm.toFixed(2)} km at LEO`,
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
