/**
 * The spacelibre VI palette, in code.
 *
 * Single source of truth for every colour the product emits: CSS variables,
 * the Three.js scene, SVG assets and the favicon all read from here. A colour
 * literal anywhere else is a defect — the VI requires that a theme change reach
 * the whole page, and a hex string buried in a component is the usual way that
 * promise is broken.
 *
 * Source: https://github.com/spacelibres/vi (preset `01-electric-orbit`).
 * The preset's `primary` (#007BFF) is kept exact and matches the canonical
 * `icon-primary.svg` orbit stroke.
 *
 * ## Roles, not names
 *
 * The VI defines 16 contextual roles. Components reference roles
 * (`--color-primary`, `--color-ink`); which hex a role resolves to is the
 * palette's business. `deep`/`surface`/`ink`/`card` describe the *surfaces* of
 * a theme, the rest are accents — that distinction is what lets the same
 * component tree render on a dark canvas and a light one without a second set
 * of class names.
 */

export interface ViPalette {
  /** Preset name in the VI repository. */
  readonly name: string;
  /** Harmony relationship the engine used to derive the accents. */
  readonly mode: "split" | "triad" | "analogous" | "split-complementary";

  readonly primary: string;
  readonly secondary: string;
  readonly accent: string;
  /** Darkest surface — page background of a dark theme. */
  readonly deep: string;
  /** Light surface — page background of a light theme. */
  readonly surface: string;
  /** Text colour on `surface`. */
  readonly ink: string;
  /** Card background. */
  readonly card: string;
  readonly muted: string;
  readonly line: string;
  readonly success: string;
  readonly warning: string;
  readonly danger: string;
  /** Primary shade for text/strokes on a light background (≥ 4.5:1). */
  readonly primaryOnLight: string;
  /** Primary shade for text/strokes on a dark background. */
  readonly primaryOnDark: string;
  /** The planet in a full-colour logo on a light background. */
  readonly planetOnLight: string;
  /** The planet in a full-colour logo on a dark background. */
  readonly planetOnDark: string;
}

/** 01-electric-orbit: the approved starting point for this product. */
export const ELECTRIC_ORBIT: ViPalette = {
  name: "01-electric-orbit",
  mode: "split",
  primary: "#007BFF",
  secondary: "#FF3733",
  accent: "#F4F764",
  deep: "#0D1721",
  surface: "#F1F5F9",
  ink: "#122A44",
  card: "#FCFDFE",
  muted: "#627180",
  line: "#C9D0D8",
  success: "#176E55",
  warning: "#845A0B",
  danger: "#C01C34",
  primaryOnLight: "#006CE0",
  primaryOnDark: "#007BFF",
  planetOnLight: "#E00400",
  planetOnDark: "#FF3733",
};

/** Surface roles: what a theme's backgrounds and body text resolve to. */
export interface ThemeSurfaces {
  readonly mode: "dark" | "light";
  readonly bg: string;
  readonly bgElev: string;
  readonly bgElev2: string;
  readonly card: string;
  readonly text: string;
  readonly textDim: string;
  readonly textFaint: string;
  readonly border: string;
  readonly borderStrong: string;
  /** Accent for links and interactive strokes on this surface. */
  readonly primary: string;
  /** Status roles raised to 4.5:1 against this surface's background. */
  readonly success: string;
  readonly warning: string;
  readonly danger: string;
}

/**
 * Derive a theme's surfaces from a palette.
 *
 * The VI fixes `deep` as the darkest surface and `surface` as the lightest, so
 * the two themes are the same palette read from opposite ends — not two separate
 * colour sets that can drift apart.
 */
