import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { getDb } from "@/db";
import { getTranslator } from "@/lib/i18n/registry";

export const dynamic = "force-dynamic";

interface Row {
  id: number;
  sat1Norad: number;
  sat1Name: string | null;
  sat2Norad: number;
  sat2Name: string | null;
  tca: string | null;
  minRangeKm: number | null;
  relSpeedKmS: number | null;
  maxProb: number | null;
  sat1TleAgeD: number | null;
  sat2TleAgeD: number | null;
  fetchedAt: string;
}

/**
 * CelesTrak SOCRATES conjunction screening, as mirrored by KeepTrack.
 *
 * ## Why this is shown beside our own screening rather than merged into it
 *
 * Our screening propagates our element sets and computes our own probability. SOCRATES
 * is an independent screen run by CelesTrak on theirs. Where the two agree, the event
 * is corroborated; where they disagree, one of the element sets is stale and that is
 * worth knowing. Merging them would destroy exactly that comparison.
 *
 * ## What the columns mean
 *
 * `max_prob` is CelesTrak's maximum collision probability over the event, not at TCA.
 * A dashed cell means the screen did not compute one — the API sends a sentinel of 1
 * for that case, which is filtered out at ingest because a probability of one is
 * indistinguishable from a certain collision.
 */
export default async function SocratesPage() {
  const t = await getTranslator();
  const { sqlite } = getDb();

  const tableExists = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='keeptrack_conjunction'")
      .get() as { n: number }
  ).n > 0;

  const rows = tableExists
    ? (sqlite
        .prepare(
          `SELECT id, sat1_norad AS sat1Norad, sat1_name AS sat1Name,
                  sat2_norad AS sat2Norad, sat2_name AS sat2Name, tca,
                  min_range_km AS minRangeKm, rel_speed_kms AS relSpeedKmS,
                  max_prob AS maxProb, sat1_tle_age_d AS sat1TleAgeD,
                  sat2_tle_age_d AS sat2TleAgeD, fetched_at AS fetchedAt
             FROM keeptrack_conjunction
            ORDER BY CASE WHEN min_range_km IS NULL THEN 1 ELSE 0 END, min_range_km ASC`,
        )
        .all() as Row[])
    : [];

  return (
    <>
      <Topbar section={t.t("nav.socrates")} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t.t("socrates.title")}</h1>
          <span className="count">
            {t.t("socrates.subtitle", { count: rows.length })}
          </span>
        </div>

        {rows.length === 0 ? (
          <div className="card">
            <div className="table-wrap">
              <p className="empty">
                {t.t("socrates.empty")}{" "}
                <code className="mono">npm run keeptrack:feeds -- --only conjunctions</code>
              </p>
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t.t("socrates.object1")}</th>
                    <th>{t.t("socrates.object2")}</th>
                    <th>{t.t("socrates.tca")}</th>
                    <th className="num">{t.t("socrates.missDistance")}</th>
                    <th className="num">{t.t("socrates.relSpeed")}</th>
                    <th className="num">{t.t("socrates.maxProb")}</th>
                    <th className="num">{t.t("socrates.tleAge")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/catalogue/${r.sat1Norad}`}>{r.sat1Name ?? r.sat1Norad}</Link>
                      </td>
                      <td>
                        <Link href={`/catalogue/${r.sat2Norad}`}>{r.sat2Name ?? r.sat2Norad}</Link>
                      </td>
                      <td className="mono-sm muted">{r.tca ? r.tca.replace("T", " ").slice(0, 19) : "—"}</td>
                      <td className="num">
                        {r.minRangeKm === null ? "—" : r.minRangeKm.toFixed(3)}
                      </td>
                      <td className="num">
                        {r.relSpeedKmS === null ? "—" : r.relSpeedKmS.toFixed(2)}
                      </td>
                      <td className="num">
                        {r.maxProb === null ? "—" : r.maxProb.toExponential(2)}
                      </td>
                      <td className="num muted">
                        {r.sat1TleAgeD === null && r.sat2TleAgeD === null
                          ? "—"
                          : `${r.sat1TleAgeD?.toFixed(1) ?? "—"} / ${r.sat2TleAgeD?.toFixed(1) ?? "—"}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p className="footnote">{t.t("socrates.footnote")}</p>
      </div>
    </>
  );
}
