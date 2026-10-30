/**
 * Theme preference.
 *
 * Kept next to the locale because both are reader preferences that must be
 * resolved on the server: applying a theme only in the browser would paint the
 * wrong background for one frame, and the VI requires the theme to reach the
 * whole page rather than a subset of it.
 */

import { cookies } from "next/headers";

import { ELECTRIC_ORBIT, customPalette, presetPalette, type ViPalette } from "./palette";
import { presetById, type HarmonyMode } from "./palette-derive";

export const THEME_COOKIE = "theme";

/**
 * `system` means "follow the operating system's preference".
 *
 * It is the default: a reader who has set their machine to light should not be
 * handed a dark app without asking. The concrete value is resolved on the
 * client from `prefers-color-scheme`, because a server cannot know it.
 */
export type ThemePreference = "system" | "dark" | "light";
export type ThemeMode = "dark" | "light";

export const DEFAULT_THEME: ThemePreference = "system";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "dark" || value === "light";
}

/** Theme preference from the request cookie. */
export async function currentThemePreference(): Promise<ThemePreference> {
  const store = await cookies();
  const raw = store.get(THEME_COOKIE)?.value;
  return isThemePreference(raw) ? raw : DEFAULT_THEME;
}

/**
 * The concrete mode to render.
 *
 * `system` resolves to dark on the server: the orbital view is designed on a
 * dark canvas, and the client corrects it immediately from
 * `prefers-color-scheme` before the first paint if the machine prefers light.
 */
export async function currentTheme(): Promise<ThemeMode> {
  const preference = await currentThemePreference();
  return preference === "system" ? "dark" : preference;
}

/**
 * The reader's colour scheme.
 *
 * The VI's Color Explorer works from **one primary colour**: pick it, and the
 * other fifteen roles are generated ("只选主色，自动生成完整的全站色系"). The six
 * shipped schemes are seeds for that generator, so this cookie stores either a
 * preset id or `custom:<hex>:<mode>` — never sixteen colours.
 *
 * Resolved on the server for the same reason the theme is: the token block is
 * what the first paint uses, and applying a palette in the browser would show one
 * frame of the old one.
 */
export const PALETTE_COOKIE = "palette";

/** Parse the cookie into a palette, falling back to the product default. */
export function paletteFromCookie(raw: string | undefined): ViPalette {
  if (!raw) return ELECTRIC_ORBIT;

  if (raw.startsWith("custom:")) {
    const [, hex, mode] = raw.split(":");
    if (/^#[0-9a-f]{6}$/i.test(hex ?? "")) {
      const harmony = mode as HarmonyMode | undefined;
      return customPalette(hex, harmony === "split" || harmony === "triad" || harmony === "analogous" ? harmony : "auto");
    }
    return ELECTRIC_ORBIT;
  }

  return presetById(raw) ? presetPalette(raw) : ELECTRIC_ORBIT;
}

export async function currentPalette(): Promise<ViPalette> {
  const store = await cookies();
  return paletteFromCookie(store.get(PALETTE_COOKIE)?.value);
}

/** Serialise a choice back into the cookie value. */
export function paletteCookieValue(presetId: string, customHex?: string, harmony: HarmonyMode = "auto"): string {
  if (presetId === "custom") {
    return `custom:${(customHex ?? "#007BFF").toUpperCase()}:${harmony}`;
  }
  return presetId;
}
