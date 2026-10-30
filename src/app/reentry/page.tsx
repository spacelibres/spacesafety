import { TinyBars } from "@/components/Charts";
import { Topbar } from "@/components/Shell";
import { StatsRow, stat } from "@/components/Stats";
import { getTranslator } from "@/lib/i18n/registry";
import { countdownToIso } from "@/lib/space-safety/gps";
import {
  listRecentReentries,
  listUpcomingReentries,
  reentriesByYear,
  reentrySummary,
} from "@/lib/queries-events";

export const dynamic = "force-dynamic";

const ROW_LIMIT = 100;

/**
 * Re-entries.
 *
 * ## Three feeds, three different claims
 *
 * The table names make this look like one dataset and it is not:
 *
 *   - `space_track_tip` holds **predictions**: when an object is expected to come
 *     down. 26 184 of its 26 189 rows predict an epoch that has already passed, so
 *     "newest messages" is not the same as "still upcoming" — this page filters on
 *     the epoch.
 *   - `space_track_decay` is a **union of four feeds** (`decay_msg`, `60day_msg`,
 *     `TIP_msg`, `satcat`) and its `msg_type` decides the meaning: `Historical` is
 *     when 18 SDS stopped tracking the object, `Prediction` is a forecast. A
 *     "recent re-entries" list that ignored this would report forecasts as history.
 *   - `keeptrack_reentry` is a third, independent forecast of the same events.
 *
 * So the page keeps predictions and completed re-entries in separate sections, and
 * inside the prediction section it lists both sources side by side instead of
 * merging them: averaging two forecasts of a re-entry would invent an answer
 * neither source gave.
 */
export default async function ReentryPage() {
  const t = await getTranslator();
  const summary = reentrySummary();
  const upcoming = listUpcomingReentries(ROW_LIMIT);
  const recent = listRecentReentries(ROW_LIMIT);
  const years = reentriesByYear(20);

  // The chart is drawn newest→oldest left to right, matching the table order.
  const chart = [...years]
    .reverse()
    .map((y) => ({ label: y.year.slice(2), value: y.reentries }));

  return (
    <>
      <Topbar section={t.t("nav.reentry")} />
      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">{t.t("reentryPage.title")}</h1>
            <span className="page-sub">{t.t("reentryPage.summary")}</span>
          </div>
          <span className="count">
            {t.t("reentryPage.count", {
              upcoming: summary.tipUpcoming + summary.keepTrackRows,
              objects: summary.decayedObjects,
            })}
          </span>
        </div>

        <StatsRow
          items={[
            stat(t, t.t("reentryPage.kpiDecayed"), summary.decayedObjects),
            stat(t, t.t("reentryPage.kpiThisYear"), years[0]?.reentries ?? 0),
            stat(t, t.t("reentryPage.kpiUpcoming"), summary.tipUpcoming + summary.keepTrackRows),
            stat(t, t.t("reentryPage.kpiPredictionRows"), summary.decayPrediction),
          ]}
        />

        <h2 className="page-title" style={{ fontSize: 15, margin: "0 0 6px" }}>
          {t.t("reentryPage.upcomingTitle")}
        </h2>
        <p className="faint" style={{ margin: "0 0 10px", fontSize: 12 }}>
          {t.t("reentryPage.upcomingNote")}
        </p>
        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.norad")}</th>
                  <th>{t.t("column.name")}</th>
                  <th>{t.t("column.decayEpoch")}</th>
                  <th>{t.t("column.countdown")}</th>
                  <th className="num">{t.t("column.window")}</th>
                  <th>{t.t("column.direction")}</th>
                  <th className="num">{t.t("column.latitude")}</th>
                  <th className="num">{t.t("column.longitude")}</th>
                  <th>{t.t("column.highInterest")}</th>
                  <th>{t.t("column.feed")}</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map((r) => (
                  <tr key={`${r.source}-${r.noradId}-${r.decayIso ?? ""}`}>
                    <td className="mono-sm">{r.noradId}</td>
                    <td>{r.name ?? <span className="faint">{t.t("common.unknown")}</span>}</td>
                    <td className="mono-sm">{fmt(r.decayIso, t.t("common.none"))}</td>
                    <td className="mono-sm faint">
                      {countdownToIso(r.decayIso) ?? t.t("common.none")}
                    </td>
                    <td className="num mono-sm">
                      {r.windowMinutes === null
                        ? t.t("common.none")
                        : `${Math.round(r.windowMinutes)} min`}
                    </td>
                    <td className="muted">{r.direction ?? t.t("common.none")}</td>
                    <td className="num mono-sm">{deg(r.latDeg)}</td>
                    <td className="num mono-sm">{deg(r.lonDeg)}</td>
                    <td>
                      <span className={`chip ${r.highInterest ? "true" : "false"}`}>
                        {r.highInterest ? t.t("common.yes") : t.t("common.no")}
                      </span>
                    </td>
                    <td className="muted mono-sm">
                      {r.source === "keeptrack"
                        ? t.t("reentryPage.sourceKeepTrack")
                        : t.t("reentryPage.sourceSpaceTrack")}
                    </td>
                  </tr>
                ))}
                {upcoming.length === 0 && (
                  <tr>
                    <td colSpan={10} className="empty">
                      {t.t("reentryPage.noUpcoming")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <h2 className="page-title" style={{ fontSize: 15, margin: "22px 0 6px" }}>
          {t.t("reentryPage.recentTitle")}
        </h2>
        <p className="faint" style={{ margin: "0 0 10px", fontSize: 12 }}>
          {t.t("reentryPage.recentNote")}
        </p>
        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.norad")}</th>
                  <th>{t.t("column.name")}</th>
                  <th>{t.t("column.decayEpoch")}</th>
                  <th>{t.t("column.country")}</th>
                  <th>{t.t("column.rcs")}</th>
                  <th>{t.t("column.feed")}</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.noradId}>
                    <td className="mono-sm">{r.noradId}</td>
                    <td>{r.name ?? <span className="faint">{t.t("common.unknown")}</span>}</td>
                    <td className="mono-sm">{fmt(r.decayIso, t.t("common.none"))}</td>
                    <td className="muted">{r.country ?? t.t("common.none")}</td>
                    <td className="muted mono-sm">{r.rcsSize ?? t.t("common.none")}</td>
                    <td className="muted mono-sm">{r.feed ?? t.t("common.none")}</td>
                  </tr>
                ))}
                {recent.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">
                      {t.t("common.empty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <h2 className="page-title" style={{ fontSize: 15, margin: "22px 0 6px" }}>
          {t.t("reentryPage.byYearTitle")}
        </h2>
        <div className="card">
          <div className="card-body">
            <TinyBars data={chart} height={90} />
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

function deg(v: number | null): string {
  if (v === null || Number.isNaN(v)) return "—";
  return `${v.toFixed(1)}°`;
}
