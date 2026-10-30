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

import { CesiumBundle, cesiumBundle, type CesiumModule } from "./cesium-bundle";

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
  /** Samples in this revolution. */
  count: number;
  /** The point primitive drawn for this satellite. */
  point: PointPrimitive;
  shell: string;
  norad: string;
  name: string;
}

/**
 * Cesium ion access token, or empty when ion is not configured.
 *
 * Read through `NEXT_PUBLIC_` because the token is consumed by the browser: the
 * imagery request is issued by Cesium in the page, not by our server. That also
 * means it is visible to every visitor, which is why the self-hosted tiles remain
 * the default and this is opt-in — see `configureScene`.
 *
 * `SPACE_SAFETY_CESIUM_ION_TOKEN` is mirrored into this variable by
 * `next.config.ts`, so operators only ever set one name.
 */
const ION_TOKEN = process.env.NEXT_PUBLIC_SPACE_SAFETY_CESIUM_ION_TOKEN ?? "";

/** Cesium ion asset 2 is Bing Maps Aerial — the default world imagery. */
const ION_IMAGERY_ASSET_ID = 2;

/**
 * Wall-clock seconds for one synthetic revolution.
 *
 * The real period is ~95 minutes. Animating that would move a dot a few pixels a
 * minute — indistinguishable from a still image — so the display runs at a speed
 * chosen to read as motion. It is a display parameter and has no bearing on the
 * orbital data or on screening.
 */
const ORBIT_PERIOD_SECONDS = 120;

/** Dot size in CSS pixels, and the size a selected dot grows to. */
const POINT_PIXELS = 2;
const SELECTED_PIXELS = 7;

/**
 * What the view knows about a satellite at the moment it is picked.
 *
 * Deliberately plain data: the React layer renders it and the Cesium layer
 * produces it, and neither needs the other's types. Positions are derived from
 * the same buffer the animation reads, so the card and the dot cannot disagree.
 */
export interface SatelliteInfo {
  /** NORAD catalogue number. */
  norad: string;
  /** Display name, e.g. `STARLINK-1042`. */
  name: string;
  /** Orbit shell key, e.g. `53/550`. */
  shell: string;
  /** Sub-satellite point, degrees. */
  latitude: number;
  longitude: number;
  /** Height above the WGS84 ellipsoid, km. */
  altitudeKm: number;
}

/** Called when the user picks a satellite; `null` means they clicked empty space. */
export type SatellitePickHandler = (info: SatelliteInfo | null) => void;

export interface CesiumGlobeOptions {
  container: HTMLElement;
  theme: SceneTheme;
  /** Invoked on click, after a satellite is resolved. */
  onPick?: SatellitePickHandler;
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
  /** Click handler, owned by the view layer. */
  private readonly onPick: SatellitePickHandler | undefined;
  /** The satellite a click pinned; survives the pointer moving away. */
  private locked: Track | null = null;
  /** The satellite under the pointer. */
  private hovered: Track | null = null;
  /**
   * The orbit line for whichever satellite is previewed.
   *
   * One primitive, replaced on every change: drawing a single polyline is cheap,
   * and keeping a line per satellite is exactly the geometry the point
   * representation exists to avoid.
   */
  private preview: import("cesium").PolylineCollection | null = null;
  /** The previewed satellite, so the line and the card come from one source. */
  private previewTrack: Track | null = null;
  /** Its normal size, so deselection can restore rather than guess. */
  private selectedSize: number;
  /** Shell colours, kept so a theme change can recolour the dots. */
  private shells = new Map<string, string>();
  private pickHandler: import("cesium").ScreenSpaceEventHandler | null = null;
  private disposed = false;
  /**
   * Set immediately before the Cesium widget is torn down.
   *
   * Separate from `disposed` because the two answer different questions:
   * `disposed` means "this globe must not be used again", this one means "the
   * widget - which cannot report its own state, see `dispose` - is already gone".
   */
  private viewerDestroyed = false;

  private constructor(
    cesium: CesiumModule,
    viewer: Viewer,
    options: CesiumGlobeOptions,
  ) {
    this.cesium = cesium;
    this.viewer = viewer;
    this.theme = options.theme;
    this.scratch = new cesium.Cartesian3();
    this.onPick = options.onPick;
    this.selectedSize = POINT_PIXELS;
    this.installPickHandler();
  }

