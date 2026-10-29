/**
 * Palette bridge for the Three.js scene.
 *
 * The scene is drawn on a canvas, so CSS variables do not reach it by
 * themselves. This module resolves the *same* variables the page uses and hands
 * them to Three.js as numbers, which is what keeps the 3D view on-brand: the VI
 * requires a theme change to affect the whole page, and a canvas left on fixed
 * literals is the classic place that promise breaks.
 *
 * Values are read once per mount and re-read when the theme attribute changes,
 * not per frame — `getComputedStyle` in a render loop would cost more than the
 * rendering.
 */

import { ELECTRIC_ORBIT, themeSurfaces, toThreeColor } from "@/lib/vi/palette";

/** Every colour the orbital view draws with. */
export interface ScenePalette {
  /** Deepest backdrop behind the globe. */
  background: number;
  ambient: number;
  sun: number;
  rim: number;

  globe: number;
  globeEmissive: number;
  atmosphere: number;
  graticule: number;
  equator: number;

  star: number;
  /** Orbit tracks by category. */
  trackOperator: number;
  trackOptical: number;

  /** Conjunction highlight: the link between two approaching objects. */
  highlight: number;
  highlightDim: number;
  /** Selected object accent. */
  selection: number;

  /** The Moon's disc. */
  moon: number;
  /** Country borders and other structural lines above the shell. */
  borderStrong: number;
}

/**
 * Default palette, used before mount and when a variable is missing.
 *
 * Derived from the VI palette rather than written out, so the fallback cannot
 * drift from the tokens.
 */
export function fallbackScenePalette(mode: "dark" | "light" = "dark"): ScenePalette {
  const surfaces = themeSurfaces(ELECTRIC_ORBIT, mode);
  const dark = mode === "dark";
  return {
    background: toThreeColor(surfaces.bg),
    ambient: toThreeColor(dark ? "#5A7599" : "#B9C6D4"),
    sun: toThreeColor("#FFFFFF"),
    rim: toThreeColor(dark ? ELECTRIC_ORBIT.primaryOnDark : ELECTRIC_ORBIT.primaryOnLight),
    globe: toThreeColor(dark ? "#16324D" : "#CFDCE9"),
    globeEmissive: toThreeColor(dark ? "#08131F" : "#E8F0F8"),
    atmosphere: toThreeColor(ELECTRIC_ORBIT.primary),
    graticule: toThreeColor(surfaces.borderStrong),
    equator: toThreeColor(surfaces.border),
    star: toThreeColor(dark ? "#FFFFFF" : "#5A6B7C"),
    trackOperator: toThreeColor(ELECTRIC_ORBIT.primary),
    trackOptical: toThreeColor(ELECTRIC_ORBIT.accent),
    highlight: toThreeColor(surfaces.danger),
    highlightDim: toThreeColor(surfaces.warning),
    selection: toThreeColor(ELECTRIC_ORBIT.accent),
    moon: toThreeColor(dark ? "#C9D3DE" : "#8C97A3"),
    borderStrong: toThreeColor(surfaces.borderStrong),
  };
}

/**
 * Resolve the scene palette from the document's current theme.
 *
 * Any variable the stylesheet does not define falls back to the derived value,
 * so the scene still renders if the tokens are missing.
 */
export function readScenePalette(element: HTMLElement): ScenePalette {
  const style = getComputedStyle(element);
  const mode: "dark" | "light" =
    (element.closest("[data-theme]") as HTMLElement | null)?.dataset.theme === "light"
      ? "light"
      : "dark";
  const fallback = fallbackScenePalette(mode);

  const read = (name: string, def: number) => {
    const value = style.getPropertyValue(name).trim();
    return /^#[0-9a-f]{3,8}$/i.test(value) ? toThreeColor(value) : def;
  };

  return {
    background: read("--bg", fallback.background),
    ambient: read("--scene-ambient", fallback.ambient),
    sun: read("--scene-sun", fallback.sun),
    rim: read("--scene-rim", fallback.rim),
    globe: read("--scene-globe", fallback.globe),
    globeEmissive: read("--scene-globe-emissive", fallback.globeEmissive),
    atmosphere: read("--color-primary", fallback.atmosphere),
    graticule: read("--border-strong", fallback.graticule),
    equator: read("--border", fallback.equator),
    star: read("--scene-star", fallback.star),
    trackOperator: read("--color-primary", fallback.trackOperator),
    trackOptical: read("--color-accent", fallback.trackOptical),
    highlight: read("--risk-high", fallback.highlight),
    highlightDim: read("--risk-medium", fallback.highlightDim),
    selection: read("--color-accent", fallback.selection),
    moon: read("--scene-moon", fallback.moon),
    borderStrong: read("--border-strong", fallback.borderStrong),
  };
}

