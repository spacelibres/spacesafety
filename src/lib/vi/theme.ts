/**
 * Theme preference.
 *
 * Kept next to the locale because both are reader preferences that must be
 * resolved on the server: applying a theme only in the browser would paint the
 * wrong background for one frame, and the VI requires the theme to reach the
 * whole page rather than a subset of it.
 */

import { cookies } from "next/headers";

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
