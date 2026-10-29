import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { listObjects } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default function ObjectsPage() {
  const rows = listObjects(200);

  return (
    <>
      <Topbar section="Objects" />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Objects</h1>
          <span className="count">showing {rows.length} objects</span>
        </div>

        <div className="filters">
          <button className="filter-btn" title="Filters" aria-label="Filters">
            <FilterIcon />
          </button>
          <div className="filter-group">
            <span>Alive</span>
            <select defaultValue="true">
              <option value="true">equals</option>
            </select>
            <select defaultValue="true">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
          <div className="filter-group">
            <span>Name</span>
            <select defaultValue="contains">
              <option value="contains">contains</option>
            </select>
            <input placeholder="" aria-label="Name filter" />
          </div>
          <div className="filter-group">
            <span>NORAD Id</span>
            <select defaultValue="equals">
              <option value="equals">equals</option>
            </select>
            <input placeholder="" aria-label="NORAD filter" />
          </div>
          <div className="filters-spacer" />
          <button className="filter-btn" title="Columns" aria-label="Columns">
            <GearIcon />
          </button>
        </div>

        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>NORAD Id</th>
                  <th className="num">Hard body radius (m)</th>
                  <th>Operator</th>
                  <th>Alive</th>
                  <th>Maneuverable</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/objects/${o.id}`}>{o.objectName}</Link>
                    </td>
                    <td className="mono-sm muted">{o.noradId ?? "—"}</td>
                    <td className="num">{o.hardBodyRadius.toFixed(2)}</td>
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
                      No objects yet. Create one via{" "}
                      <code className="mono">POST /api/v1/object</code>.
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
