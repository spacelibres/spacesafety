/**
 * Sun, Moon and star field for the orbital view.
 *
 * ## Real positions, not decoration
 *
 * A sun pinned at a fixed screen corner would light the Earth from a direction
 * that contradicts the satellite tracks' geometry. Both bodies are therefore
 * placed from low-precision analytical ephemerides (Meeus, *Astronomical
 * Algorithms*): the Sun to ~0.01°, the Moon to ~0.3°. That is far better than
 * the drawing needs and costs a few dozen trigonometric operations per frame
 * update, not per frame.
 *
 * Coordinates are geocentric equatorial (same frame as the tracks), scaled to
 * the scene's Earth radius so the angular size stays believable.
 */

import * as THREE from "three";

const DEG = Math.PI / 180;

/** Earth radius in km, the unit the scene's radius 1 represents. */
const EARTH_RADIUS_KM = 6378.137;
/** Distance to the Sun: mean 1 au. */
const AU_KM = 149_597_870.7;
/** Mean lunar distance. */
const MOON_KM = 384_400;

export interface DirectionalPosition {
  /** Unit vector from Earth's centre, in the scene's ECEF-like frame. */
  direction: [number, number, number];
  /** Distance from Earth's centre, in Earth radii. */
  distanceEarthRadii: number;
}

/**
 * Geocentric direction of the Sun at `date`.
 *
 * Apparent ecliptic longitude from the low-precision solar theory, converted to
 * equatorial coordinates with the mean obliquity. Refraction and nutation are
 * ignored — they are ~0.005°, two orders of magnitude below what the drawing
 * can show.
 */
export function sunDirection(date: Date): DirectionalPosition {
  const jd = julianDay(date);
  const n = jd - 2_451_545.0;
  const meanLongitude = (280.46 + 0.9856474 * n) % 360;
  const meanAnomaly = (357.528 + 0.9856003 * n) % 360;

  const lambda =
    meanLongitude +
    1.915 * Math.sin(meanAnomaly * DEG) +
    0.02 * Math.sin(2 * meanAnomaly * DEG);
  const epsilon = 23.439 - 0.0000004 * n;

  const lambdaRad = lambda * DEG;
  const epsilonRad = epsilon * DEG;
  const x = Math.cos(lambdaRad);
  const y = Math.cos(epsilonRad) * Math.sin(lambdaRad);
  const z = Math.sin(epsilonRad) * Math.sin(lambdaRad);

  return { direction: [x, y, z], distanceEarthRadii: AU_KM / EARTH_RADIUS_KM };
}

/**
 * Geocentric direction of the Moon at `date`.
 *
 * Meeus chapter 47, truncated to the largest terms: the longitude error stays
 * under ~0.5°, which is a few pixels at any usable zoom.
 */
export function moonDirection(date: Date): DirectionalPosition {
  const jd = julianDay(date);
  const t = (jd - 2_451_545.0) / 36_525;

  const L = 218.316 + 13.176396 * (jd - 2_451_545.0); // mean longitude
  const M = 134.963 + 13.064993 * (jd - 2_451_545.0); // mean anomaly
  const F = 93.272 + 13.229350 * (jd - 2_451_545.0); // argument of latitude

  const lambda = (L + 6.289 * Math.sin(M * DEG)) * DEG;
  const beta = 5.128 * Math.sin(F * DEG) * DEG;
  const epsilon = (23.439 - 0.013 * t) * DEG;

  // Ecliptic -> equatorial.
  const x = Math.cos(beta) * Math.cos(lambda);
  const y = Math.cos(epsilon) * Math.cos(beta) * Math.sin(lambda) - Math.sin(epsilon) * Math.sin(beta);
  const z = Math.sin(epsilon) * Math.cos(beta) * Math.sin(lambda) + Math.cos(epsilon) * Math.sin(beta);
  const length = Math.hypot(x, y, z);

  return { direction: [x / length, y / length, z / length], distanceEarthRadii: MOON_KM / EARTH_RADIUS_KM };
}

function julianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

export interface CelestialOptions {
  /** Scene radius of the Earth (1 in this app). */
  earthRadius: number;
  palette: {
    sun: number;
    moon: number;
    star: number;
    /** Corona / glow tint. */
    glow: number;
  };
  /** Compress real distances so the bodies fit the camera's far plane. */
  sunDistance: number;
  moonDistance: number;
}

