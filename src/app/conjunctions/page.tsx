import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { getTranslator } from "@/lib/i18n/registry";
import { listConjunctions, riskThresholds } from "@/lib/queries";
import { countdownTo } from "@/lib/space-safety/gps";

export const dynamic = "force-dynamic";

export default async function ConjunctionsPage() {
  const rows = listConjunctions(200);
  const limits = riskThresholds();
  const t = await getTranslator();

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
            {t.t("conjunctionsPage.activeCount", { count: rows.length })}
          </span>
        </div>

        <div className="filters">
          <button
            className="filter-btn"
            title={t.t("filter.title")}
            aria-label={t.t("filter.title")}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3 4h18l-7 8v6l-4-2v-8z" />
            </svg>
          </button>
          <div className="filter-group">
            <span>{t.t("filter.risk")}</span>
            <select defaultValue="">
              <option value="">{t.t("filter.any")}</option>
              <option value="high">{t.t("filter.high")}</option>
              <option value="medium">{t.t("filter.medium")}</option>
              <option value="low">{t.t("filter.low")}</option>
            </select>
          </div>
          <div className="filter-group">
            <span>{t.t("filter.isActive")}</span>
            <select defaultValue="true">
              <option value="true">{t.t("filter.true")}</option>
              <option value="false">{t.t("filter.false")}</option>
            </select>
          </div>
        </div>

        <div className="card">
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
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.eventId ? (
                        <Link href={`/conjunctions/${c.eventId}`}>
                          {c.eventId.slice(0, 8)}
                        </Link>
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
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="empty">
                      {t.t("conjunctionsPage.empty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
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
