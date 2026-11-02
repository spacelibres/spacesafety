import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { SortableTh } from "@/components/SortableTh";
import { getTranslator } from "@/lib/i18n/registry";
import { listTrajectories, TRAJECTORY_SORTS, type TrajectoryFilters } from "@/lib/queries";
import { parseSort } from "@/lib/sort";
import { pageMetadata } from "@/lib/i18n/page-title";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return pageMetadata(t, t.t("trajectoriesPage.title"));
}

export default async function TrajectoriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const t = await getTranslator();
  const sort = parseSort(sp, TRAJECTORY_SORTS, { key: "uploadedAt", dir: "desc" });
  // The query rejects values outside the official enums, so a typo narrows to
  // nothing rather than silently returning the whole table.
  const filters: TrajectoryFilters = {
    uploadType: sp.upload_type || undefined,
    stateSource: sp.state_source || undefined,
    screenedStatus: sp.status || undefined,
  };
  const rows = listTrajectories(200, sort, filters);

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

        {/* Real GET form: these selects previously had no `name` and no form, so
            they changed nothing. */}
        <form className="filters" method="get">
          <button
            className="filter-btn"
            type="button"
            title={t.t("filter.title")}
            aria-label={t.t("filter.title")}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3 4h18l-7 8v6l-4 2v-8z" />
            </svg>
          </button>
          <div className="filter-group">
            <span>{t.t("column.type")}</span>
            <select aria-label={t.t("filter.equals")} disabled>
              <option value="equals">{t.t("filter.equals")}</option>
            </select>
            <select name="upload_type" defaultValue={sp.upload_type ?? ""} aria-label={t.t("column.type")}>
              <option value="">{t.t("filter.any")}</option>
              <option value="definitive">{t.t("filter.type.definitive")}</option>
              <option value="hypothetical">{t.t("filter.type.hypothetical")}</option>
              <option value="candidate">{t.t("filter.type.candidate")}</option>
            </select>
          </div>
          <div className="filter-group">
            <span>{t.t("column.status")}</span>
            <select name="status" defaultValue={sp.status ?? ""} aria-label={t.t("column.status")}>
              <option value="">{t.t("filter.any")}</option>
              <option value="screened">{t.t("filter.status.screened")}</option>
              <option value="not_screened">{t.t("filter.status.notScreened")}</option>
              <option value="superseded">{t.t("filter.status.superseded")}</option>
            </select>
          </div>
          <button className="btn" type="submit">
            {t.t("filter.apply")}
          </button>
          <Link className="btn" href="/trajectories">
            {t.t("filter.reset")}
          </Link>
          <div className="filters-spacer" />
        </form>

        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.id")}</th>
                  <SortableTh
                    label={t.t("column.object")}
                    column="objectName"
                    current={sort}
                    pathname="/trajectories"
                    params={sp}
                  />
                  <th>{t.t("column.operator")}</th>
                  <SortableTh
                    label={t.t("column.type")}
                    column="uploadType"
                    current={sort}
                    pathname="/trajectories"
                    params={sp}
                  />
                  <SortableTh
                    label={t.t("column.stateSource")}
                    column="stateSource"
                    current={sort}
                    pathname="/trajectories"
                    params={sp}
                  />
                  <SortableTh
                    label={t.t("column.screenedStatus")}
                    column="screenedStatus"
                    current={sort}
                    pathname="/trajectories"
                    params={sp}
                  />
                  <th>{t.t("trajectory.format")}</th>
                  <SortableTh
                    label={t.t("column.points")}
                    column="pointCount"
                    current={sort}
                    pathname="/trajectories"
                    params={sp}
                    className="num"
                  />
                  <SortableTh
                    label={t.t("column.uploadedAt")}
                    column="uploadedAt"
                    current={sort}
                    pathname="/trajectories"
                    params={sp}
                  />
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
