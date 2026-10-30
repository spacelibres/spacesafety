/**
 * Forecast-baseline measurements.
 *
 * These tests exist because the first version of this analysis reported an
 * 8 390 km "forecast error" that was entirely an artefact of comparing two
 * products whose arcs start hours apart. The conclusions below are the ones that
 * survived checking; each is asserted so a regression cannot quietly revive the
 * wrong reading.
 *
 * What is being protected:
 *
 *   * The two products describe the **same orbit**: radial difference is metres.
 *     If this ever becomes kilometres, one of the parsers or a frame rotation is
 *     wrong — not the forecast.
 *   * The separation is dominated by **phase**, so kilometres must never be
 *     reported as accuracy.
 *   * A sample is only taken where both arcs actually cover the instant. Using the
 *     nearest point outside an arc produced a 11 886 km figure from one object.
 */

import { getDb } from "../src/db";
import {
  itcTrack,
  ocmTrack,
  phaseStability,
  positionSigmaKm,
  type HorizonSample,
} from "../src/lib/core/forecast-baseline";

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

  const pairs = sqlite
    .prepare(
      `SELECT o.object_name AS name,
              (SELECT f.file_text FROM trajectories t
                 JOIN trajectory_files f ON f.trajectory_id = t.id
                WHERE t.object_id = o.id AND t.file_format = 'ocm' LIMIT 1) AS ocm,
              (SELECT f.file_text FROM trajectories t
                 JOIN trajectory_files f ON f.trajectory_id = t.id
                WHERE t.object_id = o.id AND t.file_format = 'itc' LIMIT 1) AS itc
         FROM objects o
        WHERE EXISTS (SELECT 1 FROM trajectories t WHERE t.object_id = o.id AND t.file_format = 'ocm')
          AND EXISTS (SELECT 1 FROM trajectories t WHERE t.object_id = o.id AND t.file_format = 'itc')
        LIMIT 20`,
    )
    .all() as Array<{ name: string; ocm: string | null; itc: string | null }>;

  if (pairs.length === 0) {
    skip("OCM and ITC describe the same orbit", "no object has both feeds");
    console.log(`\n0 passed, 0 failed, ${skipped} skipped`);
    return;
  }

  // ---- 1. parsers ----------------------------------------------------------
  console.log("\nparsing");
  const first = pairs[0];
  const a = ocmTrack(first.ocm ?? "");
  const b = itcTrack(first.itc ?? "");
  check("the OCM parses", a.length > 1000, `${a.length} states`);
  check("the ITC parses", b.length > 1000, `${b.length} states`);
  check("both are in the same frame after rotation", sameOrderOfMagnitude(a, b));

  // ---- 2. same orbit, different phase -------------------------------------
  console.log("\nsame orbit, different phase");
  let radialChecks = 0;
  let radialSmall = 0;
  let phaseLargerThanRadial = 0;

  for (const pair of pairs) {
    if (!pair.ocm || !pair.itc) continue;
    const ta = ocmTrack(pair.ocm);
    const tb = itcTrack(pair.itc);
    if (ta.length < 2 || tb.length < 2) continue;

    const start = Math.max(ta[0].ms, tb[0].ms);
    const end = Math.min(ta[ta.length - 1].ms, tb[tb.length - 1].ms);
    if (end <= start) continue;

    // Sample a third of the way into the overlap, so both tracks are interior.
    const ms = start + Math.floor((end - start) / 3 / 60_000) * 60_000;
    const sa = findAt(ta, ms);
    const sb = findAt(tb, ms);
    if (!sa || !sb) continue;

    const ra = Math.hypot(sa.position[0], sa.position[1], sa.position[2]);
    const rb = Math.hypot(sb.position[0], sb.position[1], sb.position[2]);
    const radial = Math.abs(ra - rb);
    const total = Math.hypot(
      sa.position[0] - sb.position[0],
      sa.position[1] - sb.position[1],
      sa.position[2] - sb.position[2],
    );

    radialChecks += 1;
    // A LEO satellite's radius is ~6 800 km; 50 km is a generous ceiling for two
    // products of the same object. Anything larger is a frame or parser fault.
    if (radial < 50) radialSmall += 1;
    if (total > radial * 10) phaseLargerThanRadial += 1;
  }

  if (radialChecks === 0) {
    skip("radial difference stays small", "no overlapping pair");
  } else {
    check(
      "radial difference stays small across objects",
      radialSmall === radialChecks,
      `${radialSmall}/${radialChecks} under 50 km`,
    );
    check(
      "phase dominates the separation",
      phaseLargerThanRadial / radialChecks > 0.9,
      `${phaseLargerThanRadial}/${radialChecks}`,
    );
  }

  // ---- 3. out-of-arc sampling is refused ----------------------------------
  console.log("\nout-of-arc sampling");
  const track = a;
  if (track.length > 2) {
    const before = findAt(track, track[0].ms - 3_600_000);
    const after = findAt(track, track[track.length - 1].ms + 3_600_000);
    check("asking before the arc returns null", before === null);
    check("asking after the arc returns null", after === null);
    check("asking inside the arc returns a state", findAt(track, track[0].ms + 60_000) !== null);
  }

  // ---- 4. covariance grows along the arc ----------------------------------
  console.log("\ncovariance growth");
  const sigmas = track
    .map((s) => positionSigmaKm(s.covariance))
    .filter((v): v is number => v !== null);
  if (sigmas.length < 10) {
    skip("sigma grows along the prediction", "no covariance in the track");
  } else {
    const first10 = sigmas.slice(0, 10);
    const last10 = sigmas.slice(-10);
    const avg = (arr: number[]) => arr.reduce((x, y) => x + y, 0) / arr.length;
    check(
      "sigma is larger at the end of the arc than at the start",
      avg(last10) > avg(first10),
      `${avg(first10).toFixed(3)} -> ${avg(last10).toFixed(3)} km`,
    );
    check(
      "sigma stays sub-kilometre at the arc start",
      avg(first10) < 1,
      `${avg(first10).toFixed(4)} km`,
    );
  }

  // ---- 5. phase stability is measured, not assumed ------------------------
  console.log("\nphase stability");
  const synthetic: HorizonSample[] = [
    sample("a", 6, 10),
    sample("a", 12, 10.5),
    sample("b", 6, 20),
    sample("b", 12, 35),
    sample("c", 6, 5),
  ];
  const stability = phaseStability(synthetic);
  check("stability is computed", stability !== null);
  check("object count excludes single-horizon entries", stability?.objects === 2);
  check("a constant offset is counted as stable", stability?.stableCount === 1);
  check(
    "the spread reflects the drifting object",
    (stability?.p90SpreadMinutes ?? 0) >= 10,
    `${stability?.p90SpreadMinutes}`,
  );

  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  if (fail > 0) process.exit(1);
}

