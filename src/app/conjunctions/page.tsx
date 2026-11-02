import Link from "next/link";

import { DownloadMenu } from "@/components/DownloadMenu";
import { Topbar } from "@/components/Shell";
import { SortableTh } from "@/components/SortableTh";
import { getTranslator } from "@/lib/i18n/registry";
import {
  CONJUNCTION_SORTS,
  listConjunctions,
  listPublishedConjunctions,
  publishedMessageCount,
  riskThresholds,
  type RiskBand,
} from "@/lib/queries";
import { parseSort } from "@/lib/sort";
import { pageMetadata } from "@/lib/i18n/page-title";
import type { Metadata } from "next";
import { countdownTo, countdownToIso } from "@/lib/space-safety/gps";

export const dynamic = "force-dynamic";

/** Rows shown per band. The full set is ~500; a page is not a database dump. */
const LIMIT = 200;

/**
 * Conjunctions.
 *
 * ## Two sources, one page, never merged silently
 *
 * The list a reader expects here is *our* screening output — an operator uploads
 * an ephemeris, the worker screens it, and the resulting CDMs appear. This
 * deployment has no uploaded ephemerides, so that table is genuinely empty.
 *
 * What does exist is 3 164 publicly published CDMs from the 18th Space Defense
 * Squadron, describing **509** conjunctions between catalogue objects. Those sat
 * in their own table and were shown nowhere: the page rendered an empty grid while
 * usable data went unread.
 *
 * They are shown in their own section, with their own provenance line, because
 * they are not the same claim: a public CDM has no covariance, no manoeuvre plan
 * and no operator claim, so it cannot be re-screened as if it were ours. Merging
 * the two into one grid without a source column would misrepresent both.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return pageMetadata(t, t.t("conjunctionsPage.title"));
}

export default async function ConjunctionsPage({
  searchParams,
}: {
  searchParams: Promise<{ risk?: string; upcoming?: string; sort?: string; dir?: string }>;
}) {
  const sp = await searchParams;
  const limits = riskThresholds();
  const t = await getTranslator();

  const sort = parseSort(sp, CONJUNCTION_SORTS, { key: "pc", dir: "desc" });
  const sorted = sp.sort !== undefined;
  // One query, then filter/slice in memory: the whole set is ~500 rows, so a
  // separate count query per band would be three round-trips for the same data.
  const published = listPublishedConjunctions(100_000, new Date(), sorted ? sort : undefined);
  const own = listConjunctions(LIMIT);
  // The conjunction and upcoming totals are already in `published` (it is the whole
  // set); only the message total needs a query, and it needs a cheap one. Asking
  // `publishedConjunctionCounts()` here re-ran the clustering above for the same
  // numbers — 42 ms per request to recompute what was just computed.
  const counts = {
    messages: publishedMessageCount(),
    conjunctions: published.length,
    upcoming: published.filter((c) => c.tcaInFuture).length,
  };

  const BANDS = ["high", "medium", "low", "unknown"] as const;
  const requested = sp.risk;
  const active: "all" | RiskBand =
    requested !== undefined && (BANDS as readonly string[]).includes(requested)
      ? (requested as RiskBand)
      : "all";
  const inBand = (band: "all" | RiskBand) =>
    band === "all" ? published : published.filter((c) => c.band === band);
  // "Still ahead" is a different question from "which band", and it is the one
  // that decides whether a row is actionable, so it gets its own control.
  const onlyUpcoming = sp.upcoming === "1";
  const exportQuery = new URLSearchParams({ what: "conjunctions" });
  if (onlyUpcoming) exportQuery.set("upcoming", "1");

  const matched = inBand(active).filter((c) => (onlyUpcoming ? c.tcaInFuture : true));
  const visible = matched.slice(0, LIMIT);

  // `unknown` is a band here, not an error: 22 conjunctions arrive without a Pc
  // at all, and a filter that silently cannot reach them would hide them.
  const bands: Array<{ key: "all" | RiskBand; label: string }> = [
    { key: "all", label: t.t("filter.any") },
    { key: "high", label: t.t("filter.high") },
    { key: "medium", label: t.t("filter.medium") },
    { key: "low", label: t.t("filter.low") },
    { key: "unknown", label: t.t("risk.unknown") },
  ];

  return (
    <>
      <Topbar section={t.t("nav.conjunctions")} />
      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">{t.t("conjunctionsPage.title")}</h1>
            <span className="page-sub">
              {t.t("conjunctionsPage.summary", {
                high: limits.high.toExponential(0),
                medium: limits.medium.toExponential(0),
              })}
            </span>
          </div>
          <span className="count">
            {t.t("conjunctionsPage.publishedCount", {
              conjunctions: counts.conjunctions,
              messages: counts.messages,
              upcoming: counts.upcoming,
            })}
          </span>
          <DownloadMenu
            label={t.t("download.label")}
            items={[
              { label: t.t("download.csv"), href: `/api/export?${exportQuery.toString()}&format=csv` },
              { label: t.t("download.json"), href: `/api/export?${exportQuery.toString()}&format=json` },
            ]}
          />
        </div>

        <div className="banner info" style={{ marginBottom: 12 }}>
          {t.t("conjunctionsPage.publishedNote")}
        </div>

        <div className="filters">
          {bands.map((band) => {
            const query = new URLSearchParams();
            if (band.key !== "all") query.set("risk", band.key);
            if (onlyUpcoming) query.set("upcoming", "1");
            const value = query.toString();
            return (
              <Link
                key={band.key}
                href={value ? `/conjunctions?${value}` : "/conjunctions"}
                className={`btn${active === band.key ? " is-on" : ""}`}
              >
                {band.label}
                <span className="faint"> {inBand(band.key).length}</span>
              </Link>
            );
          })}
          <Link
            href={
              onlyUpcoming
                ? active === "all"
                  ? "/conjunctions"
                  : `/conjunctions?risk=${active}`
                : active === "all"
                  ? "/conjunctions?upcoming=1"
                  : `/conjunctions?risk=${active}&upcoming=1`
            }
            className={`btn${onlyUpcoming ? " is-on" : ""}`}
          >
            {t.t("filter.upcomingOnly")}
            <span className="faint"> {published.filter((c) => c.tcaInFuture).length}</span>
          </Link>
        </div>

        {matched.length > visible.length && (
          <p className="faint" style={{ margin: "0 0 8px", fontSize: 12 }}>
            {t.t("conjunctionsPage.truncated", {
              shown: visible.length,
              total: matched.length,
            })}
          </p>
        )}

        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.cdm")}</th>
                  <th>{t.t("column.object1")}</th>
                  <th>{t.t("column.object2")}</th>
                  <SortableTh
                    label={t.t("column.missDistance")}
                    column="miss"
                    current={sort}
                    pathname="/conjunctions"
                    params={sp}
                    className="num"
                  />
                  <SortableTh
                    label={t.t("column.pc")}
                    column="pc"
                    current={sort}
                    pathname="/conjunctions"
                    params={sp}
                    className="num"
                  />
                  <SortableTh
                    label={t.t("column.tca")}
                    column="tca"
                    current={sort}
                    pathname="/conjunctions"
                    params={sp}
                  />
                  <th>{t.t("column.countdown")}</th>
                  <th>{t.t("column.risk")}</th>
                  <SortableTh
                    label={t.t("column.messages")}
                    column="messages"
                    current={sort}
                    pathname="/conjunctions"
                    params={sp}
                    className="num"
                  />
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.cdmId}>
                    <td className="mono-sm">
                      <Link href={`/conjunctions/${c.cdmId}`}>{c.cdmId}</Link>
                    </td>
                    <td>
                      {c.object1Name}
                      <span className="faint mono-sm"> {c.object1Norad}</span>
                    </td>
                    <td>
                      {c.object2Name}
                      <span className="faint mono-sm"> {c.object2Norad}</span>
                    </td>
                    <td className="num mono-sm">
                      {c.minRangeKm === null ? t.t("common.none") : `${c.minRangeKm.toFixed(1)} km`}
                    </td>
                    <td className={`num pc ${c.band}`}>{t.probability(c.pc ?? NaN)}</td>
                    <td className="mono-sm">{fmt(c.tcaIso, t.t("common.none"))}</td>
                    <td className="mono-sm faint">
                      {countdownToIso(c.tcaIso) ?? t.t("common.none")}
                    </td>
                    <td>
                      <span className={`chip risk-${c.band}`}>
                        {t.t(`risk.${c.band}`).toUpperCase()}
                      </span>
                    </td>
                    <td className="num mono-sm faint">{c.messageCount}</td>
                  </tr>
                ))}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={9} className="empty">
                      {/* A band with no rows is not the same statement as "nothing
                          has been published": 中/低 are empty by construction
                          because the feed only carries reportable conjunctions. */}
                      {published.length === 0
                        ? t.t("conjunctionsPage.empty")
                        : t.t("common.empty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="page-head section-head" style={{ marginTop: 22 }}>
          <h2 className="page-title">{t.t("conjunctionsPage.ownTitle")}</h2>
        </div>
        <div className="card">
          {own.length === 0 ? (
            <div className="card-body">
              <p className="note">{t.t("conjunctionsPage.ownEmpty")}</p>
            </div>
          ) : (
            <div className="table-wrap" style={{ borderTop: "none" }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>{t.t("column.event")}</th>
                    <th>{t.t("column.object1")}</th>
                    <th>{t.t("column.operator1")}</th>
                    <th>{t.t("column.object2")}</th>
                    <th>{t.t("column.operator2")}</th>
                    <th className="num">{t.t("column.pc")}</th>
                    <th>{t.t("column.tca")}</th>
                    <th>{t.t("column.countdown")}</th>
                    <th>{t.t("column.risk")}</th>
                  </tr>
                </thead>
                <tbody>
                  {own.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.eventId ? (
                          <Link href={`/conjunctions/${c.eventId}`}>{c.eventId.slice(0, 8)}</Link>
                        ) : (
                          <span className="faint">{t.t("common.none")}</span>
                        )}
                      </td>
                      <td>{c.object1Name}</td>
                      <td className="muted">{c.operator1Name}</td>
                      <td>{c.object2Name}</td>
                      <td className="muted">{c.operator2Name}</td>
                      <td className={`num pc ${c.band}`}>{t.probability(c.pc ?? NaN)}</td>
                      <td className="mono-sm">{fmt(c.tcaIso, t.t("common.none"))}</td>
                      <td className="mono-sm faint">
                        {c.tcaGpsNanos ? countdownTo(c.tcaGpsNanos) : t.t("common.none")}
                      </td>
                      <td>
                        <span className={`chip risk-${c.band}`}>
                          {t.t(`risk.${c.band}`).toUpperCase()}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** ISO-8601 to a space-separated UTC stamp; `dash` when absent. */
function fmt(iso: string | null, dash: string): string {
  if (!iso) return dash;
  return iso.replace("T", " ").replace(/\.\d+Z$/, "");
}
