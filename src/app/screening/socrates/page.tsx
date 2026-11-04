import type { Metadata } from "next";
import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { getDb } from "@/db";
import { getTranslator } from "@/lib/i18n/registry";
import { pageMetadata } from "@/lib/i18n/page-title";
import { distanceLabel } from "@/lib/space-safety/distance";
import { countdownToIso, countdownUnits } from "@/lib/space-safety/gps";

export const dynamic = "force-dynamic";

/** Rows per page. The full screen is ~197 600 events; a page is not a dump. */
const PAGE_SIZE = 100;

/**
 * Below this relative speed the pair is co-orbiting, not converging.
 *
 * CelesTrak's screen reports every pair it propagates, including objects that travel
 * together: a docked Soyuz against the ISS, a released CubeSat against its dispenser,
 * cannon-satellite pairs from a single breakup. Those events are real rows with real
 * tiny miss distances, and one pair can occupy hundreds of them at 93-minute intervals
 * ("PRC TEST SPACECRAFT 4 CZ-2F DEB" fills most of the sub-kilometre band). They are
 * not encounters and they hide the ones that are.
 *
 * 1 km/s is not a threshold borrowed from a document; it is the gap CelesTrak's own data
 * shows. Orbiting encounters happen at a crossing angle and carry 7–15 km/s of relative
 * motion; co-orbiting pairs carry 0.00–0.5. Nothing in the 197 600 rows lands in between
 * at the sub-kilometre scale. The filter is a toggle, not a deletion: the rows are kept
 * and can be shown with `?paired=1`.
 */
const CO_ORBITING_KM_S = 1;

interface Row {
  norad1: number;
  name1: string;
  norad2: number;
  name2: string;
  tca: string | null;
  minRangeKm: number | null;
  relSpeedKmS: number | null;
  maxProb: number | null;
  age1D: number | null;
  age2D: number | null;
}

/**
 * CelesTrak's complete SOCRATES conjunction screening.
 *
 * ## Why this is shown beside our own screening rather than merged into it
 *
 * Our screening propagates our element sets and computes our own probability. SOCRATES
 * is an independent screen run by CelesTrak on theirs. Where the two agree, the event
 * is corroborated; where they disagree, one of the element sets is stale and that is
 * worth knowing. Merging them would destroy exactly that comparison.
 *
 * ## Where the data comes from
 *
 * `celestrak.org/SOCRATES/sort-minRange.csv` — 197 600 events, refreshed daily. The
 * KeepTrack mirror of the same feed (`/socrates/latest`) returns ten rows, all of them
 * the docked ISS/Soyuz pair at 6 m and zero relative speed, so it is not used.
 *
 * ## What the columns mean
 *
 * `maxProb` is CelesTrak's maximum collision probability over the event, not at TCA.
 * A dash means the screen did not compute one — the file sends `1.000E+00` for that
 * case, filtered out at ingest because a probability of one cannot be distinguished
 * from a certain collision.
 *
 * `age1D` / `age2D` are the days-since-epoch of each element set, i.e. how stale the
 * orbit solution behind the event was when the screen ran.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return pageMetadata(t, t.t("nav.socrates"));
}

/** Distance bands, in kilometres. `null` means "no filter". */
const RANGES: { key: string; maxKm: number | null }[] = [
  { key: "all", maxKm: null },
  { key: "lt1", maxKm: 1 },
  { key: "lt5", maxKm: 5 },
  { key: "lt25", maxKm: 25 },
  { key: "lt100", maxKm: 100 },
];

