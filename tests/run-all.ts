/**
 * Test runner: executes each test file in its own process so a crash or
 * `process.exit` in one suite cannot mask another.
 *
 * ## Why the list is discovered rather than written out
 *
 * It used to be a hand-maintained array. Two suites — `event-feeds` and
 * `feed-combination` — were written, given their own `npm run test:*` scripts,
 * and then never added to it, so 45 assertions were outside the gate that
 * `CONTRIBUTING.md` §7 calls mandatory. Among them were the two that protect the
 * project's most expensive historical mistake: a missing Pc must stay NULL
 * rather than be written as 0, and a missing fragmentation site must stay NULL
 * rather than become `0,0` — a real coordinate in the Gulf of Guinea. A suite now
 * runs the moment its file exists, so forgetting to wire one is impossible.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS = dirname(fileURLToPath(import.meta.url));

/** Every `*.test.ts` directly under `tests/`, in a stable order. */
function suites(): string[] {
  return readdirSync(TESTS)
    .filter((name) => name.endsWith(".test.ts"))
    .filter((name) => statSync(join(TESTS, name)).isFile())
    .sort()
    .map((name) => join("tests", name));
}

const SUITES = suites();

if (SUITES.length === 0) {
  console.log("No test suites found under tests/");
  process.exit(1);
}

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
