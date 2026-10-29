/**
 * Work out each trajectory's orbital shell, cheaply.
 *
 * ## Why not just screen everything
 *
 * A full sweep of 11 162 objects is 62 million pairs at ~1.1 ms each, about 19
 * hours. Most of those pairs cannot possibly produce a conjunction: Starlink flies
 * distinct shells (53°, 70°, 97.3°), and two objects in shells that far apart
 * approach on crossing tracks at 3-12 km/s, never passing within the 51 km
 * screening box. Restricting screening to pairs whose shells *could* be close
 * removes that work without changing any answer — this is a partition, not an
 * approximation.
 *
 * ## How the shell is computed
 *
 * From the first state of the stored trajectory: the orbital-plane normal gives
 * the inclination, the radius gives the altitude. Both are read from the packed
 * buffer, so this costs one SQL read per object rather than a full parse.
 *
 * An OCM is published in ITRF2000, whose z-axis is the Earth's spin axis, so the
 * angle between the position-velocity plane and the equator is *already* the
 * inclination; no frame rotation is needed for the purpose of grouping. The
 * per-pair screen still runs in whatever frame the states are stored in, as it did
 * before — grouping only decides which pairs are worth screening at all.
 */

export interface Shell {
  inclinationDeg: number;
  altitudeKm: number;
}

/** A catalog entry with the shell it flies in. */
export interface ShelledEntry {
  objectId: string;
  trajectoryId: string;
  objectName: string;
  shell: Shell | null;
}

/**
 * Inclination and altitude from one state vector.
 *
 * `h = r x v` is normal to the orbital plane. Its angle to the +z axis is the
 * inclination, and `acos` is exact here because the vector is already normalised by
 * the magnitude.
 */
export function shellFromState(
  position: readonly [number, number, number],
  velocity: readonly [number, number, number],
  earthRadiusKm = 6378.137,
): Shell | null {
  const [rx, ry, rz] = position;
  const [vx, vy, vz] = velocity;
  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const h = Math.hypot(hx, hy, hz);
  const r = Math.hypot(rx, ry, rz);
  if (!(h > 0) || !(r > 0)) return null;

  const cosInc = Math.min(1, Math.max(-1, hz / h));
  return {
    inclinationDeg: (Math.acos(cosInc) * 180) / Math.PI,
    altitudeKm: r - earthRadiusKm,
  };
}

/**
 * Combined half-extent of the screening box in each direction, km.
 *
 * The box is R 2 / T 44 / N 51 (`screening-box.ts`). For choosing candidates the
 * largest of those is the one that can bridge a gap, so the pair test uses it.
 */
export const BOX_REACH_KM = 51;

/**
 * True when two shells could come within the screening box.
 *
 * Two orbits on inclined planes intersect only if the planes cross, and the
 * distance at a crossing is at minimum the difference in radius. So:
 *
 *   - differing altitudes by more than the box reach cannot meet, and
 *   - differing inclinations by more than a few degrees meet on a *crossing* at
 *     high relative velocity, but the radii still decide whether they are close
 *     enough to matter.
 *
 * The inclination term is deliberately generous: this decides which pairs to skip,
 * and a false negative (skipping a real conjunction) is far worse than screening a
 * few unnecessary pairs. Only clearly separated shells are pruned.
 */
export const ALTITUDE_TOLERANCE_KM = BOX_REACH_KM * 2;

/**
 * Largest inclination difference whose orbits can still pass within the box.
 *
 * Two inclined planes meet on a line, and at that crossing the separation of two
 * circular orbits of altitude `h` is `2h·sin(Δi/2)`. Setting that equal to the box
 * reach `B` gives `Δi = 2·asin(B / 2h)`: about 9.1° at h = 350 km, 6.7° at 470 km.
 *
 * The limit is evaluated per pair from the two altitudes rather than as a constant,
 * so a high shell is not pruned more generously than its geometry allows.
 *
 * This is exact for circular, coplanar-intersecting orbits. Starlink's eccentricity
 * is ~3e-4 (≈2 km), far below the box, so it does not change the conclusion. The
 * value is used with a safety factor below — a false negative here (skipping a real
 * conjunction) is far worse than screening some unnecessary pairs.
 */
export function maxInclinationGapDeg(altitudeA: number, altitudeB: number): number {
  const h = Math.max(100, Math.max(altitudeA, altitudeB));
  const ratio = Math.min(1, BOX_REACH_KM / (2 * h));
  return (2 * Math.asin(ratio) * 180) / Math.PI;
}

/** Safety factor applied to the geometric limit before pruning. */
export const INCLINATION_SAFETY = 1.5;

export function shellsMayMeet(a: Shell | null, b: Shell | null): boolean {
  // No shell information means screen the pair: never prune on missing data.
  if (!a || !b) return true;

  if (Math.abs(a.altitudeKm - b.altitudeKm) > ALTITUDE_TOLERANCE_KM) return false;

  const gap = Math.abs(a.inclinationDeg - b.inclinationDeg);
  const limit = maxInclinationGapDeg(a.altitudeKm, b.altitudeKm) * INCLINATION_SAFETY;
  return gap <= limit;
}

/**
 * Group entries into altitude bands, so the driver can iterate only plausible
 * partners instead of the full cross product.
 *
 * Returns a map from band index to the entries in it, plus the band width used.
 */
export function bandByAltitude(
  entries: ShelledEntry[],
  bandKm = ALTITUDE_TOLERANCE_KM,
): { bands: Map<number, ShelledEntry[]>; bandKm: number; unbanded: ShelledEntry[] } {
  const bands = new Map<number, ShelledEntry[]>();
  const unbanded: ShelledEntry[] = [];

  for (const entry of entries) {
    if (!entry.shell) {
      unbanded.push(entry);
      continue;
    }
    const key = Math.floor(entry.shell.altitudeKm / bandKm);
    const list = bands.get(key) ?? [];
    list.push(entry);
    bands.set(key, list);
  }

  return { bands, bandKm, unbanded };
}
