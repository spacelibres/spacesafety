/**
 * Locale tables and the translator factory — safe in server *and* client
 * components.
 *
 * Deliberately separate from `registry.ts`, which imports `next/headers` for
 * the request cookie: a client component that imported that module fails to
 * compile with "next/headers only works in a Server Component". Keeping the
 * data here lets `client.tsx` build a translator without dragging a
 * server-only import into the browser bundle.
 */

import { type Locale, type Messages, Translator, REFERENCE_LOCALE } from "./index";
import { de } from "./messages/de";
import { en } from "./messages/en";
import { es } from "./messages/es";
import { fr } from "./messages/fr";
import { ja } from "./messages/ja";
import { zhCN } from "./messages/zh-CN";

/** Cookie that carries the reader's choice. Readable on both sides. */
export const LOCALE_COOKIE = "locale";

const TABLES: Record<Locale, Messages> = {
  "zh-CN": zhCN,
  en,
  es,
  fr,
  de,
  ja,
};

export function messagesFor(locale: Locale): Messages {
  return TABLES[locale];
}

export function allTables(): Record<Locale, Messages> {
  return TABLES;
}

/** Build a translator for an explicit locale. */
export function translator(locale: Locale): Translator {
  return new Translator({
    locale,
    messages: TABLES[locale],
    fallback: TABLES[REFERENCE_LOCALE],
  });
}