export function themeSurfaces(palette: ViPalette, mode: "dark" | "light"): ThemeSurfaces {
  if (mode === "dark") {
    return {
      mode,
      bg: palette.deep,
      bgElev: mix(palette.deep, palette.primary, 0.06),
      bgElev2: mix(palette.deep, palette.primary, 0.1),
      card: mix(palette.deep, palette.primary, 0.04),
      text: mix(palette.deep, "#FFFFFF", 0.92),
      textDim: mix(palette.deep, "#FFFFFF", 0.6),
      // Faint is the smallest text in the UI (token labels, axis legends), so it
      // is body copy and must clear 4.5:1 — measured against the *card*, which is
      // lighter than the page background and therefore the harder target. The raw
      // 42% blend measured 4.06:1 on the background and 3.91:1 on cards, which is
      // below the VI's readability floor.
      textFaint: legibleOnSurfaces(mix(palette.deep, "#FFFFFF", 0.42), [
        mix(palette.deep, palette.primary, 0.04),
        palette.deep,
      ]),
      border: mix(palette.deep, palette.primary, 0.2),
      borderStrong: mix(palette.deep, palette.primary, 0.34),
      primary: legibleOnSurfaces(palette.primaryOnDark, [
        palette.deep,
        mix(palette.deep, palette.primary, 0.04),
      ]),
      // Status colours are tuned for white paper; lift them onto the dark canvas
      // and onto the cards that sit on it.
      success: legibleOnSurfaces(palette.success, [palette.deep, mix(palette.deep, palette.primary, 0.04)]),
      warning: legibleOnSurfaces(palette.warning, [palette.deep, mix(palette.deep, palette.primary, 0.04)]),
      danger: legibleOnSurfaces(palette.danger, [palette.deep, mix(palette.deep, palette.primary, 0.04)]),
    };
  }
  return {
    mode,
    bg: palette.surface,
    bgElev: palette.card,
    bgElev2: mix(palette.surface, palette.primary, 0.04),
    card: palette.card,
    text: palette.ink,
    textDim: palette.muted,
    textFaint: legibleOnSurfaces(mix(palette.muted, palette.surface, 0.35), [
      palette.surface,
      palette.card,
    ]),
    border: palette.line,
    borderStrong: mix(palette.line, palette.ink, 0.3),
    primary: legibleOnSurfaces(palette.primaryOnLight, [palette.surface, palette.card]),
    success: legibleOnSurfaces(palette.success, [palette.surface, palette.card]),
    warning: legibleOnSurfaces(palette.warning, [palette.surface, palette.card]),
    danger: legibleOnSurfaces(palette.danger, [palette.surface, palette.card]),
  };
}

/**
 * Raise a colour's contrast against `background` until it reaches `target`.
 *
 * The VI's status colours (`success`, `warning`, `danger`) are tuned for white
 * paper: on the palette's own `deep` background they measure about 2.9:1, well
 * under the 4.5:1 the rules require for text. Rather than substituting ad-hoc
 * "dark mode" hexes — which is how a second, unmaintained palette appears — the
 * legible variant is derived by blending toward white, the smallest blend that
 * passes. The semantic colour stays recognisably the same hue.
 *
 * Returns the original colour when it already passes, so a light background
 * keeps the exact value from the preset.
 */
export function legibleOn(color: string, background: string, target = 4.5): string {
  if (contrastRatio(color, background) >= target) return color;
  // Direction matters. Blending toward white raises contrast on a dark
  // background and *lowers* it on a light one, so the light theme needs the
  // blend toward the ink instead. Doing only the white blend left the light
  // theme's faint text at 2.46:1 — the lowest contrast anywhere in the tokens.
  const toward = isLight(background) ? "#000000" : "#FFFFFF";
  for (let step = 1; step <= 100; step += 1) {
    const candidate = mix(color, toward, step / 100);
    if (contrastRatio(candidate, background) >= target) return candidate;
  }
  return toward;
}

/**
 * Raise a colour until it clears `target` against **every** surface it can be
 * drawn on.
 *
 * Clearing only the page background is not enough: cards are lighter than the
 * dark background (and darker than the light one), so a token that passed on the
 * background could still sit at 3.9:1 on a card. Deriving per-surface was the
 * bug — the status colours were raised against `deep` and then used on cards.
 */
export function legibleOnSurfaces(color: string, backgrounds: string[], target = 4.5): string {
  const passes = (c: string) => backgrounds.every((b) => contrastRatio(c, b) >= target);
  if (passes(color)) return color;
  const toward = backgrounds.some((b) => isLight(b)) ? "#000000" : "#FFFFFF";
  for (let step = 1; step <= 100; step += 1) {
    const candidate = mix(color, toward, step / 100);
    if (passes(candidate)) return candidate;
  }
  return toward;
}

/** Is this colour a light surface? Used only to aim the contrast blend. */
function isLight(hex: string): boolean {
  const [r, g, b] = parseHex(hex);
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return luminance > 0.5;
}

/** Blend two hex colours; `weight` is the share of `b`. */
export function mix(a: string, b: string, weight: number): string {
  const w = Math.min(1, Math.max(0, weight));
  const pa = parseHex(a);
  const pb = parseHex(b);
  const channel = (x: number, y: number) => Math.round(x * (1 - w) + y * w);
  return toHex(channel(pa[0], pb[0]), channel(pa[1], pb[1]), channel(pa[2], pb[2]));
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function toHex(r: number, g: number, b: number): string {
  const part = (v: number) => v.toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

/** WCAG contrast ratio, used by the checker to police text legibility. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Alpha-suffixed colour, for tints and glows derived from a role. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Three.js wants a number, not a CSS string. */
export function toThreeColor(hex: string): number {
  return Number.parseInt(hex.replace("#", ""), 16);
}
