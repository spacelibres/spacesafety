"use client";

import Link from "next/link";
import { useEffect } from "react";

import { useTranslator } from "@/lib/i18n/client";

/**
 * The error boundary for every route.
 *
 * A thrown page previously surfaced as Next's default error screen — English,
 * unstyled, and with no digest a reader could quote. Here the digest is shown as
 * `correlation_id` (the same identifier the server logs), because "it broke" is
 * not a report anyone can act on.
 *
 * `reset()` retries the segment; the home link is there for the case where the
 * failure is deterministic.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslator();

  useEffect(() => {
    // Keep the console copy: the visible one is for the reader, this one is for
    // whoever they forward the report to.
    console.error("[route error]", error.digest ?? "(no digest)", error.message);
  }, [error]);

  return (
    <div className="content" style={{ paddingTop: 24 }}>
      <div className="page-head">
        <h1 className="page-title">{t.t("errorPage.title")}</h1>
        {error.digest ? <span className="count mono">{error.digest}</span> : null}
      </div>
      <div className="card">
        <div className="card-body">
          <p style={{ marginTop: 0 }}>{t.t("errorPage.body")}</p>
          <pre className="doc-pre" style={{ maxHeight: 120 }}>
            <code className="mono-sm">{error.message}</code>
          </pre>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" type="button" onClick={reset}>
              {t.t("errorPage.retry")}
            </button>
            <Link className="btn" href="/">
              {t.t("errorPage.home")}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
