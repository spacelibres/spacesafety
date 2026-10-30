import { TinyBars } from "@/components/Charts";
import { Topbar } from "@/components/Shell";
import { StatsRow, stat } from "@/components/Stats";
import { getTranslator } from "@/lib/i18n/registry";
import { eopSummary, listEop, listSpaceWeather, spaceWeatherSummary } from "@/lib/queries-events";

export const dynamic = "force-dynamic";

const DAYS = 30;

/**
 * Space environment: solar and geomagnetic indices, earth orientation.
 *
 * ## What these two series are for, and why that is stated on the page
 *
 * `space_weather` (25 232 daily rows, 1957-10-01 → today) drives drag: F10.7 and
 * Kp/Ap are what turn a two-line element set into a believable propagation two
 * days out. `earth_orientation` (23 678 daily rows) is what rotates ITRF into
 * EME2000 without introducing a kilometre of error at GEO.
 *
 * Both are complete — zero missing days over their whole span — and both are
 * currently **ingested but not consumed**: the propagation code does not read
 * them yet. That is stated on the page rather than left for a reader to discover,
 * because a page full of authoritative numbers implies they are in use.
 */
export default async function EnvironmentPage() {
  const t = await getTranslator();
  const weather = spaceWeatherSummary();
  const eop = eopSummary();
  const weatherRows = listSpaceWeather(DAYS);
  const eopRows = listEop(DAYS);

  // F10.7 over the last month, oldest first so the chart reads left to right.
  const chart = [...weatherRows]
    .reverse()
    .filter((r) => r.f107Obs !== null)
    .map((r) => ({ label: r.day.slice(5), value: Math.round(r.f107Obs ?? 0) }));

  return (
    <>
      <Topbar section={t.t("nav.environment")} />
      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">{t.t("environmentPage.title")}</h1>
            <span className="page-sub">{t.t("environmentPage.summary")}</span>
          </div>
          <span className="count">
            {t.t("environmentPage.count", {
              days: weather.rows,
              eopDays: eop.rows,
            })}
          </span>
        </div>

        <div className="banner warn" style={{ marginBottom: 14 }}>
          {t.t("environmentPage.notWired")}
        </div>

        <StatsRow
          items={[
            stat(t, t.t("environmentPage.kpiF107"), Math.round(weather.latest?.f107Obs ?? 0)),
            stat(t, t.t("environmentPage.kpiKp"), weather.latest?.kpSum ?? 0),
            stat(t, t.t("environmentPage.kpiAp"), Math.round(weather.latest?.apAvg ?? 0)),
            stat(t, t.t("environmentPage.kpiUt1"), fixed(eop.latest?.ut1MinusUtc, 4)),
          ]}
        />

        <div className="page-head section-head">
          <h2 className="page-title" style={{ fontSize: 15 }}>
            {t.t("environmentPage.weatherTitle")}
          </h2>
          <span className="count">
            {t.t("environmentPage.coverage", {
              rows: weather.rows,
              from: weather.firstDay ?? "—",
              to: weather.lastDay ?? "—",
              gaps: weather.gaps,
            })}
          </span>
        </div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-body">
            <TinyBars data={chart} height={80} />
          </div>
        </div>
        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.day")}</th>
                  <th className="num">{t.t("column.f107")}</th>
                  <th className="num">{t.t("column.f107Adj")}</th>
                  <th className="num">{t.t("column.kp")}</th>
                  <th className="num">{t.t("column.ap")}</th>
                  <th className="num">{t.t("column.cp")}</th>
                  <th className="num">{t.t("column.sunspot")}</th>
                </tr>
              </thead>
              <tbody>
                {weatherRows.map((r) => (
                  <tr key={r.day}>
                    <td className="mono-sm">{r.day}</td>
                    <td className="num mono-sm">{fixed(r.f107Obs, 1)}</td>
                    <td className="num mono-sm">{fixed(r.f107Adj, 1)}</td>
                    <td className="num mono-sm">{fixed(r.kpSum, 0)}</td>
                    <td className="num mono-sm">{fixed(r.apAvg, 0)}</td>
                    <td className="num mono-sm">{fixed(r.cp, 2)}</td>
                    <td className="num mono-sm">{fixed(r.sunspot, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="page-head section-head" style={{ marginTop: 22 }}>
          <h2 className="page-title" style={{ fontSize: 15 }}>
            {t.t("environmentPage.eopTitle")}
          </h2>
          <span className="count">
            {t.t("environmentPage.eopCoverage", {
              rows: eop.rows,
              from: mjdLabel(eop.firstMjd),
              to: mjdLabel(eop.lastMjd),
              gaps: eop.gaps,
            })}
          </span>
        </div>
        <p className="faint" style={{ margin: "0 0 10px", fontSize: 12 }}>
          {t.t("environmentPage.eopNote")}
        </p>
        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th className="num">{t.t("column.mjd")}</th>
                  <th>{t.t("column.day")}</th>
                  <th className="num">{t.t("column.polarX")}</th>
                  <th className="num">{t.t("column.polarY")}</th>
                  <th className="num">{t.t("column.ut1")}</th>
                  <th className="num">{t.t("column.lod")}</th>
                </tr>
              </thead>
              <tbody>
                {eopRows.map((r) => (
                  <tr key={r.mjd}>
                    <td className="num mono-sm">{r.mjd}</td>
                    <td className="mono-sm">{r.day}</td>
                    <td className="num mono-sm">{fixed(r.xArcsec, 4)}</td>
                    <td className="num mono-sm">{fixed(r.yArcsec, 4)}</td>
                    <td className="num mono-sm">{fixed(r.ut1MinusUtc, 4)}</td>
                    <td className="num mono-sm">{fixed(r.lod, 5)}</td>
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

/** Fixed-point with a dash for missing values: 0 and "unknown" must not look alike. */
function fixed(v: number | null | undefined, digits: number): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

/** MJD → ISO date for the header, so the coverage line reads as dates. */
function mjdLabel(mjd: number | null): string {
  if (mjd === null) return "—";
  return new Date((mjd - 40587) * 86_400_000).toISOString().slice(0, 10);
}
