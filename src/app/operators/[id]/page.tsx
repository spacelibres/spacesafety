import Link from "next/link";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/Shell";
import { getTranslator } from "@/lib/i18n/registry";
import { listObjects, listOperators } from "@/lib/queries";
import { getDb } from "@/db";
import { trajectories } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function OperatorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslator();
  const operator = listOperators().find((o) => o.id === id);
  if (!operator) notFound();

  const objects = listObjects(1000).filter((o) => o.operatorId === id);
  const { db } = getDb();
  const uploads = db
    .select()
    .from(trajectories)
    .where(eq(trajectories.operatorId, id))
    .all();

  return (
    <>
      <Topbar section={t.t("nav.operators")} entityId={operator.id} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{operator.name}</h1>
          <Link className="btn" href="/operators">
            {t.t("common.backArrow")}
          </Link>
        </div>

        <section className="card" style={{ marginBottom: 16 }}>
          <table className="kv">
            <tbody>
              <tr>
                <td className="k">{t.t("operator.emailColumn")}</td>
                <td className="v-mono">{operator.email || t.t("common.none")}</td>
              </tr>
              <tr>
                <td className="k">{t.t("operator.phone")}</td>
                <td className="v-mono">{operator.phone || t.t("common.none")}</td>
              </tr>
              <tr>
                <td className="k">{t.t("operator.maxObjects")}</td>
                <td className="v-mono">{operator.maxObjects}</td>
              </tr>
              <tr>
                <td className="k">{t.t("operator.objectsRegistered")}</td>
                <td className="v-mono">{objects.length}</td>
              </tr>
              <tr>
                <td className="k">{t.t("operator.trajectoriesUploaded")}</td>
                <td className="v-mono">{uploads.length}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <div className="card">
          <div className="card-head">
            <span>{t.t("operator.objects")}</span>
            <span className="count">
              {t.t("operator.objectsShowing", {
                shown: objects.length,
                allowed: operator.maxObjects,
              })}
            </span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.name")}</th>
                  <th>{t.t("column.noradId")}</th>
                  <th className="num">{t.t("column.hardBodyRadius")}</th>
                  <th>{t.t("column.alive")}</th>
                  <th>{t.t("column.maneuverable")}</th>
                </tr>
              </thead>
              <tbody>
                {objects.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/objects/${o.id}`}>{o.objectName}</Link>
                    </td>
                    <td className="mono-sm muted">{o.noradId ?? t.t("common.none")}</td>
                    <td className="num">{o.hardBodyRadius.toFixed(2)}</td>
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
                {objects.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">
                      {t.t("operator.noObjectsHere")}
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
