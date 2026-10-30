import Link from "next/link";

import { getTranslator } from "@/lib/i18n/registry";
import { Topbar } from "@/components/Shell";
import {
  countWideObjects,
  FIELD_LABEL_KEYS,
  listWideObjects,
  SOURCE_IDS,
  SOURCE_LABEL_KEYS,
  wideCatalogueAvailable,
  wideStats,
} from "@/lib/wide-catalogue";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function CataloguePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; norad?: string; page?: string }>;
}) {
  const t = await getTranslator();
  const sp = await searchParams;
  const available = wideCatalogueAvailable();

  const page = Math.max(Number(sp.page ?? "1") || 1, 1);
  const norad = sp.norad ? Number(sp.norad) : undefined;

  const rows = available
    ? listWideObjects({
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        nameContains: sp.q || undefined,
        noradId: Number.isFinite(norad) ? norad : undefined,
      })
    : [];
  const total = available ? countWideObjects() : 0;
  const stats = available ? wideStats() : { objects: 0, coverage: [] };
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const query = sp.q ? `&q=${encodeURIComponent(sp.q)}` : "";

  return (
    <>
      <Topbar section={`${t.t("nav.catalogueGroup")} · ${t.t("nav.catalogue")}`} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t.t("nav.catalogue")}</h1>
          <span className="count">
            {t.t("catalogue.sources")} · {stats.objects.toLocaleString()} {t.t("catalogue.objects")}
          </span>
        </div>

        {!available ? (
          <div className="card">
            <div className="table-wrap">
              <p className="empty">
                {t.t("catalogue.notBuilt")}{" "}
                <code className="mono">npx tsx tools/build-wide-catalogue.ts</code>
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="filters">
              <span className="count">{t.t("catalogue.sources")}</span>
              <span className="count muted">
                {SOURCE_IDS.map((s) => t.t(SOURCE_LABEL_KEYS[s])).join(" · ")}
              </span>
            </div>

            <form method="get" className="filters">
              <div className="filter-group">
                <span>{t.t("column.name")}</span>
                <input name="q" defaultValue={sp.q ?? ""} aria-label={t.t("column.name")} />
              </div>
              <div className="filter-group">
                <span>{t.t("catalogue.norad")}</span>
                <input name="norad" defaultValue={sp.norad ?? ""} aria-label={t.t("catalogue.norad")} />
              </div>
              <button type="submit" className="btn">
                {t.t("catalogue.search")}
              </button>
              <div className="filters-spacer" />
              <span className="count">
                {page} / {pages}
              </span>
            </form>

            <div className="card">
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th className="num">{t.t("catalogue.norad")}</th>
                      <th>{t.t("column.name")}</th>
                      <th>{t.t("catalogue.constellation")}</th>
                      <th>{t.t("catalogue.regime")}</th>
                      <th>{t.t("column.objectClass")}</th>
                      <th>{t.t("column.country")}</th>
                      <th className="num">{t.t("column.mass")}</th>
                      <th className="num">{t.t("catalogue.inclination")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((o) => (
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
                        <td className="muted">{o.objectClass ?? "—"}</td>
                        <td className="muted">{o.country ?? "—"}</td>
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
                    {rows.length === 0 && (
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
              {page > 1 && (
                <Link className="btn" href={`/catalogue?page=${page - 1}${query}`}>
                  {t.t("catalogue.prev")}
                </Link>
              )}
              {page < pages && (
                <Link className="btn" href={`/catalogue?page=${page + 1}${query}`}>
                  {t.t("catalogue.next")}
                </Link>
              )}
            </div>

            <div className="page-head section-head">
              <h2 className="page-title">{t.t("catalogue.fieldCoverage")}</h2>
            </div>

            <div className="card">
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t.t("catalogue.field")}</th>
                      {SOURCE_IDS.map((s) => (
                        <th key={s} className="num">
                          {t.t(SOURCE_LABEL_KEYS[s])}
                        </th>
                      ))}
                      <th className="num">{t.t("catalogue.union")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.coverage.map((c) => {
                      const pct = (n: number) =>
                        n ? `${((n / stats.objects) * 100).toFixed(1)}%` : "—";
                      return (
                        <tr key={c.field}>
                          <td className="muted">{t.t(FIELD_LABEL_KEYS[c.field])}</td>
                          {SOURCE_IDS.map((s) => (
                            <td key={s} className="num muted">
                              {pct(c.values[s])}
                            </td>
                          ))}
                          {/* The union comes from SQL, not from the largest cell:
                              the sources cover different objects, so a maximum
                              understates the catalogue badly. */}
                          <td className="num">{pct(c.union)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