export interface CelestialBodies {
  group: THREE.Group;
  /** Light source whose direction matches the drawn Sun. */
  sunLight: THREE.DirectionalLight;
  /** Move both bodies to `date`. */
  update: (date: Date) => void;
  dispose: () => void;
}

/**
 * Build the Sun, the Moon, the lights they imply, and a star field.
 *
 * The Sun is drawn as an emissive disc with a soft corona rather than a point
 * light alone, because an unexplained bright point reads as a rendering
 * artefact; the visible disc is what tells the reader "this is the light
 * source".
 */
export function buildCelestial(options: CelestialOptions): CelestialBodies {
  const { earthRadius, palette, sunDistance, moonDistance } = options;
  const group = new THREE.Group();
  const disposables: Array<{ dispose: () => void }> = [];

  // --- sun ------------------------------------------------------------------
  const sunGroup = new THREE.Group();
  const sunRadius = earthRadius * 0.2;

  const sunGeometry = new THREE.SphereGeometry(sunRadius, 24, 24);
  const sunMaterial = new THREE.MeshBasicMaterial({ color: palette.sun });
  disposables.push(sunGeometry, sunMaterial);
  sunGroup.add(new THREE.Mesh(sunGeometry, sunMaterial));

  // Corona: additive, so it reads as light rather than a solid ring.
  const coronaGeometry = new THREE.SphereGeometry(sunRadius * 1.6, 24, 24);
  const coronaMaterial = new THREE.MeshBasicMaterial({
    color: palette.glow,
    transparent: true,
    opacity: 0.28,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
  });
  disposables.push(coronaGeometry, coronaMaterial);
  sunGroup.add(new THREE.Mesh(coronaGeometry, coronaMaterial));
  group.add(sunGroup);

  // --- moon -----------------------------------------------------------------
  const moonGroup = new THREE.Group();
  const moonRadius = earthRadius * 0.13;
  const moonGeometry = new THREE.SphereGeometry(moonRadius, 24, 24);
  const moonMaterial = new THREE.MeshBasicMaterial({ color: palette.moon });
  disposables.push(moonGeometry, moonMaterial);
  moonGroup.add(new THREE.Mesh(moonGeometry, moonMaterial));
  group.add(moonGroup);

  // --- light ----------------------------------------------------------------
  const sunLight = new THREE.DirectionalLight(palette.sun, 2.1);
  group.add(sunLight);

  // --- stars ----------------------------------------------------------------
  const starGeometry = new THREE.BufferGeometry();
  const STAR_COUNT = 1800;
  const starPositions = new Float32Array(STAR_COUNT * 3);
  const starSizes = new Float32Array(STAR_COUNT);
  // Deterministic scatter: a random field that changes on every mount looks like
  // flicker when the component remounts.
  let seed = 0x2f6e2b1;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < STAR_COUNT; i += 1) {
    // Uniform on a sphere.
    const u = random() * 2 - 1;
    const theta = random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    const radius = earthRadius * 60;
    starPositions[i * 3] = radius * r * Math.cos(theta);
    starPositions[i * 3 + 1] = radius * r * Math.sin(theta);
    starPositions[i * 3 + 2] = radius * u;
    starSizes[i] = 0.02 + random() * 0.05;
  }
  starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
  const starMaterial = new THREE.PointsMaterial({
    color: palette.star,
    size: earthRadius * 0.012,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.85,
  });
  disposables.push(starGeometry, starMaterial);
  group.add(new THREE.Points(starGeometry, starMaterial));

  const update = (date: Date) => {
    const sun = sunDirection(date);
    const moon = moonDirection(date);

    sunGroup.position.set(
      sun.direction[0] * sunDistance,
      sun.direction[1] * sunDistance,
      sun.direction[2] * sunDistance,
    );
    // The light follows the Sun, so the lit side of the globe matches where the
    // Sun is drawn — the whole reason for computing the real direction.
    sunLight.position.copy(sunGroup.position);
    sunLight.target.position.set(0, 0, 0);
    sunLight.target.updateMatrixWorld();

    moonGroup.position.set(
      moon.direction[0] * moonDistance,
      moon.direction[1] * moonDistance,
      moon.direction[2] * moonDistance,
    );
  };

  return {
    group,
    sunLight,
    update,
    dispose: () => {
      for (const item of disposables) item.dispose();
    },
  };
}
