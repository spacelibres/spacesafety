/**
 * Spherical geography for the globe view.
 *
 * The scene and the map must agree on one convention or the continents appear
 * mirrored or rotated. The convention here is ECEF: +Z is the north pole, +X
 * is longitude 0 (Greenwich), +Y is longitude 90°E. That is the same frame the
 * OCM trajectories arrive in (`TRAJ_REF_FRAME = ITRF2000`), verified against
 * the data: a sample at (0, 0, 7000) km reports latitude 90°.
 *
 * Angles are degrees at the boundary and radians internally, which is the order
 * GeoJSON and Natural Earth use.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Unit vector for a geographic position (ECEF, unit sphere). */
export function latLonToUnit(lat: number, lon: number): [number, number, number] {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const cosPhi = Math.cos(phi);
  return [cosPhi * Math.cos(lambda), cosPhi * Math.sin(lambda), Math.sin(phi)];
}

/** Position on a sphere of `radius`, in [x, y, z]. */
export function latLonToXYZ(lat: number, lon: number, radius: number): [number, number, number] {
  const [x, y, z] = latLonToUnit(lat, lon);
  return [x * radius, y * radius, z * radius];
}

/** Geographic position of a point on the sphere (inverse of `latLonToUnit`). */
export function unitToLatLon(x: number, y: number, z: number): LatLon {
  const r = Math.hypot(x, y, z);
  if (r === 0) return { lat: 0, lon: 0 };
  const lat = Math.asin(clamp(z / r, -1, 1)) * RAD;
  const lon = Math.atan2(y, x) * RAD;
  return { lat, lon };
}

/** Wrap a longitude into [-180, 180). */
export function wrapLongitude(lon: number): number {
  let value = lon;
  while (value >= 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

/**
 * Format a coordinate the way cartographic software does.
 *
 * Degrees, minutes and seconds with hemisphere letters; the notation is
 * language-neutral, so it is not routed through the dictionary.
 */
export function formatLatLon(lat: number, lon: number, decimals = 2): string {
  return `${formatLat(lat, decimals)} ${formatLon(lon, decimals)}`;
}

export function formatLat(lat: number, decimals = 2): string {
  const hemisphere = lat >= 0 ? "N" : "S";
  return `${Math.abs(lat).toFixed(decimals)}° ${hemisphere}`;
}

export function formatLon(lon: number, decimals = 2): string {
  const wrapped = wrapLongitude(lon);
  const hemisphere = wrapped >= 0 ? "E" : "W";
  return `${Math.abs(wrapped).toFixed(decimals)}° ${hemisphere}`;
}

/** Great-circle distance in degrees between two geographic points. */
export function angularDistance(a: LatLon, b: LatLon): number {
  const [ax, ay, az] = latLonToUnit(a.lat, a.lon);
  const [bx, by, bz] = latLonToUnit(b.lat, b.lon);
  const dot = clamp(ax * bx + ay * by + az * bz, -1, 1);
  return Math.acos(dot) * RAD;
}

/**
 * Is the point facing the camera?
 *
 * Labels are declarative text, and drawing them through the globe would make
 * the map unreadable. The dot product against the camera direction says which
 * hemisphere is visible.
 */
export function isFacing(
  point: LatLon,
  cameraDirection: readonly [number, number, number],
): boolean {
  const [x, y, z] = latLonToUnit(point.lat, point.lon);
  return x * cameraDirection[0] + y * cameraDirection[1] + z * cameraDirection[2] > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
