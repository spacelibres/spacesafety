"use client";

/**
 * Header controls pinned to the bottom-left of the sidebar: language and theme.
 *
 * ## Why a class and two components rather than inline handlers
 *
 * Both controls write a preference cookie and then re-request the page, because
 * the locale and the theme attribute are rendered by the server. Doing the
 * switch only in the browser is the standard way to get a flash of the wrong
 * language or palette, and it splits the source of truth. The duplication
 * (write cookie, reload) lives in one small `PreferenceStore`.
 *
 * ## Following the system
 *
 * The default for both is "automatic": the language comes from
 * `navigator.languages`, and the theme from `prefers-color-scheme`. A reader who
 * picks a value explicitly keeps that value; the automatic option remains
 * available to go back.
 */

import { useEffect, useState } from "react";

import {
  LOCALES,
  LOCALE_LABELS,
  normaliseLocale,
  type Locale,
  type Translator,
} from "@/lib/i18n";
import { useLocale, useTranslator } from "@/lib/i18n/client";
import { ELECTRIC_ORBIT } from "@/lib/vi/palette";
import { VI_PRESETS } from "@/lib/vi/palette-derive";
import type { ThemePreference } from "@/lib/vi/theme";

const LOCALE_COOKIE = "locale";
const THEME_COOKIE = "theme";
const PALETTE_COOKIE = "palette";

/** Writes a preference and reloads so the server can re-render with it. */
class PreferenceStore {
  static write(name: string, value: string): void {
    // One year, path-wide: a preference, not a session value.
    document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
  }

  static setLocale(locale: Locale | "auto"): void {
    this.write(LOCALE_COOKIE, locale === "auto" ? "" : locale);
    window.location.reload();
  }

  static setTheme(theme: ThemePreference): void {
    this.write(THEME_COOKIE, theme);
    window.location.reload();
  }

  /**
   * Store a scheme choice.
   *
   * The cookie holds **one** thing — a preset id, or `custom:<hex>:<mode>` — not
   * sixteen colours. The VI derives the rest from the primary, so the primary is
   * the only choice worth persisting.
   */
  static setPalette(value: string): void {
    this.write(PALETTE_COOKIE, value);
    window.location.reload();
  }
}

/** Language for the reader's browser, if we support it. */
function systemLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  for (const tag of navigator.languages ?? [navigator.language]) {
    const candidate = normaliseLocale(tag);
    if (LOCALES.includes(candidate)) return candidate;
  }
  return "en";
}

/**
 * Sync the rendered theme with the operating system when the reader has not
 * chosen one explicitly.
 *
 * The server cannot read `prefers-color-scheme`, so `system` renders as dark
 * there and this corrects the attribute before the first paint is committed.
 * It also keeps following the OS when the preference changes mid-session.
 */
