/**
 * The VI's palette engine — a faithful port of `vi.spacelibre.cn/app.js` (VI 1.5.34).
 *
 * ## Why a port instead of a table of presets
 *
 * The manual's Color Explorer says: *"只选主色，自动生成完整的全站色系"* and
 * *"六套方案控制整个网页 … 标志轮廓保持已确认的几何结构"*. So the six presets are
 * **seeds** — a primary hue plus a harmony relation — and the other fourteen roles
 * are computed from them. Hard-coding sixteen colours per preset would reproduce
 * today's six and could never accept a seventh primary, which is the whole point
 * of the explorer.
 *
 * ## How this was verified
 *
 * The functions below are line-for-line the manual's: `hexToHsl`, `hslToHex`,
 * `mixHex`, `contrast`, `fitContrast`, and `generatePalette`'s harmony selection.
 * Two conventions differ from the rest of this codebase and are preserved on
 * purpose:
 *
 *   - `mixHex(a, b, weight)` weights **`a`**, whereas `palette.mix(a, b, w)`
 *     weights `b`. Swapping them silently shifts every derived surface.
 *   - `fitContrast` moves *lightness* in `hsl` (not toward white/black), which is
 *     why its results differ slightly from `palette.legibleOn`.
 *
 * `tests/vi-tokens.test.ts` replays the engine against all six official presets
 * and asserts **96 of 96 roles** match `design/vi-source/palette-tokens.json`.
 * If the manual's algorithm is ever mis-transcribed, that test fails.
 */

export type HarmonyMode = "auto" | "split" | "triad" | "analogous";

/** HSL with `h` in degrees, `s` and `l` in percent. */
export type Hsl = [number, number, number];

const BYTE = /[a-f\d]{2}/gi;

function bytes(hex: string): number[] {
  return (hex.match(BYTE) ?? []).map((x) => parseInt(x, 16));
}

