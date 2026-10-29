import Link from "next/link";
import { notFound } from "next/navigation";

import { AccuracyPanels } from "@/components/AccuracyPanels";
import { CataloguePanel } from "@/components/CataloguePanel";
import { Topbar } from "@/components/Shell";
import { buildAccuracyReport } from "@/lib/core/accuracy-report";
import { getDb } from "@/db";
import { cdms, trajectoryFiles, trajectories } from "@/db/schema";
import { listObjects } from "@/lib/queries";
import { eq, or } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function ObjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
    objectTrajectories.map((t) => ({
      text: t.fileText,
      format: t.fileFormat,
      uploadedAt: t.uploadedAt,
    })),
    { axis: "R", horizonHours: 3 },
  );

  return (
    <>
      <Topbar section="Objects" entityId={object.id} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{object.objectName}</h1>
          <Link className="btn" href="/objects">
            ← back
          </Link>
        </div>

        <div className="meta-strip">
          <div className="meta-cell">
            <div className="meta-label">NORAD Id</div>
            <div className="meta-value">{object.noradId ?? "—"}</div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">Hard body radius (m)</div>
            <div className="meta-value">{object.hardBodyRadius.toFixed(2)}</div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">Trajectories</div>
            <div className="meta-value">{objectTrajectories.length}</div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">Active conjunctions</div>
            <div className="meta-value">{conjunctions.length}</div>
          </div>
        </div>

        <div className="grid-2" style={{ marginBottom: 16 }}>
          <CataloguePanel noradId={object.noradId ?? null} objectId={object.id} />
          <section className="card">
            <div className="card-head">Object details</div>
            <table className="kv">
              <tbody>
                <tr>
                  <td className="k">Operator</td>
                  <td>{object.operatorName}</td>
                </tr>
                <tr>
                  <td className="k">Object name</td>
                  <td>{object.objectName}</td>
                </tr>
                <tr>
                  <td className="k">NORAD Id</td>
                  <td className="v-mono">{object.noradId ?? "—"}</td>
                </tr>
                <tr>
                  <td className="k">Alive</td>
                  <td>
                    <span className={`chip ${object.alive}`}>{String(object.alive)}</span>
                  </td>
                </tr>
                <tr>
                  <td className="k">Maneuverable</td>
                  <td>
                    <span className={`chip ${object.maneuverability}`}>
                      {String(object.maneuverability)}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="k">Hard body radius (m)</td>
                  <td className="v-mono">{object.hardBodyRadius.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="card">
            <div className="card-head">
              <span>Upcoming conjunctions</span>
              <span className="count">{conjunctions.length} active</span>
            </div>
            <div className="table-wrap" style={{ borderTop: "none" }}>
              {conjunctions.length === 0 ? (
                <div className="empty">No active conjunctions.</div>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Other object</th>
                      <th className="num">Pc</th>
                      <th>Event</th>
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
                              ? c.probabilityOfCollision.toExponential(2)
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
                              <span className="faint">—</span>
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
            <span>Trajectories</span>
            <span className="count">{objectTrajectories.length} uploads</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Type</th>
                  <th>State source</th>
                  <th>Screened status</th>
                  <th className="num">Points</th>
                  <th>Uploaded at (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {objectTrajectories.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/trajectories/${t.id}`} className="mono-sm">
                        {t.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td>
                      <span className="chip neutral">{t.uploadType}</span>
                    </td>
                    <td>
                      <span className={`chip ${t.stateSource}`}>{t.stateSource}</span>
                    </td>
                    <td>
                      <span
                        className={`chip ${
                          t.screenedStatus === "screened" ? "true" : "neutral"
                        }`}
                      >
                        {t.screenedStatus}
                      </span>
                    </td>
                    <td className="num">{t.pointCount}</td>
                    <td className="mono-sm">
                      {t.uploadedAt.replace("T", " ").replace(/\.\d+Z$/, "")}
                    </td>
                  </tr>
                ))}
                {objectTrajectories.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">
                      No trajectories uploaded for this object.
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
              Prediction Accuracy
            </h2>
            <span className="page-sub">
              newest upload as reference · radial axis · 3 h horizon
            </span>
          </div>
        </div>

        <AccuracyPanels report={accuracy} />
      </div>
    </>
  );
}
