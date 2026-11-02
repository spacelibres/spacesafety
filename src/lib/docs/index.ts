import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Loader for the documentation set.
 *
 * ## Why the content lives outside `src/`
 *
 * `npm run check` asserts that every user-visible string under `src/` comes from
 * the translation dictionary — a good rule, and it would fire on a docs corpus if
 * the corpus lived in `src/` as string literals. Documentation is *content*, not UI
 * chrome, so it lives in `content/docs/` and is read at request time; the strings
 * that remain in `src/` are the labels and headings of the UI around it.
 *
 * ## Language policy
 *
 * Bodies are authored in **English** and **Chinese**. A locale without a
 * translation falls back to English, and the page says so rather than pretending:
 * an unlabelled fallback is how a reader ends up quoting a page that was never
 * written for them. The policy is recorded in `CONTRIBUTING.md` §10.
 */

/** Locales the site ships. English is the fallback for documentation bodies. */
export const DOC_LOCALES = ["en", "zh-CN"] as const;
export type DocLocale = (typeof DOC_LOCALES)[number];
export const DOC_FALLBACK: DocLocale = "en";

const ROOT = join(process.cwd(), "content", "docs");

export interface Localised {
  en: string;
  "zh-CN": string;
}

export interface DocPageRef {
  slug: string;
  title: Localised;
}

export interface DocGroup {
  id: string;
  title: Localised;
}

export interface DocSection {
  id: string;
  title: Localised;
  pages?: DocPageRef[];
  /** True for the API reference, whose pages are generated from endpoints.json. */
  endpoints?: boolean;
  groups?: DocGroup[];
}

export interface DocsNav {
  sections: DocSection[];
}

export interface EndpointParam {
  in: "query" | "path" | "header";
  name: string;
  type: string;
  required: boolean;
  default?: string;
  values?: string[];
  desc: Localised;
  /** Marks a parameter this deployment adds on top of the official contract. */
  extension?: boolean;
}

export interface EndpointField {
  name: string;
  type: string;
}

export interface EndpointResponse {
  status: number;
  meaning: Localised;
  fields?: Array<[string, string]>;
  example?: unknown;
}

export interface Endpoint {
  slug: string;
  section: string;
  extension?: boolean;
  title: Localised;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  summary: Localised;
  auth?: string;
  params: EndpointParam[];
  body: Array<{
    name: string;
    type: string;
    required: boolean;
    default?: string;
    values?: string[];
    desc: Localised;
  }>;
  responses: EndpointResponse[];
  notes?: Localised[];
}

export interface EndpointDoc {
  baseUrl: string;
  note: string;
  endpoints: Endpoint[];
}

/** Cached per process: the files are static, and a docs page is not a data source. */
let navCache: DocsNav | null = null;
let endpointCache: EndpointDoc | null = null;

export function docsNav(): DocsNav {
  if (!navCache) {
    navCache = JSON.parse(readFileSync(join(ROOT, "nav.json"), "utf8")) as DocsNav;
  }
  return navCache;
}

export function docsEndpoints(): EndpointDoc {
  if (!endpointCache) {
    endpointCache = JSON.parse(
      readFileSync(join(ROOT, "endpoints.json"), "utf8"),
    ) as EndpointDoc;
  }
  return endpointCache;
}

export function endpointBySlug(slug: string): Endpoint | null {
  return docsEndpoints().endpoints.find((e) => e.slug === slug) ?? null;
}

/** Narrow an arbitrary locale string to one docs are authored in. */
export function docLocale(locale: string): DocLocale {
  return (DOC_LOCALES as readonly string[]).includes(locale) ? (locale as DocLocale) : DOC_FALLBACK;
}

export interface LoadedDocPage {
  markdown: string;
  /** The locale actually served. */
  used: DocLocale;
  /** True when the request locale has no translation and English was served. */
  fellBack: boolean;
  title: Localised;
  section: DocSection;
  /** Previous / next within the same section, for the footer. */
  prev: DocPageRef | null;
  next: DocPageRef | null;
}

function pagePath(locale: DocLocale, slug: string): string {
  return join(ROOT, "pages", locale, `${slug}.md`);
}

/**
 * Load one prose page.
 *
 * `slug` may contain a single segment (`quick-start`) because sections are a
 * navigation concept, not a directory: the file is `pages/<locale>/<slug>.md`.
 */
export function loadDocPage(locale: string, slug: string): LoadedDocPage | null {
  const wanted = docLocale(locale);
  const nav = docsNav();

  let section: DocSection | undefined;
  let index = -1;
  for (const candidate of nav.sections) {
    if (!candidate.pages) continue;
    const i = candidate.pages.findIndex((p) => p.slug === slug);
    if (i >= 0) {
      section = candidate;
      index = i;
      break;
    }
  }
  if (!section || index < 0) return null;

  const available = wanted !== DOC_FALLBACK && existsSync(pagePath(wanted, slug));
  const used: DocLocale = available ? wanted : DOC_FALLBACK;
  const path = pagePath(used, slug);
  if (!existsSync(path)) return null;

  const pages = section.pages ?? [];
  return {
    markdown: readFileSync(path, "utf8"),
    used,
    fellBack: used !== wanted,
    title: pages[index].title,
    section,
    prev: index > 0 ? pages[index - 1] : null,
    next: index < pages.length - 1 ? pages[index + 1] : null,
  };
}

/** Every prose slug in the manifest, for the parity test. */
export function allPageSlugs(): string[] {
  return docsNav().sections.flatMap((s) => (s.pages ?? []).map((p) => p.slug));
}

/** Strip the leading `# Title` line: the page header renders the title itself. */
export function stripTitle(markdown: string): string {
  return markdown.replace(/^#[^\n]*\n+/, "");
}
