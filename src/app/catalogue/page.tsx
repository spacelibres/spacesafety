import Link from "next/link";

import { getTranslator } from "@/lib/i18n/registry";

import { Topbar } from "@/components/Shell";
import {
  countWideObjects,
  FIELD_LABELS,
  listWideObjects,
  SOURCE_LABELS,
  wideCatalogueAvailable,
  wideStats,
} from "@/lib/wide-catalogue";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function CataloguePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; norad?: string }>;
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

  return (
    <>
      <Topbar section="编目数据库" />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">编目数据库</h1>
          <span className="count">三源并列 · {stats.objects.toLocaleString()} 个对象</span>
        </div>

        {!available ? (
          <div className="card" style={{ padding: 20 }}>
            <p>
              宽表尚未构建。运行{" "}
              <code className="mono">npx tsx tools/build-wide-catalogue.ts</code> 生成{" "}
              <code className="mono">data/catalogue-wide.sqlite</code>。
            </p>
          </div>
        ) : (
          <>
            <div className="card" style={{ padding: "14px 18px", marginBottom: 16 }}>
              <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 13 }}>
                {(["spacetrack", "spacebook", "discos"] as const).map((s) => (
                  <span key={s} className="muted">
                    {SOURCE_LABELS[s].long}
                  </span>
                ))}
              </div>
            </div>

            <form method="get" className="filters">
              <div className="filter-group">
                <span>名称</span>
                <input name="q" defaultValue={sp.q ?? ""} placeholder="包含…" />
              </div>
              <div className="filter-group">
                <span>{t.t("catalogue.norad")}</span>
                <input name="norad" defaultValue={sp.norad ?? ""} placeholder="编号" />
              </div>
              <button type="submit" className="filter-btn">
                查询
              </button>
              <div className="filters-spacer" />
              <span className="count">
                第 {page} / {pages} 页
              </span>
            </form>

            <div className="card">
              <div className="table-wrap" style={{ borderTop: "none" }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t.t("catalogue.norad")}</th>
                      <th>名称</th>
                      <th>{t.t("catalogue.cospar")}</th>
                      <th>分类</th>
                      <th>国家</th>
                      <th className="num">质量 (kg)</th>
                      <th className="num">硬体半径 (m)</th>
                      <th className="num">倾角 (°)</th>
                      <th>分歧</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((o) => (
                      <tr key={o.noradId}>
                        <td className="mono-sm muted">{o.noradId}</td>
                        <td>
                          <Link href={`/catalogue/${o.noradId}`}>{o.name ?? "—"}</Link>
                        </td>
                        <td className="mono-sm muted">{o.cosparId ?? "—"}</td>
                        <td className="muted">{o.objectClass ?? "—"}</td>
                        <td className="muted">{o.country ?? "—"}</td>
                        <td className="num">
                          {o.massKg === null
                            ? "—"
                            : o.massKg.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                        </td>
                        <td className="num">
                          {o.hardBodyRadiusM === null ? "—" : o.hardBodyRadiusM.toFixed(3)}
                        </td>
                        <td className="num">
                          {o.inclinationDeg === null ? "—" : o.inclinationDeg.toFixed(2)}
                        </td>
                        <td>
                          {o.disagreementCount > 0 ? (
                            <span className="chip false">{o.disagreementCount}</span>
                          ) : (
                            <span className="chip true">0</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={9} className="empty">
                          无匹配对象
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ display: "flex", gap: 12, marginTop: 14 }}>
              {page > 1 && (
                <Link
                  className="filter-btn"
                  href={`/catalogue?page=${page - 1}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}`}
                >
                  上一页
                </Link>
              )}
              {page < pages && (
                <Link
                  className="filter-btn"
                  href={`/catalogue?page=${page + 1}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}`}
                >
                  下一页
                </Link>
              )}
            </div>

            <h2 className="page-title" style={{ fontSize: 15, marginTop: 32 }}>
              字段来源覆盖
            </h2>
            <div className="card">
              <div className="table-wrap" style={{ borderTop: "none" }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>字段</th>
                      <th className="num">{t.t("catalogue.sourceSpaceTrack")}</th>
                      <th className="num">{t.t("catalogue.sourceSpacebook")}</th>
                      <th className="num">{t.t("catalogue.sourceDiscos")}</th>
                      <th className="num">合并可用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.coverage.map((c) => {
                      const union = Math.max(c.spacetrack, c.spacebook, c.discos);
                      return (
                        <tr key={c.field}>
                          <td>{FIELD_LABELS[c.field]}</td>
                          <td className="num muted">
                            {c.spacetrack ? `${((c.spacetrack / stats.objects) * 100).toFixed(2)}%` : "—"}
                          </td>
                          <td className="num muted">
                            {c.spacebook ? `${((c.spacebook / stats.objects) * 100).toFixed(2)}%` : "—"}
                          </td>
                          <td className="num muted">
                            {c.discos ? `${((c.discos / stats.objects) * 100).toFixed(2)}%` : "—"}
                          </td>
                          <td className="num">{((union / stats.objects) * 100).toFixed(2)}%</td>
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
