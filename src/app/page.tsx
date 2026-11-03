import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { ConstellationGlobe } from "@/components/cesium/ConstellationGlobe";
import { getTranslator } from "@/lib/i18n/registry";
import {
  getOverview,
  getSystemHealth,
  listConjunctions,
  listPublishedConjunctions,
  listRecentCatalogue,
  publishedConjunctionCounts,
  riskThresholds,
} from "@/lib/queries";
import { statistics } from "@/lib/statistics";
import { getDb } from "@/db";
import { countdownTo, formatGps } from "@/lib/space-safety/gps";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const overview = getOverview();
  const conjunctions = listConjunctions(12);
  const health = getSystemHealth();
  // The workspace list is *our* screening output, which exists only after an
  // operator uploads an ephemeris; this deployment has none, so the panel was empty
  // next to a counter showing 3,523 public CDMs. `listPublishedConjunctions`
  // already collapses those messages into 571 conjunctions and is what
  // `/conjunctions` renders — the home page simply was not asking for it.
  const published = listPublishedConjunctions(12);
  const recent = listRecentCatalogue(12);
  const publishedCounts = publishedConjunctionCounts();
  const thresholds = riskThresholds();
  const t = await getTranslator();

  // Two different populations, and the page used to show only the second one.
  //
  //   catalogue  the ingested reference data: 72,432 objects from four sources
  //   workspace  what this installation has been given: operators, uploads,
  //              trajectories, CDMs
  //
  // The six counters here were all workspace, and every one of them was zero or
  // near it on a fresh install, so the front page said "0 trajectories, 0 CDMs"
  // while the catalogue held 72,432 objects and 3,523 public CDMs. Reading as an
  // error was reasonable; it was showing the wrong population.
  const catalogue = statistics();
  const { sqlite, wideAttached } = getDb();
  const publicCdms = wideAttached
    ? ((sqlite.prepare("SELECT COUNT(*) AS n FROM space_track_cdm_public").get() as
        | { n: number }
        | undefined)?.n ?? 0)
    : 0;
  const liveCatalogue =
    catalogue.objectClass.find((b) => b.label === "PAYLOAD") !== undefined;
  const payloads = catalogue.objectClass.find((b) => b.label === "PAYLOAD")?.count ?? 0;
  const debris = catalogue.objectClass.find((b) => b.label === "DEBRIS")?.count ?? 0;
  const rocketBodies = catalogue.objectClass.find((b) => b.label === "ROCKET BODY")?.count ?? 0;

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

        {/* The catalogue comes first: it is the data the product is about, and it
            is the only population that is populated on a fresh install. */}
        <div className="card-head" style={{ marginTop: 18 }}>
          <span>{t.t("overview.catalogueSection")}</span>
          <Link href="/catalogue">{t.t("overview.viewAll")}</Link>
        </div>
        <div className="stats-row">
          <Stat
            label={t.t("overview.catalogueTotal")}
            value={catalogue.total}
            t={t.number.bind(t)}
          />
          <Stat label={t.t("overview.catalogueInOrbit")} value={catalogue.inOrbit} t={t.number.bind(t)} />
          <Stat label={t.t("overview.cataloguePayloads")} value={payloads} t={t.number.bind(t)} />
          <Stat label={t.t("overview.catalogueDebris")} value={debris} t={t.number.bind(t)} />
          <Stat label={t.t("overview.catalogueRocketBodies")} value={rocketBodies} t={t.number.bind(t)} />
          <Stat label={t.t("overview.cataloguePublicCdms")} value={publicCdms} t={t.number.bind(t)} />
        </div>
        {!liveCatalogue && <div className="empty">{t.t("overview.catalogueMissing")}</div>}

        <div className="card-head" style={{ marginTop: 18 }}>
          <span>{t.t("overview.workspaceSection")}</span>
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
              {/* The whole constellation, not the newest 60 catalog entries: this
                  card is the global picture, and screening results below it are
                  the detail. */}
              <ConstellationGlobe height={460} />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <span>{t.t("overview.highestRisk")}</span>
              <Link href="/conjunctions">{t.t("overview.viewAll")}</Link>
            </div>
            <div className="card-body flush">
              {/* Published CDMs first: they are the only conjunctions that exist on
                  an installation without uploaded ephemerides, and the panel used to
                  show our (empty) screening output while the counter beside it said
                  3,523 public CDMs. Our own results replace them only when we
                  actually have some. */}
              {published.length > 0 ? (
                <>
                  <div className="card-note">
                    {t.t("overview.publishedConjunctions", {
                      conjunctions: t.number(publishedCounts.conjunctions),
                      upcoming: t.number(publishedCounts.upcoming),
                    })}
                  </div>
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>{t.t("column.primary")}</th>
                          <th>{t.t("column.secondary")}</th>
                          <th className="num">{t.t("column.pc")}</th>
                          <th>{t.t("column.tca")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {published.map((c) => (
                          <tr key={`${c.object1Norad}-${c.object2Norad}-${c.tcaIso}`}>
                            <td>{c.object1Name}</td>
                            <td className="muted">{c.object2Name}</td>
                            <td className={`num pc ${c.band}`}>
                              {c.pc === null ? t.t("common.none") : t.probability(c.pc)}
                            </td>
                            <td className="mono-sm nowrap">{c.tcaIso ? formatGmt(c.tcaIso, t.t("common.none")) : t.t("common.none")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : conjunctions.length === 0 ? (
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
            <span>{t.t("overview.recentAdded")}</span>
            <span className="count">{t.t("overview.recentCaption")}</span>
          </div>
          <div className="card-body flush">
            {/* Newest catalogue entries, not "newest trajectory per object".
                The latter is populated by uploads, so on an ingested-only
                installation it is empty by definition — and the panel said
                "catalogue is empty" next to a header claiming 72,432 objects. */}
            {recent.length === 0 ? (
              <div className="empty">{t.t("overview.catalogEmpty")}</div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t.t("column.norad")}</th>
                      <th>{t.t("column.object")}</th>
                      <th>{t.t("column.objectClass")}</th>
                      <th>{t.t("column.launchDate")}</th>
                      <th>{t.t("column.country")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((c) => (
                      <tr key={c.noradId}>
                        <td className="mono-sm">
                          <Link href={`/catalogue/${c.noradId}`}>{c.noradId}</Link>
                        </td>
                        <td>{c.name}</td>
                        <td className="muted">{c.objectClass ?? t.t("common.none")}</td>
                        <td className="mono-sm faint">{c.launchDate ?? t.t("common.none")}</td>
                        <td className="muted">{c.country ?? t.t("common.none")}</td>
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
