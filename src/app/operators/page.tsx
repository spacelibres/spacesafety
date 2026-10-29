import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { getTranslator } from "@/lib/i18n/registry";
import { listOperators } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function OperatorsPage() {
  const rows = listOperators();
  const t = await getTranslator();

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

        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.name")}</th>
                  <th>{t.t("operator.emailColumn")}</th>
                  <th>{t.t("operator.phone")}</th>
                  <th className="num">{t.t("operator.maxObjects")}</th>
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
