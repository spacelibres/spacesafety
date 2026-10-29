/**
 * Fetch the country reference data.
 *
 * Natural Earth 1:110m admin-0, public domain. Kept as a **reference dataset**, not
 * as a map layer: the globe no longer draws country names (they cluttered the
 * constellation and duplicated information the graticule already conveys), so
 * this no longer lives in `public/` and is not shipped to the browser.
 *
 * It is kept because it is the only source in the project for country names in
 * ~40 languages, sovereign/ISO identifiers and label anchors — all of which are
 * needed the moment a view wants to mark a ground station, a landing zone or a
 * launch site. Re-fetching takes one command.
 *
 * Output is the untouched upstream file: pruning the columns to the six UI locales
 * would throw away the rest of the archive for a few hundred KB.
 *
 *   npm run fetch:geo
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const URL_SOURCE =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";
const OUT = join(ROOT, "data", "reference", "countries-110m.geojson");

async function main(): Promise<void> {
  await mkdir(dirname(OUT), { recursive: true });
  console.log(`fetching ${URL_SOURCE}`);

  const response = await fetch(URL_SOURCE, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    console.error(`HTTP ${response.status}`);
    process.exit(1);
  }
  const body = await response.text();

  // Parse before writing: a truncated download parses as broken JSON, and
  // shipping that to the client would break the globe with no explanation.
  let parsed: { features?: unknown[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    console.error("response is not valid JSON (truncated download?)");
    process.exit(1);
  }
  const count = parsed.features?.length ?? 0;
  if (count < 150) {
    console.error(`only ${count} features; expected ~177 — refusing to write`);
    process.exit(1);
  }

  await writeFile(OUT, body, "utf8");
  const size = (await stat(OUT)).size;
  console.log(`${count} countries, ${(size / 1024).toFixed(0)} KB -> ${OUT}`);
  console.log("reference data; not served to the browser. See tools/fetch-geo.ts.");
}

void main();
