import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { SortableTh } from "@/components/SortableTh";
import { getTranslator } from "@/lib/i18n/registry";
import { listOperators, OPERATOR_SORTS } from "@/lib/queries";
import { parseSort } from "@/lib/sort";

export const dynamic = "force-dynamic";

export default async function OperatorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const t = await getTranslator();
  const sort = parseSort(sp, OPERATOR_SORTS, { key: "name", dir: "asc" });
  const all = listOperators(sort);
  // Filtering happens here rather than in SQL: the operator list is a handful of
  // rows on this deployment, and a LIKE pattern is what "contains" means anyway.
  const needle = sp.q?.trim().toLowerCase();
  const rows = needle ? all.filter((o) => o.name.toLowerCase().includes(needle)) : all;

  return (
    <>
      <Topbar section={t.t("nav.operators")} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t.t("operator.title")}</h1>
          <span className="count">
            {t.t("operator.count", { count: rows.length })}
          </span>
        </div>

        {/* The official list pages all carry a filter bar; this one had none. */}
        <form className="filters" method="get">
          <div className="filter-group">
            <span>{t.t("column.name")}</span>
            <select defaultValue="contains" aria-label={t.t("filter.contains")} disabled>
              <option value="contains">{t.t("filter.contains")}</option>
            </select>
            <input name="q" defaultValue={sp.q ?? ""} aria-label={t.t("operator.searchLabel")} />
          </div>
          <button className="btn" type="submit">
            {t.t("filter.apply")}
          </button>
          <Link className="btn" href="/operators">
            {t.t("filter.reset")}
          </Link>
          <div className="filters-spacer" />
        </form>

        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <SortableTh
                    label={t.t("column.name")}
                    column="name"
                    current={sort}
                    pathname="/operators"
                    params={sp}
                  />
                  <SortableTh
                    label={t.t("operator.emailColumn")}
                    column="email"
                    current={sort}
                    pathname="/operators"
                    params={sp}
                  />
                  <th>{t.t("operator.phone")}</th>
                  <SortableTh
                    label={t.t("operator.maxObjects")}
                    column="maxObjects"
                    current={sort}
                    pathname="/operators"
                    params={sp}
                    className="num"
                  />
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/operators/${o.id}`}>{o.name}</Link>
                    </td>
                    <td className="mono-sm muted">{o.email || t.t("common.none")}</td>
                    <td className="mono-sm muted">{o.phone || t.t("common.none")}</td>
                    <td className="num">{o.maxObjects}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      {t.t("operator.empty")}
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
