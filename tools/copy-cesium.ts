/**
 * Copy Cesium's runtime assets into `public/cesium`.
 *
 * Cesium does not bundle its workers, textures, IAU data or widget CSS into the
 * application bundle: at run time it loads them from `window.CESIUM_BASE_URL`.
 * The files therefore have to be served from our own origin, which means a copy
 * into `public/`.
 *
 * They are not committed — 7.7 MB of third-party JS would bloat every clone and
 * the copy is reproducible from the installed package. This script runs from
 * `postinstall`, so a fresh `npm install` leaves the app runnable.
 *
 *   npm run cesium:copy
 */

import { cp, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, "node_modules", "cesium", "Build", "Cesium");
const TARGET = join(ROOT, "public", "cesium");

/**
 * Runtime directories only.
 *
 * `Build/Cesium` also ships `Cesium.js`, `index.js` and `index.cjs` — those are the
 * package's *module* entry points, which the bundler resolves from
 * `node_modules`. Copying them to `public/` would serve 15 MB of duplicate code
 * that nothing requests.
 */
const DIRECTORIES = ["Workers", "Assets", "ThirdParty", "Widgets"];

/** Size of a directory tree, for the summary line. */
async function size(dir: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    const info = await stat(full);
    total += info.isDirectory() ? await size(full) : info.size;
  }
  return total;
}

export class CesiumAssets {
  /** Returns the process exit code: 0 copied, 1 when the package is missing. */
  async run(): Promise<number> {
    try {
      await stat(SOURCE);
    } catch {
      console.error(
        `cesium is not installed (${SOURCE} is missing).\n` +
          "Run `npm install` first; this script runs automatically afterwards.",
      );
      return 1;
    }

    await stat(SOURCE);
    // A stale copy from an older layout would keep serving the entry points.
    await rm(TARGET, { recursive: true, force: true });
    for (const name of DIRECTORIES) {
      await cp(join(SOURCE, name), join(TARGET, name), { recursive: true });
    }
    const mb = ((await size(TARGET)) / 1e6).toFixed(1);
    console.log(`cesium assets -> public/cesium (${mb} MB)`);
    return 0;
  }
}

async function main(): Promise<void> {
  process.exit(await new CesiumAssets().run());
}

void main();