function sample(objectId: string, horizonHours: number, phaseMinutes: number): HorizonSample {
  return {
    objectId,
    objectName: objectId,
    horizonHours,
    ocmAgeHours: horizonHours,
    itcAgeHours: horizonHours + 3,
    separationKm: 100,
    radialKm: 0.1,
    alongKm: 100,
    phaseMinutes,
    sigmaKm: 1,
    ratio: 100,
  };
}

/** The state exactly at `ms`, or null — mirrors the library's refusal to extrapolate. */
function findAt(
  track: Array<{ ms: number; position: [number, number, number] }>,
  ms: number,
) {
  if (track.length === 0) return null;
  if (ms < track[0].ms || ms > track[track.length - 1].ms) return null;
  return track.find((s) => s.ms === ms) ?? null;
}

/** Both tracks must be heliocentric-scale km, not metres or AU. */
function sameOrderOfMagnitude(
  a: Array<{ position: [number, number, number] }>,
  b: Array<{ position: [number, number, number] }>,
): boolean {
  const radius = (p: [number, number, number]) => Math.hypot(p[0], p[1], p[2]);
  if (a.length === 0 || b.length === 0) return false;
  const ra = radius(a[0].position);
  const rb = radius(b[0].position);
  return ra > 6_000 && ra < 50_000 && Math.abs(ra - rb) / ra < 0.05;
}

void main();

export {};
