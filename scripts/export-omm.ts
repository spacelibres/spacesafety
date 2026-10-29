/**
 * Export the stored OMMs in both forms.
 *
 * Two files, because they answer different questions:
 *
 *   - `starlink-omm.json` — the **raw Space-Track response**, exactly as the API
 *     returned it. This is the evidence that the data is what the vendor issued;
 *     re-serialising would destroy that property (and did: the first ingest stored
 *     only our own KVN rendering, so the original fields were lost).
 *   - `starlink-omm.kvn` — CCSDS OMM text, one record per object, terminated by
 *     `DATA_START`/`DATA_STOP`. This is the portable, tool-readable form.
 *
 * The JSON is re-fetched rather than reconstructed, because a reconstruction
 * cannot be distinguished from an invention.
 *
 *   npm run export:omm
 */

import { writeFileSync } from "node:fs";

import type { OmmRecord } from "../src/lib/sources/space-track";

async function main() {
  const { loadEnvLocal } = await import("../scripts/env");
  loadEnvLocal();

  const { getDb } = await import("../src/db");
  const { fetchOmm } = await import("../src/lib/sources/space-track");
  const { formatOmm } = await import("../src/lib/sources/omm-format");

  const { db } = getDb();
  const norads = db
    .select()
    .from(
      // The objects table carries the catalogue numbers; use it rather than
      // re-parsing them out of stored text.
      (await import("../src/db/schema")).objects,
    )
    .all()
    .map((o) => o.noradId)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);

  if (norads.length === 0) {
    console.error("no objects with NORAD ids; run `npm run ingest:starlink` first");
    process.exit(1);
  }

  console.log(`fetching OMM for ${norads.length} object(s)…`);

  // Batch requests: one call per object trips Space-Track's rate limit.
  const BATCH = 20;
  const records: OmmRecord[] = [];
  for (let i = 0; i < norads.length; i += BATCH) {
    const batch = norads.slice(i, i + BATCH);
    const res = await fetchOmm({ noradIds: batch, limit: batch.length * 2 });
    if (res.error) {
      console.error(`  batch ${i + 1}-${i + batch.length} failed: ${res.error}`);
      process.exit(1);
    }
    records.push(...res.records);
    console.log(`  got ${records.length}/${norads.length}`);
  }

  // --- raw JSON: the API's own field names and ordering, one object per line so
  // the file stays diffable and greppable.
  const json = records.map((r) => r.raw);
  writeFileSync("./data/starlink-omm.json", `${JSON.stringify(json, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${json.length} record(s) to ./data/starlink-omm.json`);

  // --- CCSDS KVN, sorted by catalogue number for a stable file.
  const kvn = records
    .slice()
    .sort((a, b) => a.noradId - b.noradId)
    .map((r) => formatOmm(r))
    .join("\n");
  writeFileSync("./data/starlink-omm.kvn", kvn, "utf8");
  console.log(`wrote ${records.length} record(s) to ./data/starlink-omm.kvn`);

  const first = records[0];
  console.log(
    `\n  first: ${first.objectName} norad=${first.noradId} designator=${first.objectId} ` +
      `type=${first.objectType} apogee=${first.apogeeKm} km`,
  );
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Keep this file a module: without an export every `main` here lands in the
// global scope and collides with the other scripts' `main`.
export {};
