import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { listOperators } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default function OperatorsPage() {
  const rows = listOperators();

  return (
    <>
      <Topbar section="Operators" />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Operators</h1>
          <span className="count">{rows.length} operators</span>
        </div>

        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th className="num">Max objects</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/operators/${o.id}`}>{o.name}</Link>
                    </td>
                    <td className="mono-sm muted">{o.email || "—"}</td>
                    <td className="mono-sm muted">{o.phone || "—"}</td>
                    <td className="num">{o.maxObjects}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      No operators yet.
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
