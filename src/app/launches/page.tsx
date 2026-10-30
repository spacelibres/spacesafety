import { TinyBars } from "@/components/Charts";
import { Topbar } from "@/components/Shell";
import { StatsRow, stat } from "@/components/Stats";
import { getTranslator } from "@/lib/i18n/registry";
import {
  fragmentationSummary,
  launchStatsByVehicle,
  launchStatsByYear,
  listBoxscore,
  listFragmentations,
  listUpcomingLaunches,
} from "@/lib/queries-events";

export const dynamic = "force-dynamic";

const ROW_LIMIT = 50;

/**
 * Launches and break-ups.
 *
 * ## Four unrelated feeds, deliberately on one page
 *
 *   - **Upcoming launches** (`keeptrack_upcoming_launch`) — a schedule. `net` is
 *     "No Earlier Than", a plan, not a commitment; the column header says so.
 *   - **Launch counts** (`keeptrack_launch_stat`) — by year and by vehicle-year.
 *     Kept as the vendor's own tally rather than recomputed from the catalogue,
 *     which cannot see launches that failed before orbit.
 *   - **Orbital / decayed totals per country** (`space_track_boxscore`) — the
 *     authority's snapshot. The `ALL` row is separated out: it is a total, and
 *     leaving it in a "top owners" table would put a bar meaning "everyone" first.
 *   - **Break-up events** (`discos_fragmentation`) — 673 events, of which only 154
 *     carry a position (DISCOS gives none for the rest) and `epoch` is a date with
 *     no time. Nothing here is interpolated to look complete.
 */
