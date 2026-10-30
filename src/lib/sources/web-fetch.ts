/**
 * Fetching and cleaning a web page for extraction.
 *
 * ## Why the allowlist is code and not a setting
 *
 * The supplement layer only accepts first-party or named-source material. A
 * search engine will happily return a forum post asserting that a satellite weighs
 * 800 kg. Fetching it costs a token budget and, worse, produces a claim that looks
 * exactly like one from a manufacturer's page. The allowlist is the cheapest place
 * to stop that: the page is never downloaded.
 *
 * ## Why HTML is reduced to text here rather than in the model
 *
 * DeepSeek charges by token and a page is mostly navigation, scripts and cookie
 * banners. Stripping tags before sending cuts the input by an order of magnitude and
 * removes the biggest source of distraction: a model given a menu bar full of star
 * names may quote a star name.
 */

import { ACCEPT_ENCODING } from "../net/encoding";

/**
 * Domains whose content counts as a first-party or named-source record.
 *
 * `attribution` is not decoration. Gunter's Space Page states
 * `"aiRAG": "allowed-with-attribution-required"` and `noai` in its robots meta;
 * using it without naming the author would breach the permission it grants. Any
 * entry that requires attribution carries it here and it is written into the stored
 * claim, so the credit survives into whatever the value is later shown in.
 */
const ALLOWED_DOMAINS: Array<{
  domain: string;
  type: AllowlistType;
  note: string;
  attribution?: string;
}> = [
  // A: first-party — the operator or builder describing its own hardware
  { domain: "spacex.com", type: "official", note: "Starlink operator and launcher" },
  { domain: "starlink.com", type: "official", note: "Starlink operator" },
  { domain: "hawkeye360.com", type: "official", note: "HawkEye 360" },
  { domain: "planet.com", type: "official", note: "Planet Labs" },
  { domain: "oneweb.net", type: "official", note: "Eutelsat OneWeb" },
  { domain: "spire.com", type: "official", note: "Spire Global" },
  { domain: "iceye.com", type: "official", note: "ICEYE" },
  { domain: "i-rs.com", type: "official", note: "Iceye US" },
  { domain: "blacksky.com", type: "official", note: "BlackSky" },
  { domain: "planetek.com", type: "official", note: "Planetek" },

  // A: agencies — the body that built or procured the object
  { domain: "nasa.gov", type: "agency", note: "NASA" },
  { domain: "esa.int", type: "agency", note: "ESA" },
  { domain: "cnsa.gov.cn", type: "agency", note: "CNSA" },
  { domain: "jaxa.jp", type: "agency", note: "JAXA" },
  { domain: "isro.gov.in", type: "agency", note: "ISRO" },
  { domain: "roscosmos.ru", type: "agency", note: "Roscosmos" },
  { domain: "noaa.gov", type: "agency", note: "NOAA" },
  { domain: "spaceforce.mil", type: "agency", note: "US Space Force" },

  // A: filings — the legal record of what was launched and what it weighs
  { domain: "fcc.gov", type: "fcc", note: "US spectrum filing — the legal launch record" },
  { domain: "licensing.fcc.gov", type: "fcc", note: "FCC licence filings" },
  { domain: "itu.int", type: "fcc", note: "ITU space network filings" },

  // B: reference works and trade press that name their sources
  {
    domain: "skyrocket.de",
    type: "encyclopedia",
    note: "Gunter's Space Page",
    attribution: "Gunter Dirk Krebs, Gunter's Space Page (space.skyrocket.de)",
  },
  {
    domain: "wikipedia.org",
    type: "encyclopedia",
    note: "Wikipedia — only where the article carries its own citations",
    attribution: "Wikipedia contributors (CC BY-SA 4.0)",
  },
  { domain: "spacenews.com", type: "press", note: "SpaceNews" },
  { domain: "spaceflightnow.com", type: "press", note: "Spaceflight Now" },
  { domain: "nasaspaceflight.com", type: "press", note: "NASASpaceflight" },
  { domain: "space.com", type: "press", note: "Space.com" },

  // B: orbital-data operators. Their product pages describe the constellations
  // they track; their raw catalogue data is already covered by Space-Track/DISCOS.
  { domain: "leolabs.space", type: "press", note: "LeoLabs" },
  { domain: "keeptrack.space", type: "press", note: "KeepTrack" },
];

export type AllowlistType = "official" | "fcc" | "agency" | "press" | "encyclopedia" | "paper";

export interface AllowlistEntry {
  domain: string;
  type: AllowlistType;
  note: string;
  /** Written into the stored claim when the site's terms require it. */
  attribution?: string;
}

/** The registry type for a URL, or null when the domain is not trusted. */
export function classifyUrl(url: string): AllowlistEntry | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  // Longest match wins, so `licensing.fcc.gov` is not shadowed by `fcc.gov`.
  const matches = ALLOWED_DOMAINS.filter(
    (d) => host === d.domain || host.endsWith(`.${d.domain}`),
  ).sort((a, b) => b.domain.length - a.domain.length);
  return matches[0] ?? null;
}

