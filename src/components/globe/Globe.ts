/**
 * The globe: a transparent sphere with an accurate graticule, country borders
 * and country label anchors.
 *
 * ## Why not a textured Earth
 *
 * A photographic Earth hides the thing the product is about. An operator is
 * looking for *where two orbits pass close*; a lit continent map competes with
 * the tracks for attention. A transparent shell with a thin graticule and
 * hairline borders gives the geographic reference without fighting the data —
 * and needs no imagery licence, which keeps the app deployable.
 *
 * ## Accuracy
 *
 * The graticule is drawn on the sphere at fixed 15° intervals, and borders are
 * Natural Earth rings projected with the same `latLonToXYZ` the pointer readout
 * uses. So a longitude read off the grid and the longitude under the cursor
 * cannot disagree.
 */

import * as THREE from "three";

import { countryName, type CountryFeature } from "@/lib/geo/countries";
import { latLonToXYZ } from "@/lib/geo/sphere";
import type { ScenePalette } from "@/lib/vi/scene";

/** Spacing of the graticule, degrees. */
export const GRATICULE_STEP_DEG = 15;

export interface GlobeOptions {
  radius: number;
  palette: ScenePalette;
  countries: CountryFeature[];
  locale: string;
}

export interface GlobeLabel {
  iso2: string;
  name: string;
  /** Scene-space anchor, slightly above the surface so it clears the borders. */
  position: THREE.Vector3;
}

export interface GlobeParts {
  group: THREE.Group;
  labels: GlobeLabel[];
  /** Dispose everything created here; three.js does not free GPU buffers on its
   *  own, so a viewer remount would leak one buffer per mesh. */
  dispose: () => void;
}

type Disposable = { dispose: () => void };

/** Build the globe as one removable group. */
export function buildGlobe(options: GlobeOptions): GlobeParts {
  const { radius, palette, countries, locale } = options;
  const group = new THREE.Group();
  const disposables: Disposable[] = [];

  // --- shell ------------------------------------------------------------------
  // A faint transparent shell, not an opaque ball: orbits on the far side must
  // stay visible, which is the point of the transparent treatment.
  const shellGeometry = new THREE.SphereGeometry(radius, 64, 48);
  const shellMaterial = new THREE.MeshBasicMaterial({
    color: palette.globe,
    transparent: true,
    opacity: 0.4,
    // Front faces only: a double-sided transparent sphere double-blends where
    // the far hemisphere overlaps the near one and turns muddy.
    side: THREE.FrontSide,
    depthWrite: false,
  });
  disposables.push(shellGeometry, shellMaterial);
  group.add(new THREE.Mesh(shellGeometry, shellMaterial));

  group.add(buildGraticule(radius * 1.0009, palette, disposables));
  group.add(buildBorders(radius * 1.0015, countries, palette, disposables));

  const labels: GlobeLabel[] = countries.map((country) => ({
    iso2: country.iso2,
    name: countryName(country, locale),
    position: new THREE.Vector3(...latLonToXYZ(country.label[1], country.label[0], radius * 1.004)),
  }));

  return {
    group,
    labels,
    dispose: () => {
      for (const item of disposables) item.dispose();
    },
  };
}

/** Meridians and parallels every 15°, with the equator and prime meridian heavier. */
function buildGraticule(
  radius: number,
  palette: ScenePalette,
  disposables: Disposable[],
): THREE.Group {
  const group = new THREE.Group();
  const SEGMENTS = 180;

  const line = (points: number[], color: number, opacity: number): THREE.Line => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    disposables.push(geometry, material);
    return new THREE.Line(geometry, material);
  };

  for (let lat = -90 + GRATICULE_STEP_DEG; lat < 90; lat += GRATICULE_STEP_DEG) {
    if (lat === 0) continue;
    const points: number[] = [];
    for (let i = 0; i <= SEGMENTS; i += 1) {
      points.push(...latLonToXYZ(lat, -180 + (360 * i) / SEGMENTS, radius));
    }
    group.add(line(points, palette.graticule, 0.2));
  }

  for (let lon = -180; lon < 180; lon += GRATICULE_STEP_DEG) {
    const points: number[] = [];
    for (let i = 0; i <= SEGMENTS / 2; i += 1) {
      points.push(...latLonToXYZ(-90 + (180 * i) / (SEGMENTS / 2), lon, radius));
    }
    group.add(line(points, palette.graticule, 0.2));
  }

  const equator: number[] = [];
  for (let i = 0; i <= SEGMENTS; i += 1) {
    equator.push(...latLonToXYZ(0, -180 + (360 * i) / SEGMENTS, radius));
  }
  group.add(line(equator, palette.equator, 0.48));

  const prime: number[] = [];
  for (let i = 0; i <= SEGMENTS / 2; i += 1) {
    prime.push(...latLonToXYZ(-90 + (180 * i) / (SEGMENTS / 2), 0, radius));
  }
  group.add(line(prime, palette.equator, 0.48));

  return group;
}

/** Country outlines as line segments, in a single draw call. */
function buildBorders(
  radius: number,
  countries: CountryFeature[],
  palette: ScenePalette,
  disposables: Disposable[],
): THREE.LineSegments {
  const positions: number[] = [];

  for (const country of countries) {
    for (const ring of country.rings) {
      for (let i = 0; i < ring.length - 1; i += 1) {
        const [lon1, lat1] = ring[i];
        const [lon2, lat2] = ring[i + 1];
        // Skip segments that cross the antimeridian: a straight line between
        // them would cut across the whole globe.
        if (Math.abs(lon2 - lon1) > 180) continue;
        positions.push(...latLonToXYZ(lat1, lon1, radius));
        positions.push(...latLonToXYZ(lat2, lon2, radius));
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: palette.borderStrong,
    transparent: true,
    opacity: 0.5,
  });
  disposables.push(geometry, material);
  return new THREE.LineSegments(geometry, material);
}
