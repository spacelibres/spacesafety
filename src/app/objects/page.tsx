import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { getTranslator } from "@/lib/i18n/registry";
import { listObjects } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ObjectsPage() {
  const rows = listObjects(200);
  const t = await getTranslator();

  return (
    <>
      <Topbar section={t.t("nav.objects")} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t.t("objectsPage.title")}</h1>
          <span className="count">
            {t.t("objectsPage.showingCount", { count: rows.length })}
          </span>
        </div>

        <div className="filters">
          <button
            className="filter-btn"
            title={t.t("filter.title")}
            aria-label={t.t("filter.title")}
          >
            <FilterIcon />
          </button>
          <div className="filter-group">
            <span>{t.t("column.alive")}</span>
            <select defaultValue="true">
              <option value="true">{t.t("filter.equals")}</option>
            </select>
            <select defaultValue="true">
              <option value="true">{t.t("filter.true")}</option>
              <option value="false">{t.t("filter.false")}</option>
            </select>
          </div>
          <div className="filter-group">
            <span>{t.t("column.name")}</span>
            <select defaultValue="contains">
              <option value="contains">{t.t("filter.contains")}</option>
            </select>
            <input aria-label={t.t("objectsPage.nameFilter")} />
          </div>
          <div className="filter-group">
            <span>{t.t("column.noradId")}</span>
            <select defaultValue="equals">
              <option value="equals">{t.t("filter.equals")}</option>
            </select>
            <input aria-label={t.t("objectsPage.noradFilter")} />
          </div>
          <div className="filters-spacer" />
          <button
            className="filter-btn"
            title={t.t("objectsPage.columns")}
            aria-label={t.t("objectsPage.columns")}
          >
            <GearIcon />
          </button>
        </div>

        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.name")}</th>
                  <th>{t.t("column.noradId")}</th>
                  <th className="num">{t.t("column.hardBodyRadius")}</th>
                  <th>{t.t("column.operator")}</th>
                  <th>{t.t("column.alive")}</th>
                  <th>{t.t("column.maneuverable")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/objects/${o.id}`}>{o.objectName}</Link>
                    </td>
                    <td className="mono-sm muted">{o.noradId ?? t.t("common.none")}</td>
                    <td className="num">{t.number(o.hardBodyRadius, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}</td>
                    <td className="muted">{o.operatorName}</td>
                    <td>
                      <span className={`chip ${o.alive}`}>{String(o.alive)}</span>
                    </td>
                    <td>
                      <span className={`chip ${o.maneuverability}`}>
                        {String(o.maneuverability)}
                      </span>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">
                      {t.t("objectsPage.empty")}{" "}
                      <code className="mono">{"POST /api/v1/object"}</code>
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

function FilterIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 4h18l-7 8v6l-4 2v-8z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
    </svg>
  );
}