export function hexToHsl(hex: string): Hsl {
  const [r, g, b] = bytes(hex).map((x) => x / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [(h + 360) % 360, s * 100, l * 100];
}

export function hslToHex(hue: number, s: number, l: number): string {
  const h = ((hue % 360) + 360) % 360;
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lig - c / 2;
  const rgb =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  return `#${rgb
    .map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

/** Blend with `weight` as the share of `a` — the manual's convention, not ours. */
export function mixHex(a: string, b: string, weight: number): string {
  const av = bytes(a);
  const bv = bytes(b);
  return `#${av
    .map((v, i) => Math.round(v * weight + bv[i] * (1 - weight)).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = bytes(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Move a colour along its own lightness axis until it clears `min` contrast.
 *
 * `direction` says which way to move: `dark` lightens a colour for use on a light
 * background by *lowering* lightness, `light` does the opposite. This is the
 * manual's helper; `palette.legibleOn` is a different function with a different
 * job (blending toward white or ink), and the two must not be swapped.
 */
export function fitContrast(
  hex: string,
  background: string,
  min = 4.5,
  direction: "dark" | "light" = "dark",
): string {
  if (contrastRatio(hex, background) >= min) return hex.toUpperCase();
  const [h, s, l] = hexToHsl(hex);
  for (let step = 1; step <= 100; step += 1) {
    const next = direction === "dark" ? Math.max(0, l - step) : Math.min(100, l + step);
    const candidate = hslToHex(h, s, next);
    if (contrastRatio(candidate, background) >= min) return candidate;
  }
  return direction === "dark" ? "#000000" : "#FFFFFF";
}

/** The sixteen roles the VI publishes for every scheme. */
export interface DerivedPalette {
  primary: string;
  secondary: string;
  accent: string;
  deep: string;
  surface: string;
  ink: string;
  card: string;
  muted: string;
  line: string;
  success: string;
  warning: string;
  danger: string;
  primaryOnLight: string;
  primaryOnDark: string;
  planetOnLight: string;
  planetOnDark: string;
}

/**
 * Resolve `auto` into one of the three relations.
 *
 * The manual's rule: a near-grey primary takes the analogous relation (there is no
 * hue to split), a very light one splits, a cyan-to-violet hue triads, and warm
 * hues split while everything else goes analogous.
 */
export function resolveHarmony(primary: string, mode: HarmonyMode): Exclude<HarmonyMode, "auto"> {
  if (mode !== "auto") return mode;
  const [h, s, l] = hexToHsl(primary);
  if (s < 12) return "analogous";
  if (l > 68) return "split";
  if (h >= 180 && h <= 285) return "triad";
  if (h < 65 || h > 325) return "split";
  return "analogous";
}

/**
 * Generate all sixteen roles from one primary colour and one harmony relation.
 *
 * A near-grey primary is treated as hue 215 before any role is computed, so the
 * derived scheme is still chromatic — the manual does the same.
 */
export function derivePalette(primaryHex: string, mode: HarmonyMode = "auto"): DerivedPalette {
  const hex = primaryHex.toUpperCase();
  const [originalH, s, l] = hexToHsl(hex);
  const h = s < 12 ? 215 : originalH;
  const resolved = resolveHarmony(hex, mode);
  const offsets = resolved === "triad" ? [120, 240] : resolved === "analogous" ? [35, -35] : [150, 210];

  const palette: DerivedPalette = {
    primary: hex,
    secondary: hslToHex(h + offsets[0], Math.max(s, 78), 60),
    accent: hslToHex(h + offsets[1], 90, 68),
    deep: hslToHex(h, 44, 9),
    surface: hslToHex(h, 40, 96),
    ink: hslToHex(h, 58, 17),
    card: "",
    muted: "",
    line: "",
    success: "",
    warning: "",
    danger: "",
    primaryOnLight: "",
    primaryOnDark: "",
    planetOnLight: "",
    planetOnDark: "",
  };

  palette.card = mixHex(palette.surface, "#FFFFFF", 0.2);
  palette.muted = fitContrast(mixHex(palette.ink, palette.surface, 0.6), palette.surface);
  palette.line = mixHex(palette.ink, palette.surface, 0.18);
  // The three status roles keep fixed semantic hues, nudged by the scheme's own
  // hue so they sit inside it without drifting off-meaning.
  palette.success = fitContrast(hslToHex(150 + (h % 18), 65, 38), palette.surface, 5.5);
  palette.warning = fitContrast(hslToHex(38 + (h % 10), 85, 42), palette.surface, 5.5);
  palette.danger = fitContrast(hslToHex(350 + (h % 15), 75, 45), palette.surface, 5.5);
  palette.primaryOnLight = fitContrast(palette.primary, palette.surface, 4.5, "dark");
  palette.primaryOnDark = fitContrast(palette.primary, palette.deep, 4.5, "light");
  palette.planetOnLight = fitContrast(palette.secondary, palette.surface, 4.5, "dark");
  palette.planetOnDark = fitContrast(palette.secondary, palette.deep, 4.5, "light");
  return palette;
}

/** The six schemes the manual ships, as seeds rather than as colour tables. */
export const VI_PRESETS = [
  { id: "01-electric-orbit", primary: "#007BFF", mode: "split" },
  { id: "02-aurora-jump", primary: "#12D6B0", mode: "triad" },
  { id: "03-nebula-spectrum", primary: "#A15AFF", mode: "analogous" },
  { id: "04-solar-storm", primary: "#FF6A3D", mode: "split" },
  { id: "05-deep-space-oasis", primary: "#15BDAD", mode: "split" },
  { id: "06-acid-future", primary: "#CBEA35", mode: "triad" },
] as const satisfies ReadonlyArray<{ id: string; primary: string; mode: Exclude<HarmonyMode, "auto"> }>;

export type PresetId = (typeof VI_PRESETS)[number]["id"];

export function presetById(id: string): (typeof VI_PRESETS)[number] | undefined {
  return VI_PRESETS.find((p) => p.id === id);
}
