/**
 * Fetch the country basemap used by the globe.
 *
 * Natural Earth 1:110m admin-0, public domain. The 110m scale (~800 KB) is the
 * right one here: at 1m the borders would be finer than a few pixels at any
 * usable globe zoom, and the file would be 25 MB for no visible gain.
 *
 * The GeoJSON carries country names in ~40 languages, which is why the map needs
 * no hand-written translation table — `src/lib/geo/countries.ts` reads the
 * columns matching our locales.
 *
 *   npm run fetch:geo
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const URL_SOURCE =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";
const OUT = join(ROOT, "public", "geo", "countries-110m.geojson");

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
}

void main();