export function useSystemTheme(): void {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const explicit = document.cookie.match(/(?:^|;\s*)theme=([^;]*)/)?.[1];
    const followsSystem = !explicit || explicit === "system";

    const apply = () => {
      if (!followsSystem) return;
      document.documentElement.dataset.theme = media.matches ? "light" : "dark";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
}

export function PreferenceDock() {
  // Correct the server-rendered theme to the OS preference when the reader has
  // not chosen one explicitly. Nothing called this while the dock was unmounted,
  // so `theme=system` simply meant "dark" in practice.
  useSystemTheme();
  const t = useTranslator();
  const locale = useLocale();
  const [theme, setTheme] = useState<ThemePreference>("system");

  useEffect(() => {
    const raw = document.cookie.match(/(?:^|;\s*)theme=([^;]*)/)?.[1];
    setTheme(raw === "dark" || raw === "light" ? raw : "system");
  }, []);

  return (
    <div className="pref-dock">
      <LanguageControl t={t} locale={locale} />
      <ThemeControl t={t} theme={theme} onChange={(v) => PreferenceStore.setTheme(v)} />
      <PaletteControl t={t} />
    </div>
  );
}

/**
 * Colour scheme.
 *
 * The VI's Color Explorer is "只选主色，自动生成完整的全站色系": six shipped
 * schemes plus a custom primary, from which the other fifteen roles are derived.
 * So this offers the six and `custom`; a custom choice asks for the one thing
 * that actually determines the scheme — the primary — plus the harmony relation.
 */
function PaletteControl({ t }: { t: Translator }) {
  const [choice, setChoice] = useState("01-electric-orbit");
  const [hex, setHex] = useState(ELECTRIC_ORBIT.primary);
  const [harmony, setHarmony] = useState("auto");

  useEffect(() => {
    const raw = document.cookie.match(/(?:^|;\s*)palette=([^;]*)/)?.[1] ?? "";
    if (raw.startsWith("custom:")) {
      const [, customHex, mode] = raw.split(":");
      setChoice("custom");
      if (customHex) setHex(customHex);
      if (mode) setHarmony(mode);
    } else if (raw) {
      setChoice(raw);
    }
  }, []);

  const apply = (next: string, nextHex = hex, nextHarmony = harmony) => {
    PreferenceStore.setPalette(
      next === "custom" ? `custom:${nextHex}:${nextHarmony}` : next,
    );
  };

  return (
    <>
      <label className="pref-field">
        <span className="pref-label">{t.t("palette.label")}</span>
        <select
          value={choice}
          onChange={(event) => {
            setChoice(event.target.value);
            apply(event.target.value);
          }}
          aria-label={t.t("palette.label")}
        >
          {VI_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {t.t(`palette.${preset.id}`)}
            </option>
          ))}
          <option value="custom">{t.t("palette.custom")}</option>
        </select>
      </label>

      {choice === "custom" && (
        <>
          <label className="pref-field">
            <span className="pref-label">{t.t("palette.primary")}</span>
            <input
              type="text"
              value={hex}
              onChange={(event) => setHex(event.target.value.toUpperCase())}
              onBlur={() => apply("custom")}
              aria-label={t.t("palette.primary")}
              pattern="^#[0-9a-fA-F]{6}$"
            />
          </label>
          <label className="pref-field">
            <span className="pref-label">{t.t("palette.harmony")}</span>
            <select
              value={harmony}
              onChange={(event) => {
                setHarmony(event.target.value);
                apply("custom", hex, event.target.value);
              }}
              aria-label={t.t("palette.harmony")}
            >
              <option value="auto">{t.t("palette.auto")}</option>
              <option value="split">{t.t("palette.split")}</option>
              <option value="triad">{t.t("palette.triad")}</option>
              <option value="analogous">{t.t("palette.analogous")}</option>
            </select>
          </label>
        </>
      )}
    </>
  );
}

function LanguageControl({ t, locale }: { t: Translator; locale: Locale }) {
  return (
    <label className="pref-field">
      <span className="pref-label">{t.t("nav.language")}</span>
      <select
        value={locale}
        onChange={(event) => PreferenceStore.setLocale(event.target.value as Locale)}
        aria-label={t.t("nav.language")}
      >
        {LOCALES.map((item) => (
          <option key={item} value={item}>
            {LOCALE_LABELS[item]}
          </option>
        ))}
      </select>
    </label>
  );
}

function ThemeControl({
  t,
  theme,
  onChange,
}: {
  t: Translator;
  theme: ThemePreference;
  onChange: (value: ThemePreference) => void;
}) {
  return (
    <label className="pref-field">
      <span className="pref-label">{t.t("theme.label")}</span>
      <select
        value={theme}
        onChange={(event) => onChange(event.target.value as ThemePreference)}
        aria-label={t.t("theme.label")}
      >
        <option value="system">{t.t("theme.system")}</option>
        <option value="dark">{t.t("theme.dark")}</option>
        <option value="light">{t.t("theme.light")}</option>
      </select>
    </label>
  );
}

export { systemLocale };
