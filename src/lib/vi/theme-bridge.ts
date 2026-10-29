/**
 * Global VI theme binding.
 *
 * ## Requirement
 *
 * The palette, the logo and every 3D surface must change together. That is not
 * achievable by keeping a copy of the colours in JavaScript: the DOM reads CSS
 * variables, Cesium/Three read numbers, and an SVG logo has its colours baked in
 * at build time. When any of those keeps its own copy, a theme change updates
 * some of the page and quietly misses the rest — which is exactly how the viewer
 * ended up rendering a black ball on an otherwise re-themed page.
 *
 * ## How this closes the loop
 *
 * Everything derives from `src/lib/vi/palette.ts`:
 *
 *   - CSS variables       `npm run vi`  -> `src/app/vi-tokens.css`
 *   - logo SVGs           `npm run vi`  -> `public/vi/*.svg` (dark + light)
 *   - CSS custom props    `paletteCss()` -> injected live on theme switch
 *   - Cesium / Three      `readTheme()`  -> real numbers at mount
 *   - favicon             follows the theme attribute
 *
 * So changing the palette in one file and running `npm run vi` re-themes the
 * three-dimensional view, the logo and the chrome in one step.
 */

import { ELECTRIC_ORBIT, themeSurfaces, toThreeColor, withAlpha, type ViPalette } from "./palette";

export type ThemeMode = "dark" | "light";

/**
 * Every colour the 3D layer needs, resolved as numbers.
 *
 * Deliberately a flat object of primitives rather than nested groups: a renderer
 * should not have to know the palette's structure to colour a line.
 */
export interface SceneTheme {
  mode: ThemeMode;
  /** Page background. */
  background: number;
  /** Earth surface tint when no imagery is loaded. */
  globe: number;
  globeEmissive: number;
  /** Atmosphere and selection accents. */
  primary: number;
  accent: number;
  /** Graticule and borders. */
  graticule: number;
  equator: number;
  border: number;
  /** Lighting. */
  ambient: number;
  sun: number;
  rim: number;
  moon: number;
  star: number;
  /** Data semantics. */
  danger: number;
  warning: number;
  success: number;
  /** Text on the 3D canvas (Cesium labels). */
  labelText: number;
  labelOutline: number;
  /** Data orbs and their glow. */
  trackOperator: number;
  trackOptical: number;
}

/** Resolve the palette into numbers a renderer can use. */
export function sceneTheme(palette: ViPalette, mode: ThemeMode): SceneTheme {
  const surfaces = themeSurfaces(palette, mode);
  const dark = mode === "dark";
  return {
    mode,
    background: toThreeColor(surfaces.bg),
    globe: toThreeColor(dark ? "#16324D" : "#CFDCE9"),
    globeEmissive: toThreeColor(dark ? "#08131F" : "#E8F0F8"),
    primary: toThreeColor(surfaces.primary),
    accent: toThreeColor(palette.accent),
    graticule: toThreeColor(surfaces.borderStrong),
    equator: toThreeColor(surfaces.border),
    border: toThreeColor(surfaces.borderStrong),
    ambient: toThreeColor(dark ? "#5A7599" : "#B9C6D4"),
    sun: toThreeColor("#FFFFFF"),
    rim: toThreeColor(dark ? palette.primaryOnDark : palette.primaryOnLight),
    moon: toThreeColor(dark ? "#C9D3DE" : "#8C97A3"),
    star: toThreeColor(dark ? "#FFFFFF" : "#5A6B7C"),
    danger: toThreeColor(surfaces.danger),
    warning: toThreeColor(surfaces.warning),
    success: toThreeColor(surfaces.success),
    labelText: toThreeColor(surfaces.text),
    labelOutline: toThreeColor(surfaces.bg),
    trackOperator: toThreeColor(palette.primary),
    trackOptical: toThreeColor(palette.accent),
  };
}

/** The default theme, dark, from the approved palette. */
export function defaultSceneTheme(mode: ThemeMode = "dark"): SceneTheme {
  return sceneTheme(ELECTRIC_ORBIT, mode);
}

/**
 * A CSS colour string from a numeric scene colour.
 *
 * Cesium wants `#rrggbb` strings for labels and materials; Three wants numbers.
 * Converting once here stops each renderer inventing its own formatting.
 */
export function cssColour(value: number, alpha = 1): string {
  const hex = value.toString(16).padStart(6, "0");
  if (alpha >= 1) return `#${hex}`;
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${hex}${a}`;
}

/**
 * Read the live theme attribute from the document.
 *
 * The attribute is what the server rendered and what the theme switcher writes,
 * so it is the one source of truth for "which mode am I in"; the palette is then
 * resolved from that rather than duplicating the preference.
 */
export function currentMode(): ThemeMode {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * Watch for theme changes and hand back an unsubscribe function.
 *
 * `MutationObserver` rather than a custom event: the theme can be changed by the
 * in-app switcher, by a cookie-driven reload, or by the OS preference listener,
 * and all three end up writing the same attribute.
 */
export function onThemeChange(callback: (mode: ThemeMode) => void): () => void {
  if (typeof document === "undefined") return () => {};
  const target = document.documentElement;
  callback(currentMode());
  const observer = new MutationObserver(() => callback(currentMode()));
  observer.observe(target, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** URL of the logo variant for a mode, so the mark and the palette move together. */
export function logoFor(mode: ThemeMode, layout: "stacked" | "horizontal" | "icon"): string {
  return `/vi/${layout}-primary-${mode}.svg`;
}
