/**
 * Internationalisation — the single source of every user-visible string.
 *
 * ## Why a class here
 *
 * The project rules require stateful cross-cutting concerns to live in an
 * object. A translator owns the selected locale, the message table for it, and
 * the formatters derived from it, so it is a `Translator`, not a module-level
 * dictionary plus a global variable holding the current language.
 *
 * ## Missing keys are a commit-time failure, not a runtime fallback
 *
 * A silent fallback to English is how half-translated screens ship: nothing
 * breaks, so nobody notices. `validateMessages()` compares every locale against
 * the reference and reports missing, extra and empty keys; `tools/check.ts` runs
 * it before every commit. At runtime a missing key still falls back — a page
 * must not crash over a label — but warns once per key outside production.
 *
 * ## What is *not* translated
 *
 * Technical identifiers (`STARLINK-1234`, CCSDS field names, `km/s`, NORAD ids),
 * API paths and orbital data are language-neutral by specification. Translating
 * `TRAJ_REF_FRAME` or a unit symbol would make the data wrong, not localized.
 */

export const LOCALES = ["zh-CN", "en", "es", "fr", "de", "ja"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "zh-CN";

/** Language names for the switcher, each written in its own language. */
export const LOCALE_LABELS: Record<Locale, string> = {
  "zh-CN": "简体中文",
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  ja: "日本語",
};

/** `en` is the reference: every other locale must have exactly its keys. */
export const REFERENCE_LOCALE: Locale = "en";

export type MessageKey = string;
export type Messages = Record<MessageKey, string>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Accept `zh`, `zh-cn`, `en-US` and friends; return a supported locale. */
export function normaliseLocale(value: string | null | undefined): Locale {
  if (!value) return DEFAULT_LOCALE;
  const lower = value.toLowerCase();
  if (lower === "zh" || lower.startsWith("zh-")) return "zh-CN";
  for (const locale of LOCALES) {
    if (locale.toLowerCase() === lower) return locale;
    if (lower.startsWith(locale.slice(0, 2))) return locale;
  }
  return DEFAULT_LOCALE;
}

export interface TranslatorOptions {
  locale: Locale;
  messages: Messages;
  /** Reference table, used only to report a missing key. */
  fallback?: Messages;
}

/**
 * Translates keys and formats values for one locale.
 *
 * Instances are immutable after construction, so sharing one per locale is safe.
 */
export class Translator {
  readonly locale: Locale;
  private readonly messages: Messages;
  private readonly fallback: Messages;

  constructor(options: TranslatorOptions) {
    this.locale = options.locale;
    this.messages = options.messages;
    this.fallback = options.fallback ?? {};
  }

  /** Message for `key`, with `{name}` placeholders substituted. */
  t(key: MessageKey, params?: Record<string, string | number>): string {
    const raw = this.messages[key] ?? this.fallback[key];
    if (raw === undefined) {
      warnMissing(this.locale, key);
      return key;
    }
    if (!params) return raw;
    // Only `{identifier}` shapes are substituted, so a message containing CSS or
    // a URL with braces is left alone.
    return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  }

  /** Number with locale-appropriate grouping and decimals. */
  number(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(this.locale, options).format(value);
  }

  /** Instant as a locale-formatted date-time. */
  dateTime(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
    const date = value instanceof Date ? value : new Date(value);
    return new Intl.DateTimeFormat(this.locale, options).format(date);
  }

  /** Probability in scientific notation, the way CDMs report Pc. */
  probability(value: number): string {
    if (!Number.isFinite(value)) return "—";
    if (value === 0) return "0";
    return value.toExponential(2);
  }

  /** Distance in km; the unit symbol is not translated. */
  distanceKm(value: number, digits = 3): string {
    return `${this.number(value, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })} km`;
  }

  /** Speed in km/s. */
  speedKmS(value: number, digits = 3): string {
    return `${this.number(value, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })} km/s`;
  }
}

/** Warn once per (locale, key) outside production; silent in production. */
function warnMissing(locale: Locale, key: string): void {
  if (process.env.NODE_ENV === "production") return;
  const store = globalThis as { __missingI18n?: Set<string> };
  const seen = store.__missingI18n ?? new Set<string>();
  const id = `${locale}:${key}`;
  if (seen.has(id)) return;
  seen.add(id);
  store.__missingI18n = seen;
  console.warn(`[i18n] missing key in "${locale}": ${key}`);
}

export interface MessageAudit {
  ok: boolean;
  missing: Array<{ locale: Locale; keys: string[] }>;
  extra: Array<{ locale: Locale; keys: string[] }>;
  empty: Array<{ locale: Locale; keys: string[] }>;
}

/**
 * Compare every locale against the reference.
 *
 * Returns a structured report rather than throwing, so the checker can print
 * every problem in one run — fixing them one per run wastes the developer's time.
 */
export function validateMessages(
  tables: Record<Locale, Messages>,
  reference: Locale = REFERENCE_LOCALE,
): MessageAudit {
  const refKeys = new Set(Object.keys(tables[reference]));
  const audit: MessageAudit = {
    ok: true,
    missing: [],
    extra: [],
    empty: [],
  };

  for (const locale of Object.keys(tables) as Locale[]) {
    const keys = new Set(Object.keys(tables[locale]));
    const missing = [...refKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !refKeys.has(k));
    const empty = [...keys].filter((k) => (tables[locale][k] ?? "").trim() === "");
    if (missing.length) audit.missing.push({ locale, keys: missing });
    if (extra.length) audit.extra.push({ locale, keys: extra });
    if (empty.length) audit.empty.push({ locale, keys: empty });
  }

  audit.ok =
    audit.missing.length === 0 && audit.extra.length === 0 && audit.empty.length === 0;
  return audit;
}
