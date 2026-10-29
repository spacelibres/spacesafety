/**
 * Server-side locale resolution.
 *
 * Reads the reader's choice from the request cookie. This module imports
 * `next/headers`, so it is for server components and route handlers only; the
 * tables and the translator factory live in `tables.ts` so client components
 * can use them without pulling in a server-only import.
 */

import { cookies } from "next/headers";

import { type Locale, isLocale, normaliseLocale } from "./index";
import { LOCALE_COOKIE, translator } from "./tables";

export { LOCALE_COOKIE, allTables, messagesFor, translator } from "./tables";

/** Locale from the request cookie, falling back to the default. */
export async function currentLocale(): Promise<Locale> {
  const store = await cookies();
  const raw = store.get(LOCALE_COOKIE)?.value;
  return isLocale(raw) ? raw : normaliseLocale(raw);
}

/** Translator for the current request. Server components only. */
export async function getTranslator() {
  return translator(await currentLocale());
}