export default async function SocratesPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; upcoming?: string; page?: string; paired?: string }>;
}) {
  const sp = await searchParams;
  const t = await getTranslator();
  const { sqlite } = getDb();

  const tableExists = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='socrates_event'")
      .get() as { n: number }
  ).n > 0;

  const active = RANGES.find((r) => r.key === sp.range) ?? RANGES[0];
  const onlyUpcoming = sp.upcoming === "1";
  // Co-orbiting pairs are on by default. See `CO_ORBITING_KM_S`.
  const hidePaired = sp.paired !== "1";
  const page = Math.max(1, Math.floor(Number(sp.page ?? "1")) || 1);

  // The filters are a distance bound and a time bound. Both are indexed, and both are
  // enforced in SQL rather than after loading: 197 600 rows must never cross into the
  // renderer just to show a hundred.
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (active.maxKm !== null) {
    where.push("min_range_km < :maxKm");
    params.maxKm = active.maxKm;
  }
  if (onlyUpcoming) {
    where.push("tca > :now");
    params.now = new Date().toISOString();
  }
  if (hidePaired) {
    where.push("rel_speed_kms >= :pairedSpeed");
    params.pairedSpeed = CO_ORBITING_KM_S;
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = tableExists
    ? ((sqlite
        .prepare(`SELECT COUNT(*) AS n FROM socrates_event ${whereSql}`)
        .get(params) as { n: number } | undefined)?.n ?? 0)
    : 0;

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, pageCount);

  const rows = total
    ? (sqlite
        .prepare(
          `SELECT norad1, name1, norad2, name2, tca,
                  min_range_km AS minRangeKm, rel_speed_kms AS relSpeedKmS,
                  max_prob AS maxProb, age1_d AS age1D, age2_d AS age2D
             FROM socrates_event
             ${whereSql}
            ORDER BY CASE WHEN min_range_km IS NULL THEN 1 ELSE 0 END, min_range_km ASC
            LIMIT :limit OFFSET :offset`,
        )
        .all({ ...params, limit: PAGE_SIZE, offset: (current - 1) * PAGE_SIZE }) as Row[])
    : [];

  const meta = tableExists
    ? (Object.fromEntries(
        (
          sqlite.prepare("SELECT key, value FROM socrates_meta").all() as {
            key: string;
            value: string;
          }[]
        ).map((r) => [r.key, r.value]),
      ) as Record<string, string>)
    : {};

  /** Band counts, one query each: a filter that cannot say how much it hides is not useful. */
  const bandCounts = new Map<string, number>();
  if (tableExists) {
    const nowIso = new Date().toISOString();
    const base: string[] = [];
    if (onlyUpcoming) base.push("tca > :now");
    if (hidePaired) base.push("rel_speed_kms >= :pairedSpeed");
    const baseSql = base.length ? `AND ${base.join(" AND ")}` : "";
    const bind = { now: nowIso, pairedSpeed: CO_ORBITING_KM_S };
    bandCounts.set(
      "all",
      (
        sqlite
          .prepare(`SELECT COUNT(*) AS n FROM socrates_event WHERE 1 = 1 ${baseSql}`)
          .get(bind) as { n: number }
      ).n,
    );
    for (const r of RANGES.filter((x) => x.maxKm !== null)) {
      const got = sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM socrates_event
            WHERE min_range_km < :max ${baseSql}`,
        )
        .get({ ...bind, max: r.maxKm! }) as { n: number };
      bandCounts.set(r.key, got.n);
    }
  }

  const href = (patch: { range?: string; upcoming?: boolean; paired?: boolean }) => {
    const q = new URLSearchParams();
    const range = patch.range ?? active.key;
    if (range !== "all") q.set("range", range);
    const up = patch.upcoming ?? onlyUpcoming;
    if (up) q.set("upcoming", "1");
    // The default is "hidden"; only the deviation needs to be in the URL.
    const pairedShown = patch.paired ?? !hidePaired;
    if (pairedShown) q.set("paired", "1");
    const s = q.toString();
    return s ? `/screening/socrates?${s}` : "/screening/socrates";
  };

  const pageHref = (n: number) => {
    const q = new URLSearchParams();
    if (active.key !== "all") q.set("range", active.key);
    if (onlyUpcoming) q.set("upcoming", "1");
    if (!hidePaired) q.set("paired", "1");
    if (n > 1) q.set("page", String(n));
    const s = q.toString();
    return s ? `/screening/socrates?${s}` : "/screening/socrates";
  };

  const units = countdownUnits((k) => t.t(k));

  return (
    <>
      <Topbar section={t.t("nav.socrates")} />
      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">{t.t("socrates.title")}</h1>
            <span className="page-sub">
              {t.t("socrates.subtitle", { count: bandCounts.get("all") ?? 0 })}
            </span>
          </div>
          <span className="count">{t.t("socrates.matched", { count: total })}</span>
        </div>

        {!tableExists || (bandCounts.get("all") ?? 0) === 0 ? (
          <div className="card">
            <div className="table-wrap">
              <p className="empty">
                {t.t("socrates.empty")}{" "}
                <code className="mono">npm run socrates:sync</code>
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="filters">
              {RANGES.map((r) => (
                <Link
                  key={r.key}
                  href={href({ range: r.key })}
                  className={`btn${active.key === r.key ? " is-on" : ""}`}
                >
                  {t.t(`socrates.range.${r.key}`)}
                  <span className="faint"> {bandCounts.get(r.key) ?? 0}</span>
                </Link>
              ))}
              <Link
                href={href({ upcoming: !onlyUpcoming })}
                className={`btn${onlyUpcoming ? " is-on" : ""}`}
              >
                {t.t("filter.upcomingOnly")}
              </Link>
              <Link
                href={href({ paired: hidePaired })}
                className={`btn${hidePaired ? " is-on" : ""}`}
                title={t.t("socrates.pairedHint")}
              >
                {t.t("socrates.hidePaired")}
              </Link>
            </div>

            <div className="card">
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t.t("socrates.object1")}</th>
                      <th>{t.t("socrates.object2")}</th>
                      <th>{t.t("socrates.tca")}</th>
                      <th className="num">{t.t("socrates.countdown")}</th>
                      <th className="num">{t.t("socrates.missDistance")}</th>
                      <th className="num">{t.t("socrates.relSpeed")}</th>
                      <th className="num">{t.t("socrates.maxProb")}</th>
                      <th className="num">{t.t("socrates.tleAge")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.norad1}-${r.norad2}-${r.tca ?? ""}`}>
                        <td>
                          <Link href={`/catalogue/${r.norad1}`}>{r.name1}</Link>
                        </td>
                        <td>
                          <Link href={`/catalogue/${r.norad2}`}>{r.name2}</Link>
                        </td>
                        <td className="mono-sm muted">
                          {r.tca ? r.tca.replace("T", " ").slice(0, 19) : "—"}
                        </td>
                        <td className="num mono-sm faint">
                          {countdownToIso(r.tca, new Date(), units) ?? "—"}
                        </td>
                        <td className="num">{distanceLabel(r.minRangeKm, "—", (k) => t.t(k))}</td>
                        <td className="num">
                          {r.relSpeedKmS === null
                            ? "—"
                            : `${r.relSpeedKmS.toFixed(2)} ${t.t("unit.km")}/${t.t("unit.s")}`}
                        </td>
                        <td className="num">{r.maxProb === null ? "—" : r.maxProb.toExponential(2)}</td>
                        <td className="num muted">
                          {r.age1D === null && r.age2D === null
                            ? "—"
                            : `${r.age1D?.toFixed(1) ?? "—"} / ${r.age2D?.toFixed(1) ?? "—"}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="filters" style={{ marginTop: 12 }}>
              <span className="faint" style={{ fontSize: 12, marginRight: 8 }}>
                {t.t("socrates.pageOf", { page: current, pages: pageCount })}
              </span>
              {current > 1 && (
                <Link className="btn" href={pageHref(current - 1)}>
                  {t.t("socrates.prev")}
                </Link>
              )}
              {current < pageCount && (
                <Link className="btn" href={pageHref(current + 1)}>
                  {t.t("socrates.next")}
                </Link>
              )}
            </div>
          </>
        )}

        <p className="footnote">
          {t.t("socrates.footnote")}
          {meta.source_last_modified
            ? ` ${t.t("socrates.sourceStamp", {
                at: meta.source_last_modified.replace("GMT", "UTC"),
              })}`
            : ""}
        </p>
      </div>
    </>
  );
}
