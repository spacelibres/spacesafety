/**
 * Cesium globe for the constellation view — a class, per the project's
 * object-oriented rule.
 *
 * ## Why Cesium rather than a hand-built sphere
 *
 * The previous viewer drew its own sphere, graticule and borders in Three.js.
 * Every one of those is something Cesium already does correctly: an ellipsoid
 * rather than a sphere, WGS84, imagery providers with proper texture handling,
 * a graticule that follows the ellipsoid, camera controls, and screen-space
 * picking that accounts for the horizon. Rebuilding them meant rebuilding their
 * bugs too — the last one being a black ring where 13 000 orbit lines piled up on
 * the terminator.
 *
 * ## Theming
 *
 * Every colour comes from `SceneTheme`, which is derived from the VI palette. When
 * the theme attribute changes, `applyTheme` updates the sky, the atmosphere,
 * the grid, the basemap tint and every orbit colour in place — no reload, and no
 * second copy of the palette.
 *
 * ## Why primitives rather than entities
 *
 * An `Entity` costs a graphics object, a property subscription and a place in the
 * entity pipeline's per-frame update. For 13 000 orbits that is 13 000
 * `createPolyline` calls and 13 000 bounding volumes walked every frame, which is
 * what made the view unusable. A `PolylineCollection` is a single primitive that
 * batches all of its polylines into one draw call, so the constellation is *one*
 * primitive with 13 000 members. Only the 177 country labels stay on the entity
 * path, because label decluttering is the entity system's job and 177 is the
 * density it was designed for.
 */

import type { SnapshotFile } from "@/lib/geo/snapshot";
import { dequantise } from "@/lib/geo/snapshot";
import { cssColour, type SceneTheme } from "@/lib/vi/theme-bridge";

/** Cesium is loaded dynamically: it is ~2 MB of JS and must not block first paint. */
type CesiumModule = typeof import("cesium");
type Viewer = import("cesium").Viewer;
type PointCollection = import("cesium").PointPrimitiveCollection;
type PolylineCollection = import("cesium").PolylineCollection;
type PointPrimitive = import("cesium").PointPrimitive;

/**
 * One satellite's sampled orbit, decoded once and reused every frame.
 *
 * Positions stay in local (Earth-fixed) kilometres because that is what the
 * snapshot stores; the transform to a Cesium position happens in `tick`.
 */
interface Track {
  /** `points * 3`, km, ECEF. */
  points: Float32Array;
  /** The point primitive drawn for this satellite. */
  point: PointPrimitive;
  shell: string;
}

/**
 * Wall-clock seconds for one synthetic revolution.
 *
 * The real period is ~95 minutes. Animating that would move a dot a few pixels a
 * minute — indistinguishable from a still image — so the display runs at a speed
 * chosen to read as motion. It is a display parameter and has no bearing on the
 * orbital data or on screening.
 */
const ORBIT_PERIOD_SECONDS = 120;

export interface CesiumGlobeOptions {
  container: HTMLElement;
  theme: SceneTheme;
}

export class CesiumGlobe {
  private readonly cesium: CesiumModule;
  private readonly viewer: Viewer;
  private theme: SceneTheme;

  /**
   * The whole constellation as points.
   *
   * Drawing orbit *lines* for 13 000 satellites is what killed the view: every
   * line is a strip of ~100 segments with its own vertex buffer, and they pile up
   * on the horizon until the frame time collapses. A point per satellite is one
   * vertex each and the whole constellation batches into a single draw.
   */
  private points: PointCollection | null = null;
  private readonly tracks: Track[] = [];
  private grid: PolylineCollection | null = null;
  /** Wall-clock start of the animation, so every satellite shares one phase. */
  private animationStart = 0;
  /** Shell colours, kept so a theme change can recolour the dots. */
  private shells = new Map<string, string>();
  private disposed = false;

  private constructor(
    cesium: CesiumModule,
    viewer: Viewer,
    options: CesiumGlobeOptions,
  ) {
    this.cesium = cesium;
    this.viewer = viewer;
    this.theme = options.theme;
    this.scratch = new cesium.Cartesian3();
  }

