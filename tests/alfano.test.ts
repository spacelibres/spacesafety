/**
 * Alfano 2D collision-probability kernel tests.
 *
 * The reference values were produced independently by high-resolution polar
 * quadrature centred on the disk (a different code path from the kernel), for
 * an isotropic bivariate normal with sigma = 1 km, hard-body radius 5 m,
 * mean offset `d` along +x.
 */

import { alfano2d } from "../src/lib/core/alfano";
import type { Mat3 } from "../src/lib/core/linalg";

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

const isoCov = (s: number): Mat3 => [s * s, 0, 0, 0, s * s, 0, 0, 0, s * s];

/** Independent reference values (sigma = 1 km, R = 0.005 km). */
const REFERENCE: [number, number][] = [
  [0.5, 1.1031e-5],
  [1.0, 7.5816e-6],
  [3.0, 1.3887e-7],
  [8.0, 1.5833e-19],
];

console.log("\nAlfano 2D — reference agreement");
for (const [d, expected] of REFERENCE) {
  const r = alfano2d({
    relativePosition: [d, 0, 0],
    relativeVelocity: [0, 10, 0],
    combinedCovariance: isoCov(1),
    hardBodyRadiusKm: 0.005,
  });
  const relErr = r ? Math.abs(r.probability - expected) / expected : Infinity;
  check(
    `d=${d}km matches reference`,
    r !== null && relErr < 0.02,
    r ? `got=${r.probability.toExponential(4)} want=${expected.toExponential(4)} err=${(relErr * 100).toFixed(2)}%` : "null",
  );
}

console.log("\nAlfano 2D — invariants");
const rDirect = alfano2d({
  relativePosition: [0.0005, 0, 0],
  relativeVelocity: [0, 10, 0],
  combinedCovariance: isoCov(1e-4),
  hardBodyRadiusKm: 0.01,
});
check("miss inside hard body -> P=1", rDirect?.probability === 1);

check(
  "zero relative velocity -> null",
  alfano2d({
    relativePosition: [1, 0, 0],
    relativeVelocity: [0, 0, 0],
    combinedCovariance: isoCov(1),
    hardBodyRadiusKm: 0.01,
  }) === null,
);

check(
  "non-PSD covariance -> null",
  alfano2d({
    relativePosition: [1, 0, 0],
    relativeVelocity: [0, 10, 0],
    combinedCovariance: [1, 2, 0, 2, 1, 0, 0, 0, 1],
    hardBodyRadiusKm: 0.01,
  }) === null,
);

check(
  "zero hard-body radius -> null",
  alfano2d({
    relativePosition: [1, 0, 0],
    relativeVelocity: [0, 10, 0],
    combinedCovariance: isoCov(1),
    hardBodyRadiusKm: 0,
  }) === null,
);

// Pc must fall monotonically with miss distance.
{
  let prev = Infinity;
  let monotonic = true;
  for (const d of [1, 2, 4, 8, 16, 32, 64]) {
    const p =
      alfano2d({
        relativePosition: [d, 0, 0],
        relativeVelocity: [0, 11, 0],
        combinedCovariance: isoCov(2),
        hardBodyRadiusKm: 0.005,
      })?.probability ?? 0;
    if (p > prev + 1e-15) monotonic = false;
    prev = p;
  }
  check("Pc decreases monotonically with miss distance", monotonic);
}

// Rotating the whole problem must not change the answer.
{
  const a = alfano2d({
    relativePosition: [17, 3, 2],
    relativeVelocity: [1, 9, 0.5],
    combinedCovariance: [3, 0, 0, 0, 5, 0, 0, 0, 2],
    hardBodyRadiusKm: 0.008,
  });
  const b = alfano2d({
    relativePosition: [2, 17, 3],
    relativeVelocity: [0.5, 1, 9],
    combinedCovariance: [2, 0, 0, 0, 3, 0, 0, 0, 5],
    hardBodyRadiusKm: 0.008,
  });
  check(
    "invariant under axis permutation",
    a !== null &&
      b !== null &&
      Math.abs(a.probability - b.probability) / Math.max(a.probability, 1e-30) < 1e-3,
    `${a?.probability.toExponential(5)} vs ${b?.probability.toExponential(5)}`,
  );
}

// Scaling covariance and miss distance together leaves Pc unchanged.
{
  const k = 4;
  const a = alfano2d({
    relativePosition: [2, 0, 0],
    relativeVelocity: [0, 10, 0],
    combinedCovariance: isoCov(1),
    hardBodyRadiusKm: 0.02,
  });
  const b = alfano2d({
    relativePosition: [2 * k, 0, 0],
    relativeVelocity: [0, 10, 0],
    combinedCovariance: isoCov(k),
    hardBodyRadiusKm: 0.02 * k,
  });
  check(
    "scale invariant (d, sigma, R all x4)",
    a !== null &&
      b !== null &&
      Math.abs(a.probability - b.probability) / Math.max(a.probability, 1e-30) < 1e-6,
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
