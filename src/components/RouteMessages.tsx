"use client";

import Link from "next/link";

import { useTranslator } from "@/lib/i18n/client";

/**
 * The 404 and error bodies.
 *
 * ## Why these are client components
 *
 * Next delivers a `notFound()` triggered inside a dynamic page as an RSC payload
 * the browser renders, not as server HTML: the HTML body arrives as
 * `<div hidden></div>` and the content is in the flight script. A **server**
 * component that reads cookies (which `not-found.tsx` did, via the translator)
 * cannot be re-rendered from that payload, so the div stayed hidden and the reader
 * got a blank page with a 404 status — correct for a crawler, useless for a person.
 *
 * Reading the dictionary on the client removes that constraint: `useTranslator()`
 * is available as soon as the provider hydrates, which is the same moment the
 * payload is rendered.
 */

export function NotFoundBody() {
  const t = useTranslator();
  return (
    <div className="card">
      <div className="card-body">
        <p style={{ marginTop: 0 }}>{t.t("notFound.body")}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link className="btn" href="/">
            {t.t("notFound.home")}
          </Link>
          <Link className="btn" href="/catalogue">
            {t.t("notFound.catalogue")}
          </Link>
        </div>
      </div>
    </div>
  );
}

export function NotFoundHeading() {
  const t = useTranslator();
  return <span className="count">{t.t("notFound.title")}</span>;
}
