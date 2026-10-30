import Link from "next/link";

import { Topbar } from "@/components/Shell";
import type { MessageTable } from "@/lib/i18n/messages/en";
import { getTranslator } from "@/lib/i18n/registry";
import { statistics, type Bucket, type CrossTab } from "@/lib/statistics";

export const dynamic = "force-dynamic";

/**
 * Dictionary key for each regime and purpose value.
 *
 * Keys, because this page is rendered in six languages and the same words label
 * the browse filters. Values with no key (a launch year, a country code) are
 * technical identifiers and render as-is.
 */
const REGIME_KEYS: Record<string, keyof MessageTable> = {
  LEO: "regime.LEO",
  MEO: "regime.MEO",
  GEO: "regime.GEO",
  HEO: "regime.HEO",
  UNKNOWN: "regime.UNKNOWN",
};

const PURPOSE_KEYS: Record<string, keyof MessageTable> = {
  communication: "purpose.communication",
  navigation: "purpose.navigation",
  "earth-observation": "purpose.earthObservation",
  meteorology: "purpose.meteorology",
  science: "purpose.science",
  military: "purpose.military",
  technology: "purpose.technology",
};

/** A proportional bar rendered as a div; no chart library needed. */
function Bar({ share, tone = "accent" }: { share: number; tone?: "accent" | "muted" }) {
  const pct = Math.max(0, Math.min(share * 100, 100));
  return (
    <div className="stat-bar">
      <div className={`stat-bar-fill ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

async function BucketTable({
  title,
  buckets,
  total,
  labelFn,
  limit = 12,
}: {
  title: string;
  buckets: Bucket[];
  total: number;
  labelFn?: (v: string) => string;
  limit?: number;
}) {
  const t = await getTranslator();
  const shown = buckets.slice(0, limit);
  const rest = buckets.slice(limit);
  const restCount = rest.reduce((a, b) => a + b.count, 0);

  return (
    <div className="stat-card">
      <h3 className="stat-title">{title}</h3>
      <table className="stat-table">
        <tbody>
          {shown.map((b) => (
            <tr key={b.label}>
              <td className="stat-label">{labelFn ? labelFn(b.label) : b.label}</td>
              <td className="stat-bar-cell">
                <Bar share={b.share} />
              </td>
              <td className="stat-num">{b.count.toLocaleString()}</td>
              <td className="stat-pct">{(b.share * 100).toFixed(1)}%</td>
            </tr>
          ))}
          {rest.length > 0 && (
            <tr className="stat-rest">
              <td className="stat-label">{t.t("statistics.otherCount", { count: rest.length })}</td>
              <td className="stat-bar-cell">
                <Bar share={total ? restCount / total : 0} tone="muted" />
              </td>
              <td className="stat-num">{restCount.toLocaleString()}</td>
              <td className="stat-pct">{((restCount / total) * 100).toFixed(1)}%</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

async function CrossTable({
  title,
  tab,
  labelFn,
}: {
  title: string;
  tab: CrossTab;
  labelFn?: (v: string) => string;
}) {
  const t = await getTranslator();
  return (
    <div className="stat-card stat-card-wide">
      <h3 className="stat-title">{title}</h3>
      <div className="table-wrap">
        <table className="data stat-cross">
          <thead>
            <tr>
              <th />
              {tab.columns.map((c) => (
                <th key={c} className="num">
                  {labelFn ? labelFn(c) : c}
                </th>
              ))}
              <th className="num">{t.t("statistics.total")}</th>
            </tr>
          </thead>
          <tbody>
            {tab.rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                {r.cells.map((v, i) => (
                  <td key={i} className="num" style={{ opacity: v === 0 ? 0.25 : 1 }}>
                    {v === 0 ? "—" : v.toLocaleString()}
                  </td>
                ))}
                <td className="num">{r.total.toLocaleString()}</td>
              </tr>
            ))}
            <tr className="stat-cross-total">
              <td>{t.t("statistics.total")}</td>
              {tab.columnTotals.map((v, i) => (
                <td key={i} className="num">
                  {v.toLocaleString()}
                </td>
              ))}
              <td className="num">{tab.columnTotals.reduce((a, b) => a + b, 0).toLocaleString()}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default async function StatisticsPage() {
  const t = await getTranslator();
  const s = statistics();

  /**
   * Group the launch years by decade for the chart.
   *
   * 70 individual bars in a 140-pixel strip produced labels that overlapped into an
   * unreadable smear; a decade is the finest granularity that still fits, and the
   * question the chart answers ("when did the catalogue grow") is a decade-scale one.
   */
  const decadeMap = new Map<string, number>();
  for (const y of s.launchYears) {
    const year = Number(y.label);
    if (!Number.isFinite(year)) continue;
    const d = `${Math.floor(year / 10) * 10}s`;
    decadeMap.set(d, (decadeMap.get(d) ?? 0) + y.count);
  }
  const decades = [...decadeMap]
    .sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10))
    .map(([label, count]) => ({ label, count }));
  const maxDecade = Math.max(...decades.map((d) => d.count), 1);

  return (
    <>
      <Topbar section={`${t.t("nav.catalogueGroup")} · ${t.t("nav.statistics")}`} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t.t("statistics.title")}</h1>
          <span className="count">
            {s.total.toLocaleString()} {t.t("browse.objects")} ·{" "}
            {s.inOrbit.toLocaleString()} {t.t("statistics.inOrbit")}
          </span>
        </div>

        <div className="stat-grid">
          <BucketTable
            title={t.t("statistics.byRegime")}
            buckets={s.regime}
            total={s.total}
            labelFn={(v) => t.t(REGIME_KEYS[v] ?? v)}
          />
          <BucketTable
            title={t.t("statistics.byClass")}
            buckets={s.objectClass}
            total={s.total}
          />
          <BucketTable
            title={t.t("statistics.byPurpose")}
            buckets={s.purpose}
            total={s.total}
            labelFn={(v) => t.t(PURPOSE_KEYS[v] ?? v)}
          />
          <BucketTable
            title={t.t("statistics.byCountry")}
            buckets={s.country}
            total={s.total}
            limit={10}
          />
          <BucketTable
            title={t.t("statistics.byConstellation")}
            buckets={s.constellation}
            total={s.total}
            limit={10}
          />

          <div className="stat-card">
            <h3 className="stat-title">{t.t("statistics.massByRegime")}</h3>
            <table className="stat-table">
              <thead>
                <tr>
                  <th className="stat-label">{t.t("catalogue.regime")}</th>
                  <th className="stat-num">{t.t("statistics.count")}</th>
                  <th className="stat-num">{t.t("statistics.medianMass")}</th>
                  <th className="stat-num">{t.t("statistics.totalMass")}</th>
                </tr>
              </thead>
              <tbody>
                {s.massByRegime.map((m) => (
                  <tr key={m.regime}>
                    <td className="stat-label">{t.t(REGIME_KEYS[m.regime] ?? m.regime)}</td>
                    <td className="stat-num">{m.count.toLocaleString()}</td>
                    <td className="stat-num">{Math.round(m.medianKg).toLocaleString()}</td>
                    <td className="stat-num">
                      {(m.totalKg / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} t
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="stat-note">{t.t("statistics.massNote")}</p>
          </div>
        </div>

        <CrossTable
          title={t.t("statistics.constellationByRegime")}
          tab={s.constellationByRegime}
          labelFn={(v) => t.t(REGIME_KEYS[v] ?? v)}
        />

        <CrossTable
          title={t.t("statistics.classByRegime")}
          tab={s.classByRegime}
          labelFn={(v) => t.t(REGIME_KEYS[v] ?? v)}
        />

        <div className="stat-card stat-card-wide">
          <h3 className="stat-title">{t.t("statistics.launchYears")}</h3>
          <div className="histogram">
            {decades.map((d) => (
              <div key={d.label} className="histo-col" title={`${d.label}: ${d.count.toLocaleString()}`}>
                <div
                  className="histo-bar"
                  /*
                   * Pixels, not percent. A percentage height needs a definite height on
                   * the parent; inside a column flex box the parent's height comes from
                   * its contents, so `height: 40%` resolved against nothing and every bar
                   * rendered at zero — visible only as an empty chart.
                   */
                  style={{ height: `${Math.max((d.count / maxDecade) * 130, 2)}px` }}
                />
                <div className="histo-label">{d.label}</div>
              </div>
            ))}
          </div>
          <p className="stat-note">{t.t("statistics.launchYearsNote")}</p>
        </div>

        <div className="pager">
          <Link className="btn" href="/browse">
            {t.t("statistics.openBrowse")}
          </Link>
        </div>
      </div>
    </>
  );
}