  /**
   * Create the globe.
   *
   * Static: constructing a Cesium viewer needs the module to be loaded first, and
   * awaiting inside a constructor is not possible.
   */
  static async create(options: CesiumGlobeOptions): Promise<CesiumGlobe> {
    // Cesium resolves its workers and assets relative to this base, and reads it
    // while the bundle initialises — so it has to be set before the load starts,
    // not after. Pointing it at the copy in `public/cesium` keeps the widgets,
    // textures and web workers on our own origin instead of a CDN, which a
    // self-hosted deployment needs.
    CesiumBundle.setAssetBase();

    const cesium = await cesiumBundle.load();

    // Without a token Cesium falls back to its built-in default one, which is
    // shared by everyone and rate-limited: the globe would render for a while and
    // then stop loading tiles with no visible error. An empty value must therefore
    // *disable* ion rather than leave the default in place.
    const token = ION_TOKEN;
    if (token) {
      cesium.Ion.defaultAccessToken = token;
    }

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
      // No default Bing/OSM imagery: the basemap is chosen in `configureScene`,
      // and Cesium's default provider needs an ion asset.
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

  /**
   * The self-hosted Natural Earth II tiles.
   *
   * Note the URL scheme: this tileset uses TMS rows (origin at the south pole,
   * `{reverseY}`) rather than the XYZ rows most web maps use. Getting that wrong
   * renders the southern hemisphere upside down, which looks plausible enough to
   * survive a casual glance.
   */
  private localImagery(): import("cesium").UrlTemplateImageryProvider {
    return new this.cesium.UrlTemplateImageryProvider({
      url: "/cesium/Assets/Textures/NaturalEarthII/{z}/{reverseY}/{x}.jpg",
      maximumLevel: 2,
      tilingScheme: new this.cesium.GeographicTilingScheme(),
      rectangle: this.cesium.Rectangle.MAX_VALUE,
    });
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

    // Imagery.
    //
    // Two providers, chosen by whether a Cesium ion token is configured:
    //
    //   without  Cesium's own Natural Earth II tiles, which ship with the package
    //            (42 tiles, 608 KB) and are served from `public/cesium`. No
    //            request leaves our origin.
    //   with     ion World Imagery. Higher resolution at close range, at the cost
    //            of a third-party request on every page view and a metered token
    //            in the browser.
    //
    // The self-hosted tiles are the default because this is a public-facing
    // dashboard: putting a billable credential in every visitor's browser, and
    // making the view depend on a service we do not operate, is the wrong trade
    // for a display that is usually zoomed out far enough that the difference is
    // invisible.
    const imagery = scene.imageryLayers;
    imagery.removeAll();
    // `IonImageryProvider` cannot be constructed directly: the asset metadata has
    // to be fetched first, so it is built through `fromProviderAsync`, which hands
    // back a layer that fills itself in when the request lands.
    // `imagery.add` returns void, so the layer is built first and added second.
    const layer: import("cesium").ImageryLayer = ION_TOKEN
      ? this.cesium.ImageryLayer.fromProviderAsync(
          this.cesium.IonImageryProvider.fromAssetId(ION_IMAGERY_ASSET_ID),
        )
      : new this.cesium.ImageryLayer(this.localImagery());
    imagery.add(layer);
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
        pixelSize: POINT_PIXELS,
        color: colourFor(track.shell),
        // Picking a dot reports which satellite it is.
        id: { norad: track.norad, name: track.name, shell: track.shell },
      });