export default async function LaunchesPage() {
  const t = await getTranslator();
  const upcoming = listUpcomingLaunches(ROW_LIMIT);
  const byYear = launchStatsByYear(30);
  const byVehicle = launchStatsByVehicle(12);
  const boxscore = listBoxscore(30);
  const frag = fragmentationSummary();
  const fragmentations = listFragmentations(ROW_LIMIT);

  // Chart reads oldest → newest; `byYear` arrives newest first.
  const chart = [...byYear]
    .reverse()
    .map((y) => ({ label: String(y.year).slice(2), value: y.launches }));

  return (
    <>
      <Topbar section={t.t("nav.launches")} />
      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">{t.t("launchesPage.title")}</h1>
            <span className="page-sub">{t.t("launchesPage.summary")}</span>
          </div>
          <span className="count">
            {t.t("launchesPage.count", {
              upcoming: upcoming.length,
              events: frag.total,
            })}
          </span>
        </div>

        <StatsRow
          items={[
            stat(t, t.t("launchesPage.kpiUpcoming"), upcoming.length),
            stat(t, t.t("launchesPage.kpiThisYear"), byYear[0]?.launches ?? 0),
            stat(t, t.t("launchesPage.kpiOrbital"), boxscore.all?.orbitalTotal ?? 0),
            stat(t, t.t("launchesPage.kpiDecayed"), boxscore.all?.decayedTotal ?? 0),
          ]}
        />

        <div className="page-head section-head">
          <h2 className="page-title" style={{ fontSize: 15 }}>
            {t.t("launchesPage.upcomingTitle")}
          </h2>
        </div>
        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.net")}</th>
                  <th>{t.t("column.name")}</th>
                  <th>{t.t("column.vehicle")}</th>
                  <th>{t.t("column.pad")}</th>
                  <th>{t.t("column.status")}</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map((r) => (
                  <tr key={r.id}>
                    <td className="mono-sm">{fmt(r.netIso, t.t("common.none"))}</td>
                    <td>{r.name ?? t.t("common.none")}</td>
                    <td className="muted">{r.vehicle ?? t.t("common.none")}</td>
                    <td className="muted">{r.pad ?? t.t("common.none")}</td>
                    <td>
                      <span className="chip neutral">{r.status ?? t.t("common.unknown")}</span>
                    </td>
                  </tr>
                ))}
                {upcoming.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">
                      {t.t("common.empty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="page-head section-head" style={{ marginTop: 22 }}>
          <h2 className="page-title" style={{ fontSize: 15 }}>
            {t.t("launchesPage.yearTitle")}
          </h2>
        </div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-body">
            <TinyBars data={chart} height={90} />
          </div>
        </div>
        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.year")}</th>
                  <th className="num">{t.t("column.launches")}</th>
                  <th className="num">{t.t("column.successes")}</th>
                  <th className="num">{t.t("column.failures")}</th>
                </tr>
              </thead>
              <tbody>
                {byYear.map((y) => (
                  <tr key={y.year}>
                    <td className="mono-sm">{y.year}</td>
                    <td className="num mono-sm">{y.launches}</td>
                    <td className="num mono-sm">{y.successes ?? "—"}</td>
                    <td className="num mono-sm">{y.failures ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="page-head section-head" style={{ marginTop: 22 }}>
          <h2 className="page-title" style={{ fontSize: 15 }}>
            {t.t("launchesPage.vehicleTitle")}
          </h2>
        </div>
        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.year")}</th>
                  <th>{t.t("column.vehicle")}</th>
                  <th className="num">{t.t("column.launches")}</th>
                  <th className="num">{t.t("column.successes")}</th>
                  <th className="num">{t.t("column.failures")}</th>
                </tr>
              </thead>
              <tbody>
                {byVehicle.map((v) => (
                  <tr key={`${v.year}-${v.vehicle}`}>
                    <td className="mono-sm">{v.year}</td>
                    <td>{v.vehicle}</td>
                    <td className="num mono-sm">{v.launches}</td>
                    <td className="num mono-sm">{v.successes ?? "—"}</td>
                    <td className="num mono-sm">{v.failures ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="page-head section-head" style={{ marginTop: 22 }}>
          <h2 className="page-title" style={{ fontSize: 15 }}>
            {t.t("launchesPage.boxscoreTitle")}
          </h2>
          {boxscore.all && (
            <span className="count">
              {t.t("launchesPage.boxscoreTotal", {
                orbital: boxscore.all.orbitalTotal ?? 0,
                decayed: boxscore.all.decayedTotal ?? 0,
              })}
            </span>
          )}
        </div>
        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.country")}</th>
                  <th className="num">{t.t("column.orbital")}</th>
                  <th className="num">{t.t("column.decayed")}</th>
                  <th className="num">{t.t("column.total")}</th>
                </tr>
              </thead>
              <tbody>
                {boxscore.rows.map((r) => (
                  <tr key={r.country}>
                    <td>{r.country}</td>
                    <td className="num mono-sm">{r.orbitalTotal ?? "—"}</td>
                    <td className="num mono-sm">{r.decayedTotal ?? "—"}</td>
                    <td className="num mono-sm">{r.countryTotal ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="page-head section-head" style={{ marginTop: 22 }}>
          <h2 className="page-title" style={{ fontSize: 15 }}>
            {t.t("launchesPage.fragmentationTitle")}
          </h2>
          <span className="count">
            {t.t("launchesPage.fragmentationCoverage", {
              total: frag.total,
              withPosition: frag.withPosition,
            })}
          </span>
        </div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-body">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {frag.byType.slice(0, 12).map((b) => (
                <span className="chip neutral" key={b.eventType}>
                  {b.eventType} · {b.events}
                </span>
              ))}
            </div>
          </div>
        </div>
        <p className="faint" style={{ margin: "0 0 10px", fontSize: 12 }}>
          {t.t("launchesPage.fragmentationNote")}
        </p>
        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.day")}</th>
                  <th>{t.t("column.eventType")}</th>
                  <th className="num">{t.t("column.altitude")}</th>
                  <th className="num">{t.t("column.latitude")}</th>
                  <th className="num">{t.t("column.longitude")}</th>
                  <th>{t.t("column.description")}</th>
                </tr>
              </thead>
              <tbody>
                {fragmentations.map((f) => (
                  <tr key={f.discosId}>
                    <td className="mono-sm">{f.epoch ?? "—"}</td>
                    <td>{f.eventType ?? t.t("common.unknown")}</td>
                    <td className="num mono-sm">
                      {f.altitudeKm === null ? "—" : `${Math.round(f.altitudeKm)} km`}
                    </td>
                    <td className="num mono-sm">{f.latDeg === null ? "—" : `${f.latDeg.toFixed(1)}°`}</td>
                    <td className="num mono-sm">{f.lonDeg === null ? "—" : `${f.lonDeg.toFixed(1)}°`}</td>
                    <td className="muted" style={{ maxWidth: 420 }}>
                      {trim(f.comment, 120) ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

/** ISO-8601 to a space-separated UTC stamp; `dash` when absent. */
function fmt(iso: string | null, dash: string): string {
  if (!iso) return dash;
  return iso.replace("T", " ").replace(/\.\d+Z$/, "").replace(/Z$/, "");
}

/** Long free-text comments are truncated in the cell, not in the data. */
function trim(text: string | null, max: number): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
