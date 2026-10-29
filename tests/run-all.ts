/**
 * Test runner: executes each test file in its own process so a crash or
 * `process.exit` in one suite cannot mask another.
 */

import { spawnSync } from "node:child_process";

const SUITES = [
  "tests/alfano.test.ts",
  "tests/screening.test.ts",
  "tests/ephemeris.test.ts",
  "tests/ocm.test.ts",
  "tests/shells.test.ts",
  "tests/legacy-formats.test.ts",
  "tests/optical.test.ts",
  "tests/accuracy.test.ts",
  "tests/mtls.test.ts",
  "tests/prefilter.test.ts",
  "tests/determinism.test.ts",
  "tests/time-windows.test.ts",
  "tests/pool.test.ts",
  "tests/thread-memory.test.ts",
  "tests/chart-axes.test.ts",
  "tests/tle-sgp4.test.ts",
  "tests/ocm-source.test.ts",
  "tests/source-policy.test.ts",
  "tests/dual-feed.test.ts",
  "tests/worker-companion.test.ts",
  "tests/worker-companion-pool.test.ts",
  "tests/catalog-policy.test.ts",
  "tests/api.test.ts",
];

let failed = 0;
for (const suite of SUITES) {
  console.log(`\n${"=".repeat(60)}\n${suite}\n${"=".repeat(60)}`);
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", suite],
    { stdio: "inherit" },
  );
  if (result.status !== 0) failed += 1;
}

console.log(`\n${"=".repeat(60)}`);
if (failed === 0) {
  console.log(`All ${SUITES.length} suites passed.`);
} else {
  console.log(`${failed} of ${SUITES.length} suites FAILED.`);
}
process.exit(failed ? 1 : 0);
