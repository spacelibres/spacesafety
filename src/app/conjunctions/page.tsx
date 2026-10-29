import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { listConjunctions, riskThresholds } from "@/lib/queries";
import { countdownTo } from "@/lib/space-safety/gps";

export const dynamic = "force-dynamic";

export default function ConjunctionsPage() {
  const rows = listConjunctions(200);
  const t = riskThresholds();

  return (
    <>
      <Topbar section="Conjunctions" />
      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">Conjunctions</h1>
            <span className="page-sub">
              active CDMs · high ≥ {t.high.toExponential(0)} · medium ≥{" "}
              {t.medium.toExponential(0)}
            </span>
          </div>
          <span className="count">{rows.length} active</span>
        </div>

        <div className="filters">
          <button className="filter-btn" title="Filters" aria-label="Filters">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3 4h18l-7 8v6l-4-2v-8z" />
            </svg>
          </button>
          <div className="filter-group">
            <span>Risk</span>
            <select defaultValue="">
              <option value="">any</option>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </select>
          </div>
          <div className="filter-group">
            <span>Is active</span>
            <select defaultValue="true">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
        </div>

        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Object 1</th>
                  <th>Operator 1</th>
                  <th>Object 2</th>
                  <th>Operator 2</th>
                  <th className="num">Pc</th>
                  <th>TCA</th>
                  <th>Countdown</th>
                  <th>Risk</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.eventId ? (
                        <Link href={`/conjunctions/${c.eventId}`}>
                          {c.eventId.slice(0, 8)}
                        </Link>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td>{c.object1Name}</td>
                    <td className="muted">{c.operator1Name}</td>
                    <td>{c.object2Name}</td>
                    <td className="muted">{c.operator2Name}</td>
                    <td className={`num pc ${c.band}`}>{fmtPc(c.pc)}</td>
                    <td className="mono-sm">{fmt(c.tcaIso)}</td>
                    <td className="mono-sm faint">
                      {c.tcaGpsNanos ? countdownTo(c.tcaGpsNanos) : "—"}
                    </td>
                    <td>
                      <span className={`chip risk-${c.band}`}>
                        {c.band.toUpperCase()}
                      </span>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="empty">
                      No active conjunctions.
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

function fmtPc(pc: number | null): string {
  if (pc === null) return "NULL";
  if (pc === 0) return "0";
  return pc.toExponential(2);
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace("T", " ").replace(/\.\d+Z$/, "");
}
