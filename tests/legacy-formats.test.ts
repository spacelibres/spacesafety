/**
 * Legacy-format parser tests (UTC / JSpOC / NASA).
 *
 * Fixtures are written by hand from the Spaceflight Safety Handbook shapes rather
 * than copied, so the tests stay readable and independent of any single real
 * file. Each is then round-tripped through the *upload validator*, which is the
 * path an operator's file actually takes.
 */

import { detectFormat, normaliseTrajectory } from "../src/lib/api/validate-trajectory";
import { elementsFromState } from "../src/lib/core/kinematics";
import {
  parseDoyShort,
  parseJspocFormat,
  parseNasaFormat,
  parseUtcFormat,
  toNasaFormat,
} from "../src/lib/orbit/legacy-formats";

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

const MU = 398600.4418;
const R = 6378.137 + 550;
const PERIOD = 2 * Math.PI * Math.sqrt(R ** 3 / MU);
const SPEED = Math.sqrt(MU / R);
/** Start in the near future so the validator's "past window" rule passes. */
const T0 = Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000;
const N = 20;

function circular(i: number): {
  p: [number, number, number];
  v: [number, number, number];
} {
  const th = (2 * Math.PI * (i * 60)) / PERIOD;
  return {
    p: [R * Math.cos(th), R * Math.sin(th), 0],
    v: [-SPEED * Math.sin(th), SPEED * Math.cos(th), 0],
  };
}

// ---------------------------------------------------------------------------

console.log("\nLegacy formats — UTC");
const utcFile = buildUtc();
{
  check("detectFormat identifies UTC", detectFormat(utcFile) === "utc");

  const states = parseUtcFormat(utcFile);
  check("UTC parses every state", states.length === N, `n=${states.length}`);
  check(
    "UTC timestamps are UTC and monotonic",
    new Date(states[0].ms).toISOString().endsWith("Z") &&
      states.every((s, i) => i === 0 || s.ms > states[i - 1].ms),
    new Date(states[0].ms).toISOString(),
  );

  const normalised = normaliseTrajectory(utcFile);
  check("UTC upload normalises", normalised.format === "utc");
  check(
    "UTC has no covariance (Pc will be NULL)",
    normalised.states.every((s) => s.covariance === null),
  );
  check(
    "UTC warns about missing covariance",
    normalised.warnings.some((w) => w.toLowerCase().includes("covariance")),
  );

  const el = elementsFromState(normalised.states[0].position, normalised.states[0].velocity);
  check(
    "UTC orbit is physically sane",
    Math.abs(el.altitudeKm - 550) < 1 && el.e < 0.01,
    `alt=${el.altitudeKm.toFixed(1)} km, e=${el.e.toFixed(5)}`,
  );
}

// ---------------------------------------------------------------------------

console.log("\nLegacy formats — NASA");
const nasaStates = Array.from({ length: N }, (_, i) => {
  const { p, v } = circular(i);
  return { ms: T0 + i * 60_000, position: p, velocity: v };
});
const nasaFile = toNasaFormat(nasaStates);
{
  check("detectFormat identifies NASA", detectFormat(nasaFile) === "nasa");
  const parsed = parseNasaFormat(nasaFile);
  check("NASA parses every state", parsed.length === N, `n=${parsed.length}`);
  check(
    "NASA round-trips timestamps",
    parsed[0].ms === T0,
    `${new Date(parsed[0].ms).toISOString()} vs ${new Date(T0).toISOString()}`,
  );

  const normalised = normaliseTrajectory(nasaFile);
  const el = elementsFromState(normalised.states[0].position, normalised.states[0].velocity);
  check("NASA upload normalises", normalised.format === "nasa" && Math.abs(el.altitudeKm - 550) < 1);
}

// ---------------------------------------------------------------------------

