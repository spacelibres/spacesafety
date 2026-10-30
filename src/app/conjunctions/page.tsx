import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { getTranslator } from "@/lib/i18n/registry";
import {
  listConjunctions,
  listPublishedConjunctions,
  publishedConjunctionCounts,
  riskThresholds,
  type RiskBand,
} from "@/lib/queries";
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
export default async function ConjunctionsPage({
  searchParams,
}: {
  searchParams: Promise<{ risk?: string }>;
}) {
  const sp = await searchParams;
  const limits = riskThresholds();
  const t = await getTranslator();

  const counts = publishedConjunctionCounts();
  // One query, then filter/slice in memory: the whole set is ~500 rows, so a
  // separate count query per band would be three round-trips for the same data.
  const published = listPublishedConjunctions(100_000);
  const own = listConjunctions(LIMIT);

  const BANDS = ["high", "medium", "low", "unknown"] as const;
  const requested = sp.risk;
  const active: "all" | RiskBand =
    requested !== undefined && (BANDS as readonly string[]).includes(requested)
      ? (requested as RiskBand)
      : "all";
  const inBand = (band: "all" | RiskBand) =>
    band === "all" ? published : published.filter((c) => c.band === band);
  const matched = inBand(active);
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
        </div>

        <div className="banner info" style={{ marginBottom: 12 }}>
          {t.t("conjunctionsPage.publishedNote")}
        </div>

        <div className="filters">
          {bands.map((band) => (
            <Link
              key={band.key}
              href={band.key === "all" ? "/conjunctions" : `/conjunctions?risk=${band.key}`}
              className={`btn${active === band.key ? " is-on" : ""}`}
            >
              {band.label}
              <span className="faint"> {inBand(band.key).length}</span>
            </Link>
          ))}
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
                  <th className="num">{t.t("column.missDistance")}</th>
                  <th className="num">{t.t("column.pc")}</th>
                  <th>{t.t("column.tca")}</th>
                  <th>{t.t("column.countdown")}</th>
                  <th>{t.t("column.risk")}</th>
                  <th className="num">{t.t("column.messages")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.cdmId}>
                    <td className="mono-sm">{c.cdmId}</td>
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
