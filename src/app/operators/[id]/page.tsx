import Link from "next/link";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/Shell";
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
      <Topbar section="Operators" entityId={operator.id} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{operator.name}</h1>
          <Link className="btn" href="/operators">
            ← back
          </Link>
        </div>

        <section className="card" style={{ marginBottom: 16 }}>
          <table className="kv">
            <tbody>
              <tr>
                <td className="k">Email</td>
                <td className="v-mono">{operator.email || "—"}</td>
              </tr>
              <tr>
                <td className="k">Phone</td>
                <td className="v-mono">{operator.phone || "—"}</td>
              </tr>
              <tr>
                <td className="k">Max objects</td>
                <td className="v-mono">{operator.maxObjects}</td>
              </tr>
              <tr>
                <td className="k">Objects registered</td>
                <td className="v-mono">{objects.length}</td>
              </tr>
              <tr>
                <td className="k">Trajectories uploaded</td>
                <td className="v-mono">{uploads.length}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <div className="card">
          <div className="card-head">
            <span>Objects</span>
            <span className="count">
              showing {objects.length} of {operator.maxObjects} allowed
            </span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>NORAD Id</th>
                  <th className="num">Hard body radius (m)</th>
                  <th>Alive</th>
                  <th>Maneuverable</th>
                </tr>
              </thead>
              <tbody>
                {objects.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/objects/${o.id}`}>{o.objectName}</Link>
                    </td>
                    <td className="mono-sm muted">{o.noradId ?? "—"}</td>
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
                      This operator has no objects.
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
