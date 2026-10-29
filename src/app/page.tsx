import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { getTranslator } from "@/lib/i18n/registry";
import {
  getCatalogSummary,
  getOverview,
  getSystemHealth,
  listConjunctions,
  riskThresholds,
} from "@/lib/queries";
import { countdownTo, formatGps } from "@/lib/space-safety/gps";

import HomeViewer from "./HomeViewer";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const overview = getOverview();
  const conjunctions = listConjunctions(12);
  const health = getSystemHealth();
  const catalog = getCatalogSummary(6);
  const thresholds = riskThresholds();
  const t = await getTranslator();

  return (
    <>
      <Topbar section={t.t("nav.home")} />

      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">{t.t("overview.title")}</h1>
            <div className="meta-strip" style={{ marginTop: 14, marginBottom: 0 }}>
              <div className="meta-cell">
                <div className="meta-label">{t.t("overview.nextTca")}</div>
                <div className="meta-value">
                  {overview.nextTcaIso ? formatGmt(overview.nextTcaIso, t.t("common.none")) : t.t("common.none")}
                </div>
              </div>
              <div className="meta-cell">
                <div className="meta-label">{t.t("overview.screeningQueue")}</div>
                <div className="meta-value">
                  {t.t("overview.queueCounts", {
                    pending: t.number(health.pending),
                    failed: t.number(health.failed),
                  })}
                </div>
              </div>
              <div className="meta-cell">
                <div className="meta-label">{t.t("overview.unscreened")}</div>
                <div className="meta-value">{t.number(health.unscreened)}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="stats-row">
          <Stat label={t.t("nav.operators")} value={overview.operators} t={t.number.bind(t)} />
          <Stat label={t.t("nav.objects")} value={overview.objects} t={t.number.bind(t)} />
          <Stat label={t.t("nav.trajectories")} value={overview.trajectories} t={t.number.bind(t)} />
          <Stat label={t.t("column.cdms")} value={overview.cdms} t={t.number.bind(t)} />
          <Stat
            label={t.t("overview.pcAtLeast", { threshold: thresholds.high.toExponential(0) })}
            value={overview.highRisk}
            tone="high"
            t={t.number.bind(t)}
          />
          <Stat
            label={t.t("overview.pcAtLeast", { threshold: thresholds.medium.toExponential(0) })}
            value={overview.mediumRisk}
            tone="medium"
            t={t.number.bind(t)}
          />
        </div>

        <div className="home-grid">
          <section className="card">
            <div className="card-head">
              <span>{t.t("overview.orbitalView")}</span>
              <span className="count">{t.t("overview.orbitalViewCaption")}</span>
            </div>
            <div className="card-body flush">
              <HomeViewer limit={60} />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <span>{t.t("overview.highestRisk")}</span>
              <Link href="/conjunctions">{t.t("overview.viewAll")}</Link>
            </div>
            <div className="card-body flush">
              {conjunctions.length === 0 ? (
                <div className="empty">{t.t("overview.noConjunctions")}</div>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>{t.t("column.primary")}</th>
                        <th>{t.t("column.secondary")}</th>
                        <th className="num">{t.t("column.pc")}</th>
                        <th>{t.t("column.tca")}</th>
                        <th>{t.t("column.risk")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {conjunctions.map((c) => (
                        <tr key={c.id}>
                          <td>
                            {c.eventId ? (
                              <Link href={`/conjunctions/${c.eventId}`}>{c.object1Name}</Link>
                            ) : (
                              c.object1Name
                            )}
                          </td>
                          <td className="muted">{c.object2Name}</td>
                          <td className={`num pc ${c.band}`}>{t.probability(c.pc ?? NaN)}</td>
                          <td className="mono-sm nowrap">
                            {c.tcaGpsNanos ? countdownTo(c.tcaGpsNanos) : t.t("common.none")}
                          </td>
                          <td>
                            <span className={`chip risk-${c.band}`}>
                              {t.t(`risk.${c.band}`).toUpperCase()}
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
            <span>{t.t("overview.catalog")}</span>
            <span className="count">{t.t("overview.catalogCaption")}</span>
          </div>
          <div className="card-body flush">
            {catalog.length === 0 ? (
              <div className="empty">{t.t("overview.catalogEmpty")}</div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t.t("column.object")}</th>
                      <th>{t.t("column.stateSource")}</th>
                      <th>{t.t("column.trajectory")}</th>
                      <th>{t.t("column.updated")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catalog.map((c) => (
                      <tr key={`${c.objectId}-${c.stateSource}`}>
                        <td>{c.objectName}</td>
                        <td>
                          <span className={`chip ${c.stateSource}`}>{c.stateSource}</span>
                        </td>
                        <td>
                          <Link href={`/trajectories/${c.trajectoryId}`}>
                            {c.trajectoryId.slice(0, 8)}
                          </Link>
                        </td>
                        <td className="mono-sm faint">{formatGmt(c.updatedAt, t.t("common.none"))}</td>
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
  t,
}: {
  label: string;
  value: number;
  tone?: "high" | "medium";
  t: (n: number) => string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone ? ` ${tone}` : ""}`}>{t(value)}</div>
    </div>
  );
}

/** ISO-8601 to a space-separated UTC stamp; `dash` when unparseable. */
function formatGmt(iso: string, dash: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return dash;
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

void formatGps;
