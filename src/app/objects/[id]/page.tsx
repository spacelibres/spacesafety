import Link from "next/link";
import { notFound } from "next/navigation";

import { AccuracyPanels } from "@/components/AccuracyPanels";
import { CataloguePanel } from "@/components/CataloguePanel";
import { Topbar } from "@/components/Shell";
import { buildAccuracyReport } from "@/lib/core/accuracy-report";
import { getDb } from "@/db";
import { cdms, trajectoryFiles, trajectories } from "@/db/schema";
import { getTranslator } from "@/lib/i18n/registry";
import { listObjects } from "@/lib/queries";
import { eq, or } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function ObjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslator();
  const object = listObjects(1000).find((o) => o.id === id);
  if (!object) notFound();

  const { db } = getDb();

  // The accuracy report parses the stored files, so this read does need the text;
  // it is scoped to one object, so the cost stays bounded.
  const objectTrajectories = db
    // All metadata columns, plus the file text from its own table.
    .select({ t: trajectories, fileText: trajectoryFiles.fileText })
    .from(trajectories)
    .innerJoin(trajectoryFiles, eq(trajectoryFiles.trajectoryId, trajectories.id))
    .where(eq(trajectories.objectId, id))
    .all()
    .map((r: { t: typeof trajectories.$inferSelect; fileText: string }) => ({
      ...r.t,
      fileText: r.fileText,
    }))
    .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));

  const conjunctions = db
    .select()
    .from(cdms)
    .where(or(eq(cdms.object1Id, id), eq(cdms.object2Id, id)))
    .all()
    .filter((c) => c.isActive);

  // Prediction accuracy needs at least two uploads: the newest is truth.
  const accuracy = buildAccuracyReport(
    objectTrajectories.map((traj) => ({
      text: traj.fileText,
      format: traj.fileFormat,
      uploadedAt: traj.uploadedAt,
    })),
    { axis: "R", horizonHours: 3 },
  );

  return (
    <>
      <Topbar section={t.t("nav.objects")} entityId={object.id} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{object.objectName}</h1>
          <Link className="btn" href="/objects">
            {t.t("common.backArrow")}
          </Link>
        </div>

        <div className="meta-strip">
          <div className="meta-cell">
            <div className="meta-label">{t.t("column.noradId")}</div>
            <div className="meta-value">{object.noradId ?? t.t("common.none")}</div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">{t.t("column.hardBodyRadius")}</div>
            <div className="meta-value">
              {t.number(object.hardBodyRadius, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">{t.t("object.trajectories")}</div>
            <div className="meta-value">{t.number(objectTrajectories.length)}</div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">{t.t("object.activeConjunctions")}</div>
            <div className="meta-value">{t.number(conjunctions.length)}</div>
          </div>
        </div>

        <div className="grid-2" style={{ marginBottom: 16 }}>
          <CataloguePanel noradId={object.noradId ?? null} objectId={object.id} />
          <section className="card">
            <div className="card-head">{t.t("object.details")}</div>
            <table className="kv">
              <tbody>
                <tr>
                  <td className="k">{t.t("column.operator")}</td>
                  <td>{object.operatorName}</td>
                </tr>
                <tr>
                  <td className="k">{t.t("column.objectName")}</td>
                  <td>{object.objectName}</td>
                </tr>
                <tr>
                  <td className="k">{t.t("column.noradId")}</td>
                  <td className="v-mono">{object.noradId ?? t.t("common.none")}</td>
                </tr>
                <tr>
                  <td className="k">{t.t("column.alive")}</td>
                  <td>
                    <span className={`chip ${object.alive}`}>{String(object.alive)}</span>
                  </td>
                </tr>
                <tr>
                  <td className="k">{t.t("column.maneuverable")}</td>
                  <td>
                    <span className={`chip ${object.maneuverability}`}>
                      {String(object.maneuverability)}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="k">{t.t("column.hardBodyRadius")}</td>
                  <td className="v-mono">
                    {t.number(object.hardBodyRadius, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="card">
            <div className="card-head">
              <span>{t.t("object.upcomingConjunctions")}</span>
              <span className="count">
                {t.t("object.activeCount", { count: t.number(conjunctions.length) })}
              </span>
            </div>
            <div className="table-wrap" style={{ borderTop: "none" }}>
              {conjunctions.length === 0 ? (
                <div className="empty">{t.t("object.noActiveConjunctions")}</div>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t.t("object.otherObject")}</th>
                      <th className="num">{t.t("column.pc")}</th>
                      <th>{t.t("column.event")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {conjunctions.map((c) => {
                      const other =
                        c.object1Id === id ? c.object2Name : c.object1Name;
                      return (
                        <tr key={c.id}>
                          <td>{other}</td>
                          <td className="num pc">
                            {c.probabilityOfCollision != null
                              ? t.probability(c.probabilityOfCollision)
                              : "NULL"}
                          </td>
                          <td>
                            {c.eventId ? (
                              <Link
                                href={`/conjunctions/${c.eventId}`}
                                className="mono-sm"
                              >
                                {c.eventId.slice(0, 8)}
                              </Link>
                            ) : (
                              <span className="faint">{t.t("common.none")}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>

        <section className="card">
          <div className="card-head">
            <span>{t.t("object.trajectories")}</span>
            <span className="count">
              {t.t("object.uploadCount", { count: t.number(objectTrajectories.length) })}
            </span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.id")}</th>
                  <th>{t.t("column.type")}</th>
                  <th>{t.t("column.stateSource")}</th>
                  <th>{t.t("column.screenedStatus")}</th>
                  <th className="num">{t.t("column.points")}</th>
                  <th>{t.t("column.uploadedAt")}</th>
                </tr>
              </thead>
              <tbody>
                {objectTrajectories.map((traj) => (
                  <tr key={traj.id}>
                    <td>
                      <Link href={`/trajectories/${traj.id}`} className="mono-sm">
                        {traj.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td>
                      <span className="chip neutral">{traj.uploadType}</span>
                    </td>
                    <td>
                      <span className={`chip ${traj.stateSource}`}>{traj.stateSource}</span>
                    </td>
                    <td>
                      <span
                        className={`chip ${
                          traj.screenedStatus === "screened" ? "true" : "neutral"
                        }`}
                      >
                        {traj.screenedStatus}
                      </span>
                    </td>
                    <td className="num">{t.number(traj.pointCount)}</td>
                    <td className="mono-sm">
                      {traj.uploadedAt.replace("T", " ").replace(/\.\d+Z$/, "")}
                    </td>
                  </tr>
                ))}
                {objectTrajectories.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">
                      {t.t("object.noObjectTrajectories")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <div className="page-head" style={{ marginTop: 28 }}>
          <div>
            <h2 className="page-title" style={{ fontSize: 20 }}>
              {t.t("object.predictionAccuracy")}
            </h2>
            <span className="page-sub">{t.t("object.accuracyCaption")}</span>
          </div>
        </div>

        <AccuracyPanels report={accuracy} />
      </div>
    </>
  );
}
