/**
 * Prediction-accuracy tests.
 *
 * The interesting property is covariance realism: if the reported sigma is
 * honest, the Mahalanobis distances should be distributed as chi(1), whose mean
 * is sqrt(2/π) ≈ 0.798. An over-optimistic covariance blows that number up; an
 * over-conservative one crushes it. These tests pin both directions.
 */

import {
  chi2Cdf1,
  empiricalCdf,
  erf,
  evaluatePredictions,
  summarise,
  type TrackPoint,
} from "../src/lib/core/accuracy";

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
const SPEED = Math.sqrt(MU / R);
const T0 = Date.UTC(2026, 5, 1, 0, 0, 0);

/**
 * Circular equatorial track with a radial offset.
 *
 * The offset is applied to the orbital radius (not to an X coordinate), because
 * at the reference angle an X shift is almost purely *along-track* and would
 * show up on the T axis rather than R.
 */
function track(
  offsetM: number,
  sigmaM: number | null,
  opts: { points?: number; startMs?: number } = {},
): TrackPoint[] {
  const { points = 400, startMs = T0 } = opts;
  const period = 2 * Math.PI * Math.sqrt(R ** 3 / MU);
  const out: TrackPoint[] = [];

  for (let i = 0; i < points; i += 1) {
    const ms = startMs + i * 60_000;
    const th = (2 * Math.PI * ((ms - T0) / 1000)) / period;
    const r = R + offsetM / 1000;

    const cov = new Array<number>(36).fill(0);
    if (sigmaM !== null) {
      const v = (sigmaM / 1000) ** 2;
      cov[0] = v;
      cov[7] = v;
      cov[14] = v;
    }

    out.push({
      ms,
      position: [r * Math.cos(th), r * Math.sin(th), 0],
      velocity: [-SPEED * Math.sin(th), SPEED * Math.cos(th), 0],
      covariance: sigmaM === null ? null : cov,
    });
  }
  return out;
}

console.log("\nAccuracy — deterministic bias");
{
  const reference = track(0, 100);
  const prediction = track(50, 100); // constant 50 m radial bias

  const samples = evaluatePredictions([prediction], reference, "R", 3);
  check("one sample per prediction", samples.length === 1, `n=${samples.length}`);
  check(
    "radial error is recovered",
    Math.abs(samples[0].errorM - 50) < 1,
    `${samples[0].errorM.toFixed(2)} m`,
  );
  check(
    "sigma is carried through",
    samples[0].sigma1M !== null && Math.abs(samples[0].sigma1M - 100) < 1,
    `${samples[0].sigma1M?.toFixed(2)} m`,
  );
  check(
    "Mahalanobis is error/sigma",
    samples[0].mahalanobis !== null && Math.abs(samples[0].mahalanobis - 0.5) < 0.02,
    `${samples[0].mahalanobis?.toFixed(3)}`,
  );

  const s = summarise(samples);
  check("summary bias matches", Math.abs(s.meanErrorM - 50) < 1);
  check("summary RMS matches", Math.abs(s.rmsErrorM - 50) < 1, `${s.rmsErrorM.toFixed(2)} m`);
}

console.log("\nAccuracy — covariance realism");
{
  // Honest covariance: true error 100 m, reported sigma 100 m.
  const reference = track(0, 100);
  const predictions = Array.from({ length: 40 }, (_, i) =>
    track(i % 2 === 0 ? 100 : -100, 100, { startMs: T0 + i * 3_600_000 }),
  );
  const samples = evaluatePredictions(predictions, reference, "R", 1);
  const s = summarise(samples);
  check(
    "honest covariance gives mean Mahalanobis ≈ 1",
    s.meanMahalanobis !== null && Math.abs(s.meanMahalanobis - 1) < 0.15,
    `${s.meanMahalanobis?.toFixed(3)}`,
  );
  check(
    "honest covariance rarely exceeds 3σ",
    s.fractionOutside3Sigma !== null && s.fractionOutside3Sigma < 0.05,
    `${(s.fractionOutside3Sigma! * 100).toFixed(1)}%`,
  );

  // Over-optimistic covariance: same error, sigma 10x too small.
  const optim = evaluatePredictions(
    Array.from({ length: 40 }, (_, i) => track(100, 10, { startMs: T0 + i * 3_600_000 })),
    reference,
    "R",
    1,
  );
  const so = summarise(optim);
  check(
    "implausibly small sigma is detected",
    so.meanMahalanobis !== null && so.meanMahalanobis > 5,
    `${so.meanMahalanobis?.toFixed(1)}`,
  );
  check(
    "and flagged as outside 3σ",
    so.fractionOutside3Sigma !== null && so.fractionOutside3Sigma > 0.9,
    `${(so.fractionOutside3Sigma! * 100).toFixed(0)}%`,
  );

  // Over-conservative covariance: sigma 10x too large.
  const conserv = evaluatePredictions(
    Array.from({ length: 40 }, (_, i) => track(100, 1000, { startMs: T0 + i * 3_600_000 })),
    reference,
    "R",
    1,
  );
  const sc = summarise(conserv);
  check(
    "implausibly large sigma is detected",
    sc.meanMahalanobis !== null && sc.meanMahalanobis < 0.2,
    `${sc.meanMahalanobis?.toFixed(3)}`,
  );
}

console.log("\nAccuracy — missing covariance");
{
  const reference = track(0, 100);
  const prediction = track(30, null);
  const samples = evaluatePredictions([prediction], reference, "R", 2);
  check("error still computed without covariance", samples.length === 1 && samples[0].sigma1M === null);
  check("Mahalanobis is null then", samples[0].mahalanobis === null);
  const s = summarise(samples);
  check("summary tolerates missing sigma", s.meanMahalanobis === null);
}

console.log("\nAccuracy — distributions");
{
  const cdf = empiricalCdf([3, 1, 2]);
  check("CDF is sorted and normalised", cdf[0].x === 1 && cdf[2].p === 1);
  check("CDF endpoints", cdf[0].p === 1 / 3);

  check("chi2 CDF at 0 is 0", chi2Cdf1(0) === 0);
  check(
    "chi2 CDF at 1 ≈ 0.6827",
    Math.abs(chi2Cdf1(1) - 0.6827) < 0.002,
    chi2Cdf1(1).toFixed(4),
  );
  check(
    "chi2 CDF at 4 ≈ 0.9545",
    Math.abs(chi2Cdf1(4) - 0.9545) < 0.002,
    chi2Cdf1(4).toFixed(4),
  );
  check("erf asymptotes to 1", Math.abs(erf(4) - 1) < 1e-6, erf(4).toFixed(8));
  check("erf is odd", Math.abs(erf(-1.2) + erf(1.2)) < 1e-12);
}

console.log("\nAccuracy — horizons and axes");
{
  const reference = track(0, 50);
  const prediction = track(0, 50);

  const h1 = evaluatePredictions([prediction], reference, "R", 1);
  check("horizon recorded", h1[0].horizonHours === 1);

  // A prediction that stops before the horizon yields no sample.
  const short = track(0, 50, { points: 10 });
  const none = evaluatePredictions([short], reference, "R", 12);
  check("prediction shorter than horizon is skipped", none.length === 0, `n=${none.length}`);

  const t = evaluatePredictions([prediction], reference, "T", 2);
  check("transverse axis evaluates", t.length === 1 && t[0].axis === "T");
  const n = evaluatePredictions([prediction], reference, "N", 2);
  check("normal axis evaluates", n.length === 1 && n[0].axis === "N");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
