/**
 * Validation against Starlink's own published shell table.
 *
 * `docs/starlink-space-safety/space-safety-articles__constellation_altitudes.md`
 * lists the operational shells. This gives us an independent, authoritative
 * yardstick: if our parsers and frame transforms are correct, real ephemerides
 * must land on one of these (altitude, inclination) pairs.
 *
 *   | Shell        | mean SMA altitude | inclination |
 *   |--------------|-------------------|-------------|
 *   | V1+V2 Bcast  | 485 km            | 43°         |
 *   |              | 472.5 km          | 70°         |
 *   |              | 462.5 km          | 97.3°       |
 *   |              | 463 km            | 53°         |
 *   | V1 DTC       | 360 km            | 53°         |
 *   |              | 358.5 km          | 43°         |
 *
 * This is a far stronger test than "the numbers look plausible": it closes the
 * loop between the vendor's own documentation and our parsing/transform stack.
 */

import { readFileSync } from "node:fs";

import { elementsFromState, type OrbitalElements } from "../src/lib/core/kinematics";
import { itrfStateToJ2000 } from "../src/lib/orbit/frames-rigorous";
import { mergeOcmCovariance, parseOcm } from "../src/lib/orbit/ocm";
import { parseStarlinkEphemeris } from "../src/lib/sources/starlink-public";

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

/** Published operational shells (end of 2026), from the vendor's own article. */
export const STARLINK_SHELLS = [
  { label: "V1+V2 broadcast 43°", smaAltitudeKm: 485, inclinationDeg: 43 },
  { label: "V1+V2 broadcast 70°", smaAltitudeKm: 472.5, inclinationDeg: 70 },
  { label: "V1+V2 broadcast 97.3°", smaAltitudeKm: 462.5, inclinationDeg: 97.3 },
  { label: "V1+V2 broadcast 53°", smaAltitudeKm: 463, inclinationDeg: 53 },
  { label: "V1 DTC 53°", smaAltitudeKm: 360, inclinationDeg: 53 },
  { label: "V1 DTC 43°", smaAltitudeKm: 358.5, inclinationDeg: 43 },
] as const;

/** Tolerance: stationkeeping holds radial offset tightly; inclinations are fixed. */
const SMA_TOL_KM = 25;
const INC_TOL_DEG = 1.5;

export function nearestShell(el: Pick<OrbitalElements, "smaAltitudeKm" | "inclinationDeg">) {
  let best: (typeof STARLINK_SHELLS)[number] | null = null;
  let bestScore = Infinity;
  for (const shell of STARLINK_SHELLS) {
    const dInc = Math.abs(el.inclinationDeg - shell.inclinationDeg);
    const dSma = Math.abs(el.smaAltitudeKm - shell.smaAltitudeKm);
    // Normalise so the two axes are comparable, then combine.
    const score = (dInc / INC_TOL_DEG) ** 2 + (dSma / SMA_TOL_KM) ** 2;
    if (score < bestScore) {
      bestScore = score;
      best = shell;
    }
  }
  return { shell: best, score: bestScore };
}

/** Mean elements over an arc: satellites oscillate around their shell. */
function meanElements(
  states: { position: number[]; velocity: number[] }[],
): { smaAltitudeKm: number; inclinationDeg: number } {
  let sma = 0;
  let inc = 0;
  for (const s of states) {
    const el = elementsFromState(
      s.position as [number, number, number],
      s.velocity as [number, number, number],
    );
    sma += el.smaAltitudeKm;
    inc += el.inclinationDeg;
  }
  return { smaAltitudeKm: sma / states.length, inclinationDeg: inc / states.length };
}

console.log("\nShell validation — ITC feed (EME2000, used as-is)");
{
  const itc = parseStarlinkEphemeris(readFileSync("/tmp/eph.txt", "utf8"), {
    objectName: "STARLINK-38128",
  });
  const mean = meanElements(itc.states);
  const { shell } = nearestShell(mean);
  check(
    "ITC sample lands on a published shell",
    shell !== null &&
      Math.abs(mean.inclinationDeg - shell.inclinationDeg) < INC_TOL_DEG &&
      Math.abs(mean.smaAltitudeKm - shell.smaAltitudeKm) < SMA_TOL_KM,
    `mean sma=${mean.smaAltitudeKm.toFixed(1)} km, i=${mean.inclinationDeg.toFixed(2)}° -> "${shell?.label}"`,
  );
  check(
    "ITC mean inclination matches the 70° shell",
    shell?.inclinationDeg === 70,
    `i=${mean.inclinationDeg.toFixed(2)}°`,
  );
}

console.log("\nShell validation — OCM feed (ITRF2000 -> J2000)");
{
  const ocm = parseOcm(readFileSync("/tmp/ocm.txt", "utf8"));
  const eciStates = mergeOcmCovariance(ocm).map((s) => {
    const eci = itrfStateToJ2000(s.position, s.velocity, s.ms);
    return { position: eci.position, velocity: eci.velocity };
  });
  const mean = meanElements(eciStates);
  const { shell } = nearestShell(mean);
  check(
    "OCM sample lands on a published shell",
    shell !== null &&
      Math.abs(mean.inclinationDeg - shell.inclinationDeg) < INC_TOL_DEG &&
      Math.abs(mean.smaAltitudeKm - shell.smaAltitudeKm) < SMA_TOL_KM,
    `mean sma=${mean.smaAltitudeKm.toFixed(1)} km, i=${mean.inclinationDeg.toFixed(2)}° -> "${shell?.label}"`,
  );
  check(
    "OCM mean inclination matches the 97.3° shell",
    shell?.inclinationDeg === 97.3,
    `i=${mean.inclinationDeg.toFixed(2)}°`,
  );
}

console.log("\nShell validation — the transform is what makes it work");
{
  // Treating the ITRF OCM states as if they were inertial produces an
  // inclination that matches no published shell. This guards against anyone
  // "simplifying" the frame code later.
  const ocm = parseOcm(readFileSync("/tmp/ocm.txt", "utf8"));
  const rawStates = mergeOcmCovariance(ocm).map((s) => ({
    position: s.position,
    velocity: s.velocity,
  }));
  const mean = meanElements(rawStates);
  const { score } = nearestShell(mean);
  check(
    "untransformed ITRF data matches no shell (regression guard)",
    score > 1,
    `raw i=${mean.inclinationDeg.toFixed(2)}°, sma=${mean.smaAltitudeKm.toFixed(1)} km, score=${score.toFixed(2)}`,
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
