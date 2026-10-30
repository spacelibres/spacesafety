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

import { useEffect, useState } from "react";

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

/**
 * Colours for the SVG charts.
 *
 * The charts used to carry their own dark-mode hexes — `#2ec27e` for a series,
 * `#ff4d5e` for an error band, `#6b6b6b` for axis labels. That is precisely the
 * "second, unmaintained palette" the VI forbids (§9.1, §9.4): on a light theme the
 * charts kept a dark canvas' colours, and on a dark theme the status colours were
 * a hand-picked pair that no contrast measurement had ever seen.
 *
 * Every value here comes from `themeSurfaces`, which already applies `legibleOn`
 * to the status colours, so a chart is legible in both modes by construction.
 */
export interface ChartTheme {
  /** Frame and tick lines. */
  axis: string;
  /** Horizontal/vertical guides behind the data. */
  grid: string;
  /** The zero line, drawn heavier than the guides. */
  zero: string;
  /** Axis labels and tick values. Small text, so it needs 4.5:1, not the faintest ink. */
  label: string;
  /** The measured series. */
  series: string;
  /** A passing band, and its dimmer fill. */
  ok: string;
  okDim: string;
  /** A failing band / threshold exceedance. */
  danger: string;
  /** The theoretical reference curve. */
  reference: string;
  /** Marker outline, drawn in the surface colour so dots read as cut out. */
  stroke: string;
}

export function chartTheme(palette: ViPalette, mode: ThemeMode): ChartTheme {
  const surfaces = themeSurfaces(palette, mode);
  return {
    axis: surfaces.border,
    grid: surfaces.border,
    zero: surfaces.borderStrong,
    label: surfaces.textDim,
    series: surfaces.primary,
    ok: surfaces.success,
    okDim: withAlpha(surfaces.success, 0.45),
    danger: surfaces.danger,
    reference: surfaces.textDim,
    stroke: surfaces.bg,
  };
}

/** The chart theme for the approved palette. */
export function defaultChartTheme(mode: ThemeMode = "dark"): ChartTheme {
  return chartTheme(ELECTRIC_ORBIT, mode);
}

/**
 * The live theme mode, for components that must swap an asset with it.
 *
 * The logo is a themed SVG — the VI recolours the planet per theme — so the
 * component that renders it needs the mode and must re-render when it changes.
 * Only client components may call this: it subscribes to a DOM observer.
 */
export function useThemeMode(serverMode: ThemeMode): ThemeMode {
  // `serverMode` is the mode the server rendered for this request. Seeding state
  // with it keeps the first client render identical to the HTML; deriving the
  // initial value from `document` instead produced a mismatch that left the logo
  // on the dark master while the CSS variables around it were already light.
  const [mode, setMode] = useState<ThemeMode>(serverMode);
  useEffect(() => onThemeChange(setMode), []);
  return mode;
}

/**
 * Chart colours that follow the live theme.
 *
 * The first render uses the server-rendered `data-theme` so the SVG matches the
 * page; `onThemeChange` then re-renders on a switcher or OS change. Only client
 * components may call this — it subscribes to a DOM observer.
 */
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState<ChartTheme>(() => defaultChartTheme(currentMode()));
  useEffect(() => onThemeChange((mode) => setTheme(defaultChartTheme(mode))), []);
  return theme;
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