/**
 * Does `robots.txt` forbid this path for a generic crawler?
 *
 * Only the `*` and our own user-agent groups are read. A site that disallows
 * everything for everyone is respected; a site that only blocks a named commercial
 * crawler is not our concern, and pretending otherwise would stop us using pages the
 * owner has plainly left open.
 *
 * Failures return "allowed": an unreachable robots.txt is not a prohibition, and
 * treating a timeout as a refusal would silently halve the crawl.
 */
export async function robotsAllows(url: string): Promise<{ allowed: boolean; reason?: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { allowed: false, reason: "URL 无法解析" };
  }
  const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;

  let body: string;
  try {
    const res = await fetch(robotsUrl, {
      headers: { "accept-encoding": ACCEPT_ENCODING },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { allowed: true };
    body = await res.text();
  } catch {
    return { allowed: true };
  }

  let inOurGroup = false;
  const disallows: string[] = [];

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.split("#")[0]!.trim();
    if (line === "") continue;
    const [keyRaw, ...rest] = line.split(":");
    const key = (keyRaw ?? "").trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      const ua = value.toLowerCase();
      inOurGroup = ua === "*" || ua.includes("spacesafety");
    } else if (key === "disallow" && inOurGroup && value !== "") {
      disallows.push(value);
    }
  }

  const path = u.pathname || "/";
  for (const rule of disallows) {
    if (rule === "/") return { allowed: false, reason: "robots.txt 禁止全站抓取" };
    const pattern = rule.replace(/\*/g, "").replace(/\$$/, "");
    if (pattern && path.startsWith(pattern)) {
      return { allowed: false, reason: `robots.txt 禁止 ${rule}` };
    }
  }

  return { allowed: true };
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  text: string;
  type: AllowlistType;
  note: string;
  /** Credit line the site's terms require, when they do. */
  attribution?: string;
  /** Characters of extracted text, before truncation for the model. */
  length: number;
}

/**
 * Fetch a page, refusing anything outside the allowlist.
 *
 * Redirects are followed by `fetch` itself, so `finalUrl` is re-checked: a trusted
 * domain that redirects to an untrusted one must not sneak past.
 */
export async function fetchPage(url: string): Promise<FetchedPage> {
  const entry = classifyUrl(url);
  if (!entry) throw new Error(`域名不在白名单：${new URL(url).hostname}`);

  const robots = await robotsAllows(url);
  if (!robots.allowed) throw new Error(robots.reason ?? "robots.txt 拒绝");

  const res = await fetch(url, {
    headers: {
      // A plain browser UA: several of these sites return a challenge page without
      // one, and the extracted text would then describe the challenge, not the satellite.
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      // Small pages, but the rule is the same as on the bulk paths: ask for gzip.
      "accept-encoding": ACCEPT_ENCODING,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);

  const finalUrl = res.url || url;
  const finalEntry = classifyUrl(finalUrl);
  if (!finalEntry) throw new Error(`重定向到非白名单域名：${new URL(finalUrl).hostname}`);

  const html = await res.text();
  const text = htmlToText(html);

  return {
    url,
    finalUrl,
    text,
    type: finalEntry.type,
    note: finalEntry.note,
    attribution: finalEntry.attribution,
    length: text.length,
  };
}

/**
 * Reduce HTML to readable text.
 *
 * Not a parser: a full DOM would be correct but adds a dependency for a task that
 * only needs "the prose, without the chrome". Script, style, nav and footer blocks
 * are removed wholesale; everything else keeps its text with tags stripped and
 * entities decoded.
 */
export function htmlToText(html: string): string {
  let s = html;

  // Whole elements that never contain article prose.
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<svg\b[\s\S]*?<\/svg>/gi, " ");
  s = s.replace(/<nav\b[\s\S]*?<\/nav>/gi, " ");
  s = s.replace(/<footer\b[\s\S]*?<\/footer>/gi, " ");
  s = s.replace(/<header\b[\s\S]*?<\/header>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  // Block-level tags become paragraph breaks so sentences do not run together.
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");

  s = s.replace(/<[^>]+>/g, " ");

  s = decodeEntities(s);

  // Collapse runs of blank lines and horizontal space, keeping paragraph structure.
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");

  return s;
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    rsquo: "'",
    lsquo: "'",
    rdquo: '"',
    ldquo: '"',
    deg: "°",
    sup2: "²",
    sup3: "³",
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
}

/**
 * Trim a page to the region most likely to describe the object.
 *
 * Press pages put the article after a long menu and a wall of "related stories".
 * Looking for the object's name and keeping a window around it is crude but keeps
 * the token cost down without dropping the relevant paragraph.
 */
export function focusOn(text: string, needle: string, window = 12_000): string {
  if (text.length <= window) return text;
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return text.slice(0, window);
  const start = Math.max(0, idx - Math.floor(window / 3));
  return text.slice(start, start + window);
}