      this.tracks.push({
        points,
        count: points.length / 3,
        point,
        shell: track.shell,
        norad: track.norad,
        name: track.name,
      });
    }

    this.points = viewer.scene.primitives.add(collection);
    this.animationStart = performance.now();
    this.tick();
  }

  /**
   * Wire a click on the canvas to a satellite lookup.
   *
   * Uses `scene.pick` rather than an entity `onclick`: the points are a single
   * `PointPrimitiveCollection`, which the entity system does not manage, but it
   * is still a `scene.pick` target because `id` is set on each member.
   *
   * The handler is installed once, at construction, and reads `this.tracks` — so a
   * snapshot swap needs no re-wiring.
   */
  private installPickHandler(): void {
    const { cesium, viewer } = this;
    const handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    // Hover previews, click locks. The move handler reads `endPosition`:
    // `startPosition` is where the previous gesture ended, which after a drag is
    // nowhere near the pointer.
    handler.setInputAction((motion: { endPosition: import("cesium").Cartesian2 }) => {
      if (this.disposed) return;
      const track = this.pickAt(motion.endPosition);
      if (track === this.hovered) return;
      this.hovered = track;
      // A lock outranks the pointer: moving off a pinned satellite must not clear
      // what the user deliberately selected.
      this.showPreview(this.locked ?? this.hovered);
      // The card follows the preview when nothing is locked, so it appears on
      // hover; once locked it stays put.
      if (!this.locked) this.onPick?.(this.previewTrack ? this.describe(this.previewTrack) : null);
    }, cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((event: { position: import("cesium").Cartesian2 }) => {
      if (this.disposed) return;
      this.locked = this.pickAt(event.position);
      this.showPreview(this.locked ?? this.hovered);
      this.onPick?.(this.previewTrack ? this.describe(this.previewTrack) : null);
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);

    this.pickHandler = handler;
  }

  /**
   * Clear the locked selection and its orbit line.
   *
   * Called by the info card's close button: the class owns the highlight, so the
   * view cannot clear it by unmounting the card alone — the locked satellite would
   * stay pinned and reappear on the next hover.
   */
  clearPick(): void {
    this.locked = null;
    this.showPreview(this.hovered);
  }

  /** The satellite under a screen point, or null. */
  private pickAt(position: import("cesium").Cartesian2): Track | null {
    const picked = this.viewer.scene.pick(position) as
      | { id?: { norad?: string } }
      | undefined;
    const norad = picked?.id?.norad;
    if (!norad) return null;
    return this.tracks.find((candidate) => candidate.norad === norad) ?? null;
  }

  /**
   * Show one satellite's orbit and highlight its dot; `null` clears both.
   *
   * The dot grows and takes the selection accent, and the orbit is drawn as one
   * closed polyline in the same accent.
   */
  private showPreview(track: Track | null): void {
    const { cesium, viewer } = this;

    // Put the previously highlighted dot back the way the palette had it.
    const previous = this.previewTrack;
    if (previous && previous !== track) {
      previous.point.pixelSize = POINT_PIXELS;
      previous.point.color = this.shellColour(previous.shell);
    }

    if (this.preview) {
      viewer.scene.primitives.remove(this.preview);
      this.preview = null;
    }

    this.previewTrack = track;
    if (!track) return;

    track.point.pixelSize = SELECTED_PIXELS;
    track.point.color = this.toColor(this.theme.accent);

    const collection = new cesium.PolylineCollection();
    const positions: import("cesium").Cartesian3[] = [];
    for (let i = 0; i < track.count; i += 1) {
      positions.push(
        new cesium.Cartesian3(
          track.points[i * 3] * 1000,
          track.points[i * 3 + 1] * 1000,
          track.points[i * 3 + 2] * 1000,
        ),
      );
    }
    collection.add({
      positions,
      width: 1.5,
      loop: true,
      material: this.material(this.theme.accent, 0.55),
    });
    this.preview = viewer.scene.primitives.add(collection);
  }

  /** A dot's resting colour: the shell ramp, or the palette fallback. */
  private shellColour(shell: string): import("cesium").Color {
    return this.cesium.Color.fromCssColorString(
      this.shells.get(shell) ?? cssColour(this.theme.primary),
    );
  }

  /** A constant-colour material from one of our numeric scene colours. */
  private material(value: number, alpha: number): import("cesium").Material {
    return new this.cesium.Material({
      fabric: { type: "Color", uniforms: { color: this.toColor(value, alpha) } },
    });
  }

  /** Resolve a track's instantaneous geography from the buffer the animation uses. */
  private describe(track: Track): SatelliteInfo {
    const { cesium } = this;
    const cartographic = cesium.Cartographic.fromCartesian(track.point.position);
    return {
      norad: track.norad,
      name: track.name,
      shell: track.shell,
      latitude: cesium.Math.toDegrees(cartographic.latitude),
      longitude: cesium.Math.toDegrees(cartographic.longitude),
      altitudeKm: cartographic.height / 1000,
    };
  }

  /** Remove the constellation primitive and forget its members. */
  private clearConstellation(): void {
    this.locked = null;
    this.hovered = null;
    this.previewTrack = null;
    this.preview = null;
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
    const colours = new Map<string, import("cesium").Color>();
    for (const track of this.tracks) {
      // The previewed dot is repainted below; the shell ramp would flatten it.
      if (track === this.previewTrack) continue;
      let colour = colours.get(track.shell);
      if (!colour) {
        colour = this.shellColour(track.shell);
        colours.set(track.shell, colour);
      }
      track.point.color = colour;
    }

    if (this.previewTrack && this.preview) {
      this.previewTrack.point.color = this.toColor(theme.accent);
      const accent = this.material(theme.accent, 0.55);
      for (let i = 0; i < this.preview.length; i += 1) {
        this.preview.get(i).material = accent;
      }
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
    if (this.pickHandler) {
      this.pickHandler.destroy();
      this.pickHandler = null;
    }
    this.preview = null;
    this.previewTrack = null;
    this.locked = null;
    this.hovered = null;
    this.tracks.length = 0;
    this.points = null;
    this.grid = null;
    // `viewer.isDestroyed()` cannot guard this call: Cesium implements it as
    // `return false;`, so it always reports the widget as alive and a second
    // destroy() throws `DeveloperError: This object was destroyed`. React runs
    // the effect cleanup on unmount and again under StrictMode, so calling this
    // twice is the normal path, not an edge case. `viewerDestroyed` is the real
    // guard; the catch covers a destroy that throws part-way and must not abandon
    // the rest of the cleanup.
    if (!this.viewerDestroyed) {
      this.viewerDestroyed = true;
      try {
        this.viewer.destroy();
      } catch {
        // A partially constructed viewer can throw mid-destroy. It is unusable
        // either way, and the canvas it owned is already detached.
      }
    }
  }
}
