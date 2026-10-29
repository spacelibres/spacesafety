/**
 * Backfill NORAD catalogue ids.
 *
 * Resolves `objects.norad_id` for every object that lacks one, by matching the
 * object's name against the Space-Track catalogue and cross-checking the orbit
 * (inclination and mean altitude) so a reused name cannot be mistaken for the
 * real object.
 *
 * Requires `SPACE_EYES_SPACETRACK_USER` / `SPACE_EYES_SPACETRACK_PASS`.
 *
 *   npm run norad:backfill            # write
 *   npm run norad:backfill -- --dry-run
 */

/**
 * `export` is load-bearing: a script without any import or export is treated as a
 * global script by TypeScript, so its `main` shares a scope with every other such
 * file and collides. This keeps the file a module.
 */
export {};

async function main() {
  const { loadEnvLocal } = await import("./env");
  loadEnvLocal();
  const dryRun = process.argv.includes("--dry-run");
  const { backfillNoradIds } = await import("../src/lib/sources/norad");

  console.log(`\nSpace Eyes — NORAD catalogue backfill${dryRun ? " (dry run)" : ""}\n`);

  const result = await backfillNoradIds({ dryRun });

  console.log(`  resolved  : ${result.updated}`);
  console.log(`  skipped   : ${result.skipped} (no trajectory)`);
  console.log(`  unresolved: ${result.unresolved.length}`);
  for (const u of result.unresolved) {
    console.log(`    ${u.objectName}: ${u.error}`);
  }
  if (dryRun) console.log("\n  (dry run: nothing written)");
  console.log();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