  /**
   * Create the globe.
   *
   * Static: constructing a Cesium viewer needs the module to be loaded first, and
   * awaiting inside a constructor is not possible.
   */
  static async create(options: CesiumGlobeOptions): Promise<CesiumGlobe> {
    const cesium = await import("cesium");

    // Cesium resolves its workers and assets relative to this base. Pointing it
    // at the copy in `public/cesium` keeps the widgets, textures and web workers
    // on our own origin instead of a CDN, which a self-hosted deployment needs.
    (window as unknown as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = "/cesium";

    const viewer = new cesium.Viewer(options.container, {
      // The product is a data view, not a GIS workstation: the widget chrome
      // would cover the constellation.
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      // No default Bing/OSM imagery: the basemap is our own single Earth texture,
      // and Cesium's default provider needs a token.
      baseLayer: false,
      contextOptions: {
        // The orbit polylines are thin and dense; without this they shimmer.
        webgl: { alpha: true, antialias: true },
      },
    });

    const globe = new CesiumGlobe(cesium, viewer, options);
    globe.configureScene();
    return globe;
  }

  /** Scene, camera and imagery setup that only runs once. */
  private configureScene(): void {
    const { viewer } = this;
    const scene = viewer.scene;

    // Transparent so the page's own background shows through, exactly as the
    // theme defines it.
    scene.backgroundColor = this.toColor(this.theme.background);
    // No star box, no default Sun/Moon spheres: the constellation must read as a
    // clean diagram, and Cesium's own celestial bodies are not on the VI palette.
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;

    // Atmosphere on: it is what makes a globe read as a planet rather than a
    // photograph on a disc.
    scene.globe.showGroundAtmosphere = true;
    scene.globe.baseColor = this.toColor(this.theme.globe);
    scene.globe.enableLighting = false;

    // Imagery: Cesium's own Natural Earth II tiles, which ship with the package
    // (608 KB across three zoom levels) and are already served from
    // `public/cesium` by `tools/copy-cesium.ts`. No provider token, no external
    // network call, and no big extra asset: the previous single 5400x2700 JPEG
    // was 2.5 MB loaded in full at every zoom level.
    //
    // Note the URL scheme: this tileset uses TMS rows (origin at the south pole,
    // `{reverseY}`) rather than the XYZ rows most web maps use. Getting that
    // wrong renders the southern hemisphere upside down, which looks plausible
    // enough to survive a casual glance.
    const imagery = scene.imageryLayers;
    imagery.removeAll();
    const provider = new this.cesium.UrlTemplateImageryProvider({
      url: "/cesium/Assets/Textures/NaturalEarthII/{z}/{reverseY}/{x}.jpg",
      maximumLevel: 2,
      tilingScheme: new this.cesium.GeographicTilingScheme(),
      rectangle: this.cesium.Rectangle.MAX_VALUE,
    });
    const layer = imagery.addImageryProvider(provider);
    // Brightness/saturation are theme-driven: on the dark theme the imagery is
    // toned down so the constellation stays the dominant layer.
    layer.brightness = this.theme.mode === "dark" ? 0.62 : 1.0;
    layer.saturation = this.theme.mode === "dark" ? 0.75 : 1.0;

    // No terrain: a flat ellipsoid keeps the whole constellation on screen without
    // streaming terrain tiles, and orbital data is at 550 km where the surface
    // shape is irrelevant to the display.
    viewer.terrainProvider = new this.cesium.EllipsoidTerrainProvider();

    // Start looking at the whole planet.
    viewer.camera.setView({ destination: this.cesium.Cartesian3.fromDegrees(10, 20, 32_000_000) });
  }

  /**
   * Draw the basemap: the graticule only.
   *
   * Country labels used to be drawn here from `CountryFeature[]`. They were the
   * densest text on a view whose subject is the constellation and they competed
   * with it, so they are gone. The data itself is archived — see
   * `src/lib/geo/countries.ts` — for the day a view needs to mark a ground
   * station or a launch site.
   *
   * Idempotent: called again whenever the theme re-renders the component.
   */
  addBasemap(): void {
    if (this.disposed) return;
    if (!this.grid) this.addGrid();
  }

  /**
   * A 15° graticule.
   *
   * Cesium has no built-in grid. It lives in its own `PolylineCollection` so it can
   * be recoloured independently of the orbits, instead of being rebuilt whenever
   * the theme changes.
   */
  private addGrid(): void {
    const { cesium, viewer } = this;
    const collection = new cesium.PolylineCollection();
    const colour = this.toColor(this.theme.graticule, 0.3);
    const equatorColour = this.toColor(this.theme.equator, 0.5);

    const material = (c: import("cesium").Color) =>
      new cesium.Material({ fabric: { type: "Color", uniforms: { color: c } } });
    const lineMaterial = material(colour);
    const equatorMaterial = material(equatorColour);

    // Parallels every 15°; the equator is drawn separately, brighter.
    for (let lat = -75; lat <= 75; lat += 15) {
      const positions: import("cesium").Cartesian3[] = [];
      for (let lon = -180; lon <= 180; lon += 2) {
        positions.push(cesium.Cartesian3.fromDegrees(lon, lat, 1000));
      }
      collection.add({ positions, width: 1, material: lineMaterial });
    }
    // Meridians every 15°.
    for (let lon = -180; lon < 180; lon += 15) {
      const positions: import("cesium").Cartesian3[] = [];
      for (let lat = -90; lat <= 90; lat += 2) {
        positions.push(cesium.Cartesian3.fromDegrees(lon, lat, 1000));
      }
      collection.add({ positions, width: 1, material: lineMaterial });
    }
    // The equator is the one line a viewer uses to orient, so it is brighter.
    const equator: import("cesium").Cartesian3[] = [];
    for (let lon = -180; lon <= 180; lon += 2) {
      equator.push(cesium.Cartesian3.fromDegrees(lon, 0, 1000));
    }
    collection.add({ positions: equator, width: 1.5, material: equatorMaterial });

    this.grid = viewer.scene.primitives.add(collection);
  }

  /**
   * Draw every satellite as a single point.
   *
   * The snapshot carries a full sampled orbit per satellite, which is what the
   * animation needs, but drawing those samples as a polyline is what made the view
   * unrenderable: 13 000 strips of ~100 segments each, all piling up on the limb
   * of the globe. A `PointPrimitiveCollection` draws one vertex per satellite and
   * batches the whole constellation into a single draw call, so the cost is
   * bounded by the number of satellites rather than by their orbit resolution.
   */
  addConstellation(snapshot: SnapshotFile, shells: Map<string, string>): void {
    if (this.disposed) return;
    const { cesium, viewer } = this;

    // A new snapshot replaces the old one rather than overlaying it.
    this.clearConstellation();
    this.shells = shells;
    const collection = new cesium.PointPrimitiveCollection();
    const fallback = cssColour(this.theme.primary);

    // One colour object per shell rather than per satellite; the pick set is
    // shared too, so hovering costs nothing extra.
    const colours = new Map<string, import("cesium").Color>();
    const colourFor = (shell: string): import("cesium").Color => {
      const existing = colours.get(shell);
      if (existing) return existing;
      const created = cesium.Color.fromCssColorString(shells.get(shell) ?? fallback);
      colours.set(shell, created);
      return created;
    };

    for (const track of snapshot.tracks) {
      const points = dequantise(track);
      // The first sample is where the satellite sits at t0; `tick` moves it from
      // there along the ring, so the initial position must be a real one.
      const point = collection.add({
        position: new cesium.Cartesian3(
          points[0] * 1000,
          points[1] * 1000,
          points[2] * 1000,
        ),
        pixelSize: 2,
        color: colourFor(track.shell),
        // Picking a dot reports which satellite it is.
        id: { norad: track.norad, name: track.name, shell: track.shell },
      });

      this.tracks.push({
        points,
        point,
        shell: track.shell,
      });
    }

    this.points = viewer.scene.primitives.add(collection);
    this.animationStart = performance.now();
    this.tick();
  }

  /** Remove the constellation primitive and forget its members. */
  private clearConstellation(): void {
    this.tracks.length = 0;
    if (!this.points) return;
    this.viewer.scene.primitives.remove(this.points);
    this.points = null;
  }

  /**
   * Advance every satellite along its orbit.
   *
   * One revolution per `ORBIT_PERIOD_SECONDS` of wall time, so the motion is
   * legible rather than a blur and every satellite stays in phase with the others
   * (real periods differ by minutes, which would make a 95-minute orbit crawl).
   *
   * The cost is one `position` write per satellite per frame and no allocation: the
   * decoded samples are reused, only the interpolation index changes. Writing
   * `Cartesian3`s into a pool rather than creating them keeps the frame free of
   * garbage.
   */
  tick(now = performance.now()): void {
    if (this.disposed || this.tracks.length === 0) return;

    const elapsed = (now - this.animationStart) / 1000;
    const phase = (elapsed / ORBIT_PERIOD_SECONDS) % 1;

    for (const track of this.tracks) {
      const count = track.points.length / 3;
      // Fractional index into the sampled ring, wrapping at the end.
      const at = phase * count;
      const i = Math.floor(at);
      const j = (i + 1) % count;
      const w = at - i;

      const a = i * 3;
      const b = j * 3;
      this.scratch.x =
        (track.points[a] + (track.points[b] - track.points[a]) * w) * 1000;
      this.scratch.y =
        (track.points[a + 1] + (track.points[b + 1] - track.points[a + 1]) * w) * 1000;
      this.scratch.z =
        (track.points[a + 2] + (track.points[b + 2] - track.points[a + 2]) * w) * 1000;
      track.point.position = this.scratch;
    }
  }

  /** Reused by `tick`, so the per-frame loop allocates nothing. */
  private readonly scratch: import("cesium").Cartesian3;

  /** Re-apply every theme-driven colour without rebuilding the scene. */
  applyTheme(theme: SceneTheme): void {
    if (this.disposed) return;
    // Remember it: shells that appear after a re-theme need the same resolution.
    this.theme = theme;
    const scene = this.viewer.scene;
    scene.backgroundColor = this.toColor(theme.background);
    scene.globe.baseColor = this.toColor(theme.globe);

    const layer = scene.imageryLayers.get(0);
    if (layer) {
      layer.brightness = theme.mode === "dark" ? 0.62 : 1.0;
      layer.saturation = theme.mode === "dark" ? 0.75 : 1.0;
    }

    // The graticule shares one material, so one assignment re-themes it all.
    if (this.grid) {
      const gridMaterial = new this.cesium.Material({
        fabric: {
          type: "Color",
          uniforms: { color: this.toColor(theme.graticule, 0.3) },
        },
      });
      for (let i = 0; i < this.grid.length; i += 1) {
        this.grid.get(i).material = gridMaterial;
      }
    }
    const labelFill = this.toColor(theme.labelText);
    const labelOutline = this.toColor(theme.labelOutline, 0.9);

    // Dots take their colour from the palette, so they follow the theme too.
    const fallback = cssColour(theme.primary);
    const colours = new Map<string, import("cesium").Color>();
    for (const track of this.tracks) {
      let colour = colours.get(track.shell);
      if (!colour) {
        colour = this.cesium.Color.fromCssColorString(this.shells.get(track.shell) ?? fallback);
        colours.set(track.shell, colour);
      }
      track.point.color = colour;
    }
  }

  /** Cesium colour from our numeric scene colour. */
  private toColor(value: number, alpha = 1): import("cesium").Color {
    return this.cesium.Color.fromCssColorString(cssColour(value, alpha));
  }

  /** Fly to a position, used by "locate this satellite" actions. */
  flyTo(lon: number, lat: number, heightMetres = 2_000_000): void {
    this.viewer.camera.flyTo({
      destination: this.cesium.Cartesian3.fromDegrees(lon, lat, heightMetres),
      duration: 1.2,
    });
  }

  /** Latitude/longitude under a screen point, or null over space. */
  pickGlobe(x: number, y: number): { lat: number; lon: number } | null {
    const { cesium, viewer } = this;
    const cartesian = viewer.camera.pickEllipsoid(new cesium.Cartesian2(x, y), viewer.scene.globe.ellipsoid);
    if (!cartesian) return null;
    const carto = cesium.Cartographic.fromCartesian(cartesian);
    return {
      lat: cesium.Math.toDegrees(carto.latitude),
      lon: cesium.Math.toDegrees(carto.longitude),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tracks.length = 0;
    this.points = null;
    this.grid = null;
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
  }
}