console.log("\nLegacy formats — JSpOC");
const jspocFile = buildJspoc();
{
  check("detectFormat identifies JSpOC", detectFormat(jspocFile) === "jspoc");
  const parsed = parseJspocFormat(jspocFile);
  check("JSpOC parses every state", parsed.states.length === N, `n=${parsed.states.length}`);
  check("JSpOC extracts spacecraft name", parsed.spacecraft === "TESTSAT-1", String(parsed.spacecraft));

  const normalised = normaliseTrajectory(jspocFile);
  check("JSpOC upload carries the object name", normalised.objectName === "TESTSAT-1");
}

// ---------------------------------------------------------------------------

console.log("\nLegacy formats — timestamps");
{
  // yyDOY pivot: 49 -> 2049, 50 -> 1950.
  const y2049 = parseDoyShort("49001120000.000");
  const y1950 = parseDoyShort("50001120000.000");
  check(
    "two-digit year uses the 1950-2049 pivot",
    new Date(y2049).getUTCFullYear() === 2049 && new Date(y1950).getUTCFullYear() === 1950,
    `${new Date(y2049).getUTCFullYear()} / ${new Date(y1950).getUTCFullYear()}`,
  );

  let threw = false;
  try {
    parseDoyShort("99999999999");
  } catch {
    threw = true;
  }
  check("out-of-range DOY rejected", threw);
}

// ---------------------------------------------------------------------------

console.log("\nLegacy formats — validation still applies");
{
  const short = buildUtc(3);
  let threw = false;
  try {
    normaliseTrajectory(short);
  } catch (err) {
    const issues = (err as { issues?: { reason: string }[] }).issues ?? [];
    threw = issues.some((i) => i.reason.includes("at least 6"));
  }
  check("too few states rejected in UTC format", threw);

  let threw2 = false;
  try {
    normaliseTrajectory(buildUtc().replace(/^2026\/\d\d\/\d\d .*$/m, "2026/01/01 00:00:00.000 100.000 100.000 100.000 0 0 0"));
  } catch (err) {
    const issues = (err as { issues?: { reason: string }[] }).issues ?? [];
    threw2 = issues.some((i) => i.reason.includes("below the Earth"));
  }
  check("sub-surface state rejected in UTC format", threw2);
}

// ---------------------------------------------------------------------------

function buildUtc(n = N): string {
  const lines = [
    "Version: 1",
    "Description: test.eph",
    "Spacecraft: TESTSAT",
    "Equinox: MEME of Epoch [JD2000]",
    "Title: CMOC Ephemeris",
    "Absolute Time      ECI Pos.x      ECI Pos.y      ECI Pos.z      ECI Vel.x      ECI Vel.y      ECI Vel.z",
    "UTC.YmdHMs             km             km             km         km/sec         km/sec         km/sec",
  ];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(T0 + i * 60_000);
    const { p, v } = circular(i);
    const stamp =
      `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.000`;
    lines.push(
      `${stamp} ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)} ${v[0].toFixed(9)} ${v[1].toFixed(9)} ${v[2].toFixed(9)}`,
    );
  }
  return lines.join("\n") + "\n";
}

function buildJspoc(n = N): string {
  const lines = [
    "JSpOC Format Ephemeris Report",
    "Date:  2025/05/20 05:00:00",
    "Title:  ECI Position-Velocity Ephemeris Report",
    "Spacecraft:  TESTSAT-1",
    "Equinox:  J2000",
    "UTC         ECI Pos.x         ECI Pos.y         ECI Pos.z         ECI Vel.x         ECI Vel.y         ECI Vel.z",
    "                          km                km                km            km/sec            km/sec            km/sec",
  ];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(T0 + i * 60_000);
    const doy =
      Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
    const stamp =
      pad(d.getUTCFullYear() % 100) +
      pad(doy, 3) +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds()) +
      ".000";
    const { p, v } = circular(i);
    lines.push(
      `${stamp} ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)} ${v[0].toFixed(9)} ${v[1].toFixed(9)} ${v[2].toFixed(9)}`,
    );
  }
  return lines.join("\n") + "\n";
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
