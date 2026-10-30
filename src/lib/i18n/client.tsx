"use client";

/**
 * Client-side i18n context.
 *
 * The provider receives the locale the *server* resolved for this request, so
 * the first client render matches the server HTML exactly. Switching language
 * writes the cookie and refreshes the route, letting the server re-render — that
 * keeps one source of truth for the chosen locale instead of two views of it
 * that can drift.
 */

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

import { DEFAULT_LOCALE, type Locale, type Translator } from "./index";
// From `tables`, never `registry`: the latter imports `next/headers`, which a
// client component cannot ship.
import { LOCALE_COOKIE, translator } from "./tables";

interface I18nContextValue {
  locale: Locale;
  t: Translator;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  const t = useMemo(() => translator(locale), [locale]);

  const setLocale = useCallback((next: Locale) => {
    // One year, path-wide: the choice is a preference, not a session value.
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    // A full reload rather than `router.refresh()`: server components that read
    // the cookie during static generation would otherwise keep the old table.
    window.location.reload();
  }, []);

  const value = useMemo(() => ({ locale, t, setLocale }), [locale, t, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Translator for the enclosing provider.
 *
 * Outside a provider it falls back to the default locale rather than throwing.
 * A component that renders standalone — the chart axis test server-renders one
 * on its own — would otherwise fail on a missing context that is not its
 * business. Every page in the app is inside the provider, so a reader never
 * sees the fallback language.
 */
export function useTranslator(fallback?: Translator): Translator {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx.t;
  // `translator` is imported from `tables`, which carries no server-only code.
  return fallback ?? translator(DEFAULT_LOCALE);
}

export function useLocale(): Locale {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useLocale must be used inside <I18nProvider>");
  return ctx.locale;
}
