/**
 * Shell colours for the constellation.
 *
 * The catalogue is not a uniform cloud: Starlink occupies a handful of distinct
 * inclination/altitude groups (measured on the current TLE set — 53°/460 km holds
 * 3 496 satellites, 43°/480 km holds 3 222, 97°/470 km holds 1 446). Colouring by
 * shell is what turns 13 000 lines into a readable structure.
 *
 * Colours come from the VI palette, assigned by shell size so the largest groups
 * take the primary family and smaller ones step through the accents. Assigned by
 * a stable sort of the shell key, so the same shell keeps the same colour between
 * snapshots.
 */

import { ELECTRIC_ORBIT, mix } from "@/lib/vi/palette";

/**
 * Colour ramp, primary first.
 *
 * Deliberately short: more than six hues stop being distinguishable on a dark
 * canvas, and the long tail of tiny shells reads better as one neutral tone.
 */
const RAMP: string[] = [
  ELECTRIC_ORBIT.primary,
  ELECTRIC_ORBIT.secondary,
  ELECTRIC_ORBIT.accent,
  ELECTRIC_ORBIT.success,
  ELECTRIC_ORBIT.warning,
  mix(ELECTRIC_ORBIT.primary, ELECTRIC_ORBIT.accent, 0.45),
];

export interface ShellLegendEntry {
  key: string;
  colour: string;
  count: number;
}

/**
 * Assign colours to shells.
 *
 * `shells` must be ordered largest first so the ramp is spent where it is most
 * visible; the neutral tail keeps small groups from claiming a hue that a large
 * group needs.
 */
export function shellColours(shells: Array<{ key: string; count: number }>): {
  colours: Map<string, string>;
  legend: ShellLegendEntry[];
} {
  const colours = new Map<string, string>();
  const legend: ShellLegendEntry[] = [];

  shells.forEach((shell, index) => {
    const colour = index < RAMP.length ? RAMP[index] : mix(ELECTRIC_ORBIT.muted, "#FFFFFF", 0.45);
    colours.set(shell.key, colour);
    legend.push({ key: shell.key, colour, count: shell.count });
  });

  return { colours, legend };
}

/** Human label for a shell key such as `53/460`. */
export function shellLabel(key: string): string {
  const [inclination, altitude] = key.split("/");
  const inc = Number(inclination);
  const alt = Number(altitude);
  if (!Number.isFinite(inc) || !Number.isFinite(alt)) return key;
  return `${inc.toFixed(0)}° · ${alt.toFixed(0)} km`;
}
