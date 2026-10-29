import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { listTrajectories } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default function TrajectoriesPage() {
  const rows = listTrajectories(200);

  return (
    <>
      <Topbar section="Trajectories" />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Trajectories</h1>
          <span className="count">showing {rows.length} trajectories</span>
        </div>

        <div className="filters">
          <button className="filter-btn" title="Filters" aria-label="Filters">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3 4h18l-7 8v6l-4 2v-8z" />
            </svg>
          </button>
          <div className="filter-group">
            <span>Type</span>
            <select defaultValue="">
              <option value="equals">equals</option>
            </select>
            <select defaultValue="">
              <option value="">any</option>
              <option value="definitive">definitive</option>
              <option value="hypothetical">hypothetical</option>
              <option value="candidate">candidate</option>
            </select>
          </div>
          <div className="filter-group">
            <span>Status</span>
            <select defaultValue="">
              <option value="">any</option>
              <option value="screened">screened</option>
              <option value="not_screened">not_screened</option>
              <option value="superseded">superseded</option>
            </select>
          </div>
        </div>

        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Object</th>
                  <th>Operator</th>
                  <th>Type</th>
                  <th>State source</th>
                  <th>Screened status</th>
                  <th>Format</th>
                  <th className="num">Points</th>
                  <th>Uploaded at (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/trajectories/${t.id}`}>
                        {t.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td>{t.objectName}</td>
                    <td className="muted">{t.operatorName}</td>
                    <td>
                      <span className="chip neutral">{t.uploadType}</span>
                    </td>
                    <td>
                      <span className={`chip ${t.stateSource}`}>{t.stateSource}</span>
                    </td>
                    <td>
                      <span className={`chip ${statusClass(t.screenedStatus)}`}>
                        {t.screenedStatus}
                      </span>
                    </td>
                    <td className="mono-sm faint">{t.format}</td>
                    <td className="num">{t.pointCount}</td>
                    <td className="mono-sm">{fmt(t.uploadedAt)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="empty">
                      No trajectories yet. Upload one via{" "}
                      <code className="mono">POST /api/v1/trajectory</code>.
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
