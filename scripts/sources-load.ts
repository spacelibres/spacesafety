import { readFile } from "node:fs/promises";
/**
 * Load archived captures into the database.
 *
 * The archive is the source of truth for ingestion: every loader reads a capture
 * from `data/archive/`, never the network. That makes the import re-runnable when
 * a loader is fixed, and it guarantees the database reflects a specific capture
 * rather than "whatever the API happened to return".
 *
 *   npm run sources:load                    # every registered archive
 *   npm run sources:load -- --only discos-objects
 *   npm run sources:load -- --path <file>   # a specific capture
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

async function main(): Promise<void> {
  const { loadEnvLocal } = await import("./env");
  loadEnvLocal();

  const { getDb } = await import("../src/db");
  const { SourceArchive } = await import("../src/lib/sources/archive");
  const { DiscosImporter } = await import("../src/lib/sources/discos-import");

  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const only = flag("--only")?.split(",").map((s) => s.trim());

  const { sqlite } = getDb();
  const archive = new SourceArchive();

  const wanted = only ?? ["discos-objects", "spacebook-satcat-details", "space-track-satcat"];

  for (const id of wanted) {
    if (id === "space-track-satcat") {
      const latest = await archive.latest(id);
      if (!latest) {
        console.log(`  ${id}: no capture archived yet`);
        continue;
      }
      const started = Date.now();
      const parsed = JSON.parse(await readFile(latest, "utf8")) as unknown;
      if (!Array.isArray(parsed)) {
        console.error(`  ${id}: capture is not an array`);
        continue;
      }
      const { SpaceTrackSatcatImporter } = await import(
        "../src/lib/sources/space-track-satcat-import"
      );
      const summary = new SpaceTrackSatcatImporter(sqlite).import(parsed);
      console.log(
        `  ${id}: ${summary.imported} row(s) ` +
          `(${summary.withIntlDes} with COSPAR, ${summary.withCountry} with country, ` +
          `${summary.withOrbit} with orbit) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      continue;
    }

    if (id === "spacebook-satcat-details") {
      const latest = await archive.latest(id);
      if (!latest) {
        console.log(`  ${id}: no capture archived yet`);
        continue;
      }
      const started = Date.now();
      const parsed = JSON.parse(await readFile(latest, "utf8")) as unknown;
      if (!Array.isArray(parsed)) {
        console.error(`  ${id}: capture is not an array`);
        continue;
      }
      const { SatcatDetailsImporter } = await import("../src/lib/sources/satcat-details-import");
      const summary = new SatcatDetailsImporter(sqlite).import(parsed);
      console.log(
        `  ${id}: ${summary.physics} physics row(s) ` +
          `(${summary.withHbr} with HBR, ${summary.withMass} with mass, ` +
          `${summary.withBallistic} with B*), ${summary.launchInfo} launch-info row(s) ` +
          `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      continue;
    }

    if (id !== "discos-objects") {
      const latest = await archive.latest(id);
      console.log(`  ${id}: archived at ${latest ?? "—"} (no loader)`);
      continue;
    }

    const started = Date.now();
    const latest = await archive.latest(id);
    if (!latest) {
      console.log(`  ${id}: no capture archived yet`);
      continue;
    }

    // DISCOS captures are written as one assembled document per run, so the
    // newest file is the whole collection rather than a page.
    const text = await (await import("node:fs/promises")).readFile(latest, "utf8");
    const parsed = JSON.parse(text) as { data?: unknown[] };
    if (!Array.isArray(parsed.data)) {
      console.error(`  ${id}: capture is not a JSON:API document`);
      continue;
    }

    const summary = new DiscosImporter(sqlite).import(
      parsed.data as Array<{ id?: string; attributes?: Record<string, unknown> }>,
    );

    console.log(
      `  ${id}: ${summary.imported} object(s) loaded ` +
        `(${summary.withMass} with mass, ${summary.withCrossSection} with cross-section, ` +
        `${summary.skippedNoNorad} without NORAD) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  }

  const counts = sqlite
    .prepare(
      `SELECT (SELECT COUNT(*) FROM satcat) AS satcat,
              (SELECT COUNT(*) FROM discos_objects) AS discos,
              (SELECT COUNT(*) FROM object_sources) AS states,
              (SELECT COUNT(*) FROM object_physics) AS physics`,
    )
    .get() as { satcat: number; discos: number; states: number; physics: number };

  console.log(
    `\n  database now holds ${counts.satcat} SATCAT row(s), ` +
      `${counts.discos} DISCOS object(s), ${counts.physics} physics row(s), ` +
      `${counts.states} per-source state(s)\n`,
  );
  void join;
  void readdir;
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
