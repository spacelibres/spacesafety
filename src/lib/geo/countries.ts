/**
 * Country outlines and names for the globe.
 *
 * Data: Natural Earth 1:110m admin-0 (public domain), fetched into
 * `public/geo/countries-110m.geojson` by `npm run fetch:geo`. It carries the
 * country name in ~40 languages, which is why the map needs no hand-written
 * translation table: the same six locales the UI uses are already columns.
 *
 * ## Why lat/lon and not scene coordinates here
 *
 * Everything in this module is geography (degrees). Converting to the Three.js
 * scene is the caller's job, because the scene has its own radius and axis
 * convention; mixing the two is how a map ends up mirrored.
 */

export interface CountryFeature {
  /** ISO 3166-1 alpha-2, e.g. `CN`. Stable identifier across languages. */
  iso2: string;
  iso3: string;
  /** Names keyed by our locale ids, falling back to English. */
  names: Partial<Record<string, string>>;
  /** Outer rings and holes, as [lon, lat] pairs. */
  rings: number[][][];
  /** Label anchor: [lon, lat] of the largest ring's centroid. */
  label: [number, number];
}

interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

interface GeoJsonFeature {
  properties: Record<string, string | number | null>;
  geometry: GeoJsonGeometry | null;
}

/** Natural Earth name column for each of our locales. */
const NAME_COLUMNS: Record<string, string> = {
  "zh-CN": "NAME_ZH",
  en: "NAME_EN",
  es: "NAME_ES",
  fr: "NAME_FR",
  de: "NAME_DE",
  ja: "NAME_JA",
};

/** Parse a GeoJSON FeatureCollection into the shape the renderer wants. */
export function parseCountries(collection: { features: GeoJsonFeature[] }): CountryFeature[] {
  const out: CountryFeature[] = [];

  for (const feature of collection.features) {
    const geometry = feature.geometry;
    if (!geometry) continue;

    const rings = polygonRings(geometry);
    if (rings.length === 0) continue;

    const props = feature.properties;
    const iso2 = String(props.ISO_A2 ?? props.ISO_A2_EH ?? "").trim();
    const iso3 = String(props.ISO_A3 ?? props.ISO_A3_EH ?? "").trim();
    // `-99` is Natural Earth's "not assigned"; such territories would collide.
    const key =
      iso2 && iso2 !== "-99" ? iso2 : iso3 && iso3 !== "-99" ? iso3 : String(props.ADMIN ?? "");
    if (!key) continue;

    const names: Partial<Record<string, string>> = {};
    for (const [locale, column] of Object.entries(NAME_COLUMNS)) {
      const value = props[column];
      if (typeof value === "string" && value.trim()) names[locale] = value.trim();
    }
    const english = props.NAME_EN ?? props.ADMIN;
    if (!names.en && typeof english === "string") names.en = english;

    out.push({ iso2: key, iso3, names, rings, label: largestRingCentroid(rings) });
  }

  return out.sort((a, b) => a.iso2.localeCompare(b.iso2));
}

/** All rings of a Polygon or MultiPolygon, outer and holes alike. */
function polygonRings(geometry: GeoJsonGeometry): number[][][] {
  const rings: number[][][] = [];
  const push = (polygon: unknown) => {
    if (!Array.isArray(polygon)) return;
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 3) continue;
      const points = ring
        .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2)
        .map(([lon, lat]) => [Number(lon), Number(lat)]);
      if (points.length >= 3) rings.push(points);
    }
  };

  if (geometry.type === "Polygon") push(geometry.coordinates);
  else if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    for (const polygon of geometry.coordinates) push(polygon);
  }
  return rings;
}

/**
 * Centroid of the ring with the largest area, in lon/lat degrees.
 *
 * The largest ring is the mainland: using the whole multipolygon's centroid puts
 * labels in the sea for archipelagos and territories with far-flung islands
 * (France, Norway, the United States).
 */
function largestRingCentroid(rings: number[][][]): [number, number] {
  let best = rings[0];
  let bestArea = -Infinity;
  for (const ring of rings) {
    const area = Math.abs(ringArea(ring));
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  }
  return ringCentroid(best);
}

function ringArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [x1, y1] = ring[j];
    const [x2, y2] = ring[i];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function ringCentroid(ring: number[][]): [number, number] {
  let cx = 0;
  let cy = 0;
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [x1, y1] = ring[j];
    const [x2, y2] = ring[i];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  area /= 2;
  // A degenerate ring (collinear points) has no centroid; average instead.
  if (Math.abs(area) < 1e-9) {
    const n = ring.length || 1;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (6 * area), cy / (6 * area)];
}

/** Country name in `locale`, falling back to English then the ISO code. */
export function countryName(country: CountryFeature, locale: string): string {
  return country.names[locale] ?? country.names.en ?? country.iso2;
}
