import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { getTranslator } from "@/lib/i18n/registry";
import { listTrajectories } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function TrajectoriesPage() {
  const t = await getTranslator();
  const rows = listTrajectories(200);

  return (
    <>
      <Topbar section={t.t("nav.trajectories")} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t.t("trajectoriesPage.title")}</h1>
          <span className="count">
            {t.t("trajectoriesPage.summary", { count: t.number(rows.length) })}
          </span>
        </div>

        <div className="filters">
          <button
            className="filter-btn"
            title={t.t("filter.title")}
            aria-label={t.t("filter.title")}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3 4h18l-7 8v6l-4 2v-8z" />
            </svg>
          </button>
          <div className="filter-group">
            <span>{t.t("column.type")}</span>
            <select defaultValue="">
              <option value="equals">{t.t("filter.equals")}</option>
            </select>
            <select defaultValue="">
              <option value="">{t.t("filter.any")}</option>
              <option value="definitive">{t.t("filter.type.definitive")}</option>
              <option value="hypothetical">{t.t("filter.type.hypothetical")}</option>
              <option value="candidate">{t.t("filter.type.candidate")}</option>
            </select>
          </div>
          <div className="filter-group">
            <span>{t.t("column.status")}</span>
            <select defaultValue="">
              <option value="">{t.t("filter.any")}</option>
              <option value="screened">{t.t("filter.status.screened")}</option>
              <option value="not_screened">{t.t("filter.status.notScreened")}</option>
              <option value="superseded">{t.t("filter.status.superseded")}</option>
            </select>
          </div>
        </div>

        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.id")}</th>
                  <th>{t.t("column.object")}</th>
                  <th>{t.t("column.operator")}</th>
                  <th>{t.t("column.type")}</th>
                  <th>{t.t("column.stateSource")}</th>
                  <th>{t.t("column.screenedStatus")}</th>
                  <th>{t.t("trajectory.format")}</th>
                  <th className="num">{t.t("column.points")}</th>
                  <th>{t.t("column.uploadedAt")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/trajectories/${row.id}`}>
                        {row.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td>{row.objectName}</td>
                    <td className="muted">{row.operatorName}</td>
                    <td>
                      <span className="chip neutral">
                        {t.t(`common.uploadType.${row.uploadType}`)}
                      </span>
                    </td>
                    <td>
                      <span className={`chip ${row.stateSource}`}>{row.stateSource}</span>
                    </td>
                    <td>
                      <span className={`chip ${statusClass(row.screenedStatus)}`}>
                        {t.t(`common.screenedStatus.${row.screenedStatus}`)}
                      </span>
                    </td>
                    <td className="mono-sm faint">{row.format}</td>
                    <td className="num">{t.number(row.pointCount)}</td>
                    <td className="mono-sm">{fmt(row.uploadedAt)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="empty">
                      <code className="mono">
                        {t.t("trajectoriesPage.emptyBefore", {
                          api: "POST /api/v1/trajectory",
                        })}
                      </code>
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

function statusClass(status: string): string {
  if (status === "screened") return "true";
  if (status === "not_screened") return "neutral";
  return "false";
}

function fmt(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, "");
}
