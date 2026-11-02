import type { Metadata } from "next";

import type { Translator } from "@/lib/i18n";

/**
 * Per-page `<title>` and description.
 *
 * Every page used to inherit the layout's title, so the browser tab, the history
 * entry and the bookmark all read "太空之眼" regardless of what was open. A reader
 * with six conjunction tabs cannot tell them apart, which is the concrete harm —
 * not the missing metadata per se.
 *
 * The pattern is `"<detail> · <site>"`, with the site name dropped when there is
 * nothing to qualify.
 */
export async function pageMetadata(
  t: Translator,
  detail: string | null,
  description?: string,
): Promise<Metadata> {
  const site = t.t("app.name");
  const title = detail ? `${detail} · ${site}` : site;
  return {
    title,
    description: description ?? `${t.t("app.tagline")} — space-safety.starlink.com replica`,
    // Object names, trajectories and conjunctions are per-request data; there is
    // nothing here for a crawler to index that the list pages do not say better.
    robots: detail ? { index: false, follow: true } : undefined,
  };
}
