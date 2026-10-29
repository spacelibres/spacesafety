/**
 * Global constellation snapshot — the data behind a full-catalogue 3D view.
 *
 * ## Why this is pre-computed
 *
 * Rendering every satellite needs every track. Parsing one OCM costs ~123 ms and
 * the catalogue holds 11 162 of them, so building this on demand is 27 minutes of
 * CPU per request. It is also *static data*: an operator ephemeris is a fixed
 * arc, so the geometry only changes when a new upload lands.
 *
 * So the snapshot is built offline (`npm run build:snapshot`), written once, and
 * served as a static file. The browser fetches it like any other asset, which
 * also lets it be cached by the CDN in front of the VPS.
 *
 * ## Encoding
 *
 * 11 162 tracks at 96 points is ~12.9 MB of `Float32` triples. Instead each track
 * stores its bounding box (floats) and its points as `Int16` normalised against
 * that box, which is 2 bytes per component: 7.3 MB raw, ~2.6 MB gzipped. The
 * quantisation error is at most one part in 32 767 of the box diagonal — a few
 * kilometres on a 1 000 km box, invisible at any zoom where the whole
 * constellation fits on screen.
 *
 * The file is a single JSON envelope with `Float32Array`/`Int16Array` payloads
 * base64-encoded, written by the builder and decoded by `decodeSnapshot`. That
 * keeps it one HTTP request with no format negotiation.
 */

/** One track in the packed snapshot. */
export interface PackedTrack {
  /** Object id, stable across snapshots. */
  id: string;
  /** Display name, e.g. `STARLINK-1008`. */
  name: string;
  /** NORAD catalogue number, when known. */
  norad: string;
  /** Orbit shell label for colouring, e.g. `53.0/550`. */
  shell: string;
  /** Epoch of the first sample, ms. */
  t0: number;
  /** Epoch of the last sample, ms. */
  t1: number;
  /** Bounding box min corner, km, inertial. */
  min: [number, number, number];
  /** Bounding box size, km. */
  size: [number, number, number];
  /** `points * 3` normalised coordinates, Int16. */
  q: Int16Array;
}

export interface SnapshotMeta {
  /** ISO timestamp the snapshot was built. */
  builtAt: string;
  /** Number of tracks in the payload. */
  count: number;
  /** Points per track. */
  pointsPerTrack: number;
  /** Source catalogue generation, for cache busting. */
  generation: string;
}

export interface SnapshotFile {
  meta: SnapshotMeta;
  tracks: Array<{
    id: string;
    name: string;
    norad: string;
    shell: string;
    t0: number;
    t1: number;
    min: [number, number, number];
    size: [number, number, number];
    /** base64 of the Int16Array buffer. */
    q: string;
  }>;
}

/** Encode one track's points into the quantised form. */
export function quantise(points: Array<[number, number, number]>): {
  min: [number, number, number];
  size: [number, number, number];
  q: Int16Array;
} {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  // A degenerate axis (all points equal) would divide by zero; give it unit size.
  const size: [number, number, number] = [
    Math.max(maxX - minX, 1e-6),
    Math.max(maxY - minY, 1e-6),
    Math.max(maxZ - minZ, 1e-6),
  ];
  const min: [number, number, number] = [minX, minY, minZ];
  const q = new Int16Array(points.length * 3);
  for (let i = 0; i < points.length; i += 1) {
    const [x, y, z] = points[i];
    q[i * 3] = Math.round(((x - minX) / size[0]) * 32767) - 32767;
    q[i * 3 + 1] = Math.round(((y - minY) / size[1]) * 32767) - 32767;
    q[i * 3 + 2] = Math.round(((z - minZ) / size[2]) * 32767) - 32767;
  }
  return { min, size, q };
}

/** Decode a file entry back to full-precision km triples. */
export function dequantise(entry: SnapshotFile["tracks"][number]): Float32Array {
  const binary = atob(entry.q);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const q = new Int16Array(bytes.buffer);
  const out = new Float32Array(q.length);
  const [minX, minY, minZ] = entry.min;
  const [sx, sy, sz] = entry.size;
  for (let i = 0; i < q.length; i += 3) {
    out[i] = minX + ((q[i] + 32767) / 32767) * sx;
    out[i + 1] = minY + ((q[i + 1] + 32767) / 32767) * sy;
    out[i + 2] = minZ + ((q[i + 2] + 32767) / 32767) * sz;
  }
  return out;
}

/** Base64 of an Int16Array's bytes, for writing into the JSON envelope. */
export function encodeQuantised(q: Int16Array): string {
  const bytes = new Uint8Array(q.buffer, q.byteOffset, q.byteLength);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
