import Link from "next/link";

import { Topbar } from "@/components/Shell";
import HomeViewer from "./HomeViewer";
import {
  getCatalogSummary,
  getOverview,
  getSystemHealth,
  listConjunctions,
  riskThresholds,
} from "@/lib/queries";
import { formatGps, countdownTo } from "@/lib/space-safety/gps";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const overview = getOverview();
  const conjunctions = listConjunctions(12);
  const health = getSystemHealth();
  const catalog = getCatalogSummary(6);
  const thresholds = riskThresholds();

  return (
    <>
      <Topbar section="Home" />

      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">Overview</h1>
            <div className="meta-strip" style={{ marginTop: 14, marginBottom: 0 }}>
              <div className="meta-cell">
                <div className="meta-label">Next TCA (UTC)</div>
                <div className="meta-value">
                  {overview.nextTcaIso
                    ? formatGmt(overview.nextTcaIso)
                    : "—"}
                </div>
              </div>
              <div className="meta-cell">
                <div className="meta-label">Screening queue</div>
                <div className="meta-value">
                  {health.pending} pending · {health.failed} failed
                </div>
              </div>
              <div className="meta-cell">
                <div className="meta-label">Un-screened uploads</div>
                <div className="meta-value">{health.unscreened}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="stats-row">
          <Stat label="Operators" value={overview.operators} />
          <Stat label="Objects" value={overview.objects} />
          <Stat label="Trajectories" value={overview.trajectories} />
          <Stat label="CDMs" value={overview.cdms} />
          <Stat
            label={`Pc ≥ ${thresholds.high.toExponential(0)}`}
            value={overview.highRisk}
            tone="high"
          />
          <Stat
            label={`Pc ≥ ${thresholds.medium.toExponential(0)}`}
            value={overview.mediumRisk}
            tone="medium"
          />
        </div>

        <div className="home-grid">
          <section className="card">
            <div className="card-head">
              <span>Orbital view</span>
              <span className="count">live · catalog trajectories</span>
            </div>
            <div className="card-body flush">
              <HomeViewer limit={60} />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <span>Highest-risk conjunctions</span>
              <Link href="/conjunctions">view all</Link>
            </div>
            <div className="card-body flush">
              {conjunctions.length === 0 ? (
                <div className="empty">
                  No active conjunctions yet.
                  <br />
                  Upload trajectories or run the demo seeder to populate the
                  catalog.
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Primary</th>
                        <th>Secondary</th>
                        <th className="num">Pc</th>
                        <th>TCA</th>
                        <th>Risk</th>
                      </tr>
                    </thead>
                    <tbody>
                      {conjunctions.map((c) => (
                        <tr key={c.id}>
                          <td>
                            {c.eventId ? (
                              <Link href={`/conjunctions/${c.eventId}`}>
                                {c.object1Name}
                              </Link>
                            ) : (
                              c.object1Name
                            )}
                          </td>
                          <td className="muted">{c.object2Name}</td>
                          <td className={`num pc ${c.band}`}>{fmtPc(c.pc)}</td>
                          <td className="mono-sm nowrap">
                            {c.tcaGpsNanos ? countdownTo(c.tcaGpsNanos) : "—"}
                          </td>
                          <td>
                            <span className={`chip risk-${c.band}`}>
                              {c.band.toUpperCase()}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </div>

        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <span>Catalog</span>
            <span className="count">
              newest definitive trajectory per object and state source
            </span>
          </div>
          <div className="card-body flush">
            {catalog.length === 0 ? (
              <div className="empty">Catalog is empty.</div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Object</th>
                      <th>State source</th>
                      <th>Trajectory</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catalog.map((c) => (
                      <tr key={`${c.objectId}-${c.stateSource}`}>
                        <td>{c.objectName}</td>
                        <td>
                          <span className={`chip ${c.stateSource}`}>
                            {c.stateSource}
                          </span>
                        </td>
                        <td>
                          <Link href={`/trajectories/${c.trajectoryId}`}>
                            {c.trajectoryId.slice(0, 8)}
                          </Link>
                        </td>
                        <td className="mono-sm faint">{formatGmt(c.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "high" | "medium";
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone ? ` ${tone}` : ""}`}>{value}</div>
    </div>
  );
}

function fmtPc(pc: number | null): string {
  if (pc === null) return "NULL";
  if (pc === 0) return "0";
  return pc.toExponential(2);
}

function formatGmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

void formatGps;
