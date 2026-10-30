import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { browse, type FacetName } from "@/lib/browse";
import { getTranslator } from "@/lib/i18n/registry";

export const dynamic = "force-dynamic";

const FACETS: Array<{ key: FacetName; labelKey: string }> = [
  { key: "regime", labelKey: "browse.regime" },
  { key: "constellation", labelKey: "browse.constellation" },
  { key: "country", labelKey: "browse.country" },
  { key: "purpose", labelKey: "browse.purpose" },
];

/** Human labels for the orbit regimes and purpose groups. */
const VALUE_LABELS: Record<string, Record<string, string>> = {
  regime: {
    LEO: "低轨 LEO",
    MEO: "中轨 MEO",
    GEO: "地球同步 GEO",
    HEO: "大椭圆 HEO",
    UNKNOWN: "未知",
  },
  purpose: {
    communication: "通信",
    navigation: "导航",
    "earth-observation": "对地观测",
    meteorology: "气象",
    science: "科学",
    military: "军事",
    technology: "技术试验",
  },
};

function label(facet: FacetName, value: string): string {
  return VALUE_LABELS[facet]?.[value] ?? value;
}

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const t = await getTranslator();
  const sp = await searchParams;

  const result = browse({
    regime: sp.regime,
    country: sp.country,
    constellation: sp.constellation,
    purpose: sp.purpose,
    q: sp.q,
    orbitsOnly: sp.orbits === "1",
    page: Number(sp.page ?? "1") || 1,
  });

  /** Keep every current filter except the one being changed. */
  const href = (over: Record<string, string | undefined>): string => {
    const p = new URLSearchParams();
    for (const k of ["regime", "country", "constellation", "purpose", "q", "orbits"]) {
      const v = over[k] ?? sp[k];
      if (v) p.set(k, v);
    }
    if (over.page) p.set("page", over.page);
    const s = p.toString();
    return s ? `/browse?${s}` : "/browse";
  };

  const selected = FACETS.map((f) => ({ ...f, value: sp[f.key] })).filter((f) => f.value);
  const pages = Math.max(Math.ceil(result.total / result.pageSize), 1);

  return (
    <>
      <Topbar section={t.t("nav.browse")} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t.t("browse.title")}</h1>
          <span className="count">
            {result.total.toLocaleString()} {t.t("browse.objects")}
          </span>
        </div>

        <form method="get" className="filters">
          {selected.map((s) => (
            <input key={s.key} type="hidden" name={s.key} value={s.value} />
          ))}
          <div className="filter-group">
            <span>{t.t("column.name")}</span>
            <input name="q" defaultValue={sp.q ?? ""} aria-label={t.t("column.name")} />
          </div>
          <button type="submit" className="btn">
            {t.t("catalogue.search")}
          </button>
          <label className="check-inline">
            <input type="checkbox" name="orbits" value="1" defaultChecked={sp.orbits === "1"} />
            {t.t("browse.orbitsOnly")}
          </label>
          <div className="filters-spacer" />
          {selected.length > 0 && (
            <Link className="btn" href="/browse">
              {t.t("browse.clear")}
            </Link>
          )}
        </form>

        <div className="browse-layout">
          <aside className="facet-rail">
            {FACETS.map((f) => (
              <div key={f.key} className="facet">
                <div className="facet-title">{t.t(f.labelKey)}</div>
                <div className="facet-values">
                  {result.facets[f.key].map((v) => {
                    const active = sp[f.key] === v.value;
                    return (
                      <Link
                        key={v.value}
                        href={href({ [f.key]: active ? undefined : v.value, page: undefined })}
                        className={`facet-item${active ? " active" : ""}`}
                      >
                        <span className="facet-label">{label(f.key, v.value)}</span>
                        <span className="facet-count">{v.count.toLocaleString()}</span>
                      </Link>
                    );
                  })}
                  {result.facets[f.key].length === 0 && (
                    <div className="facet-item muted">{t.t("browse.none")}</div>
                  )}
                </div>
              </div>
            ))}
          </aside>

          <div className="browse-main">
            <div className="card">
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th className="num">{t.t("catalogue.norad")}</th>
                      <th>{t.t("column.name")}</th>
                      <th>{t.t("catalogue.constellation")}</th>
                      <th>{t.t("catalogue.regime")}</th>
                      <th>{t.t("column.country")}</th>
                      <th>{t.t("column.objectClass")}</th>
                      <th className="num">{t.t("column.mass")}</th>
                      <th className="num">{t.t("catalogue.inclination")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((o) => (
                      <tr key={o.noradId}>
                        <td className="num mono-sm muted">{o.noradId}</td>
                        <td>
                          <Link href={`/catalogue/${o.noradId}`}>{o.name ?? "—"}</Link>
                        </td>
                        <td className="muted">{o.constellation ?? "—"}</td>
                        <td>
                          <span className={`chip ${o.regime === "LEO" ? "true" : "false"}`}>
                            {o.regime ?? "—"}
                          </span>
                        </td>
                        <td className="muted">{o.country ?? "—"}</td>
                        <td className="muted">{o.objectClass ?? "—"}</td>
                        <td className="num">
                          {o.massKg === null
                            ? "—"
                            : o.massKg.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                        </td>
                        <td className="num">
                          {o.inclinationDeg === null ? "—" : o.inclinationDeg.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                    {result.rows.length === 0 && (
                      <tr>
                        <td colSpan={8} className="empty">
                          {t.t("catalogue.noMatch")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="pager">
              {result.page > 1 && (
                <Link className="btn" href={href({ page: String(result.page - 1) })}>
                  {t.t("catalogue.prev")}
                </Link>
              )}
              <span className="count">
                {result.page} / {pages}
              </span>
              {result.page < pages && (
                <Link className="btn" href={href({ page: String(result.page + 1) })}>
                  {t.t("catalogue.next")}
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
