/**
 * Loads Cesium from its own UMD bundle on our origin instead of the module graph.
 *
 * ## Why not `import("cesium")`
 *
 * Bundling Cesium put `@spz-loader/core` — a dependency of `@cesium/engine` that
 * carries a WebAssembly binary as an escaped string literal — into a client
 * chunk. The production minifier re-escapes that literal, and every NUL byte it
 * meets becomes `\0`: where the next byte happens to be an ASCII digit the pair
 * `\00` is an **illegal octal escape inside a template literal**. The whole chunk
 * is then a `SyntaxError`, so `import("cesium")` never resolves and the 3D view
 * stays on its loading text forever. Nothing in `tsc`, the test suite or a
 * status-code probe can see this; `tools/check.ts` now parses every emitted
 * chunk so it cannot come back.
 *
 * `cesium/Build/Cesium/Cesium.js` is the entry Cesium ships for exactly this
 * case. Loading it through a script tag keeps the binary blob out of the
 * bundler's hands, and as a side effect the client JS shrinks by the ~5 MB of
 * engine code that used to be walked by webpack on every build.
 *
 * ## Why a class
 *
 * The bundle has to be fetched once and shared by every globe on the page, so
 * the loader carries state. The project's rule is that stateful capability lives
 * in a class rather than a module-level variable, which is what this is; the
 * exported instance stands for the page's single `window`, not a global of our
 * own invention.
 */

/** The Cesium namespace, typed from the package so call sites keep full types. */
export type CesiumModule = typeof import("cesium");

/** Where `npm run cesium:copy` puts the bundle, and the app fetches it from. */
const BUNDLE_URL = "/cesium/Cesium.js";
const SCRIPT_ID = "cesium-bundle";

/** `globalThis` with Cesium's two document-level hooks. */
interface CesiumGlobal {
  Cesium?: CesiumModule;
  CESIUM_BASE_URL?: string;
}

/** Raised when the bundle cannot be fetched or does not define the namespace. */
export class CesiumLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CesiumLoadError";
  }
}

export class CesiumBundle {
  private pending: Promise<CesiumModule> | null = null;

  /**
   * Resolve the namespace, fetching the bundle the first time.
   *
   * Concurrent callers share one request: two globes mounting in the same tick
   * must not append two scripts or start two downloads.
   */
  load(): Promise<CesiumModule> {
    this.pending ??= this.fetch();
    return this.pending;
  }

  /**
   * Point Cesium at the assets copied into `public/cesium`.
   *
   * Must run *before* the bundle executes: Cesium captures this value while it
   * initialises, so setting it afterwards leaves every worker and texture
   * looking in the wrong place.
   */
  static setAssetBase(url = "/cesium"): void {
    (globalThis as CesiumGlobal).CESIUM_BASE_URL = url;
  }

  private fetch(): Promise<CesiumModule> {
    const scope = globalThis as CesiumGlobal;
    if (scope.Cesium) return Promise.resolve(scope.Cesium);

    return new Promise<CesiumModule>((resolve, reject) => {
      const settle = (): void => {
        const loaded = (globalThis as CesiumGlobal).Cesium;
        if (loaded) resolve(loaded);
        else reject(new CesiumLoadError(`${BUNDLE_URL} loaded but defined no Cesium namespace`));
      };
      const failed = (): void =>
        reject(new CesiumLoadError(`${BUNDLE_URL} could not be loaded`));

      // A previous mount may still have the request in flight; reusing the tag
      // is what makes the second caller wait instead of downloading again.
      const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
      if (existing) {
        existing.addEventListener("load", settle, { once: true });
        existing.addEventListener("error", failed, { once: true });
        return;
      }

      const script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = BUNDLE_URL;
      script.async = true;
      script.addEventListener("load", settle, { once: true });
      script.addEventListener("error", failed, { once: true });
      document.head.appendChild(script);
    });
  }
}

/** The page's bundle loader. One `window`, one bundle. */
export const cesiumBundle = new CesiumBundle();
