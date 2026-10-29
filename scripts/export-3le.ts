/**
 * Export the stored TLEs as one 3LE file.
 *
 * A single file is the form Space-Track itself serves (`format/3le`) and the form
 * SGP4 tooling expects, so it can be handed to anything that reads TLEs without
 * going through our database.
 *
 *   npm run export:3le                 -> data/starlink-3le.txt
 *   npm run export:3le -- --out x.txt
 */

import { writeFileSync } from "node:fs";

async function main() {
  const { getDb } = await import("../src/db");
  const { trajectoryFiles, trajectories } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");

  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const out = outIdx === -1 ? "./data/starlink-3le.txt" : argv[outIdx + 1];

  const { db } = getDb();
  const rows = db
    .select({ id: trajectories.id, fileText: trajectoryFiles.fileText })
    .from(trajectories)
    .innerJoin(trajectoryFiles, eq(trajectoryFiles.trajectoryId, trajectories.id))
    .where(eq(trajectories.stateSource, "tle"))
    .all();

  if (rows.length === 0) {
    console.error("no TLE rows stored; run `npm run ingest:tle` first");
    process.exit(1);
  }

  // Sort by NORAD id so the file is stable between runs and diffable.
  const entries = rows
    .map((r) => {
      const lines = r.fileText.split(/\r?\n/).filter((l: string) => l.trim() !== "");
      // The stored text is `name\nline1\nline2` (the name is optional when the
      // catalogue has none, in which case only two lines are present).
      if (lines.length >= 3) return { name: lines[0].trim(), l1: lines[1], l2: lines[2] };
      if (lines.length === 2) return { name: "", l1: lines[0], l2: lines[1] };
      return null;
    })
    .filter((e): e is { name: string; l1: string; l2: string } => e !== null)
    .map((e) => {
      const norad = Number.parseInt(e.l1.slice(2, 7).trim().replace(/^0+(?=\d)/, ""), 10);
      return { ...e, norad: Number.isFinite(norad) ? norad : 0 };
    })
    .sort((a, b) => a.norad - b.norad);

  // 3LE is: one name line, then the two TLE lines, repeated. A trailing newline
  // keeps the last entry well-formed for line-oriented parsers.
  const body =
    entries
      .map((e) => {
        // The name line conventionally starts with "0 " and the catalogue number.
        const nameLine = e.name ? e.name : `0 ${e.l1.slice(2, 7).trim()}`;
        return `${nameLine}\n${e.l1}\n${e.l2}`;
      })
      .join("\n") + "\n";

  writeFileSync(out, body, "utf8");
  console.log(`wrote ${entries.length} TLE(s) to ${out}`);
  console.log(`  first: ${entries[0].name || entries[0].l1.slice(2, 7).trim()}`);
  console.log(`  last:  ${entries[entries.length - 1].name || entries[entries.length - 1].l1.slice(2, 7).trim()}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Keep this file a module: without an export every `main` here lands in the
// global scope and collides with the other scripts' `main`.
export {};
