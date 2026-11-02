import Link from "next/link";

import { Topbar } from "@/components/Shell";
import { SortableTh } from "@/components/SortableTh";
import { getTranslator } from "@/lib/i18n/registry";
import { countObjects, listObjects, OBJECT_SORTS, type ObjectFilters } from "@/lib/queries";
import { parseSort } from "@/lib/sort";
import { pageMetadata } from "@/lib/i18n/page-title";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return pageMetadata(t, t.t("objectsPage.title"));
}

export default async function ObjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const t = await getTranslator();
  const sort = parseSort(sp, OBJECT_SORTS, { key: "objectName", dir: "asc" });
  // A typed NORAD that is not a number is dropped rather than passed through: the
  // alternative is a filter box that silently returns everything.
  const filters: ObjectFilters = {
    alive: sp.alive === "true" ? true : sp.alive === "false" ? false : undefined,
    nameContains: sp.name?.trim() || undefined,
    noradId: /^[0-9]{1,9}$/.test(sp.norad ?? "") ? Number(sp.norad) : undefined,
  };
  const rows = listObjects(200, sort, filters);
  const total = countObjects(filters);

  return (
    <>
      <Topbar section={`${t.t("nav.catalogueGroup")} · ${t.t("nav.objects")}`} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t.t("objectsPage.title")}</h1>
          <span className="count">
            {t.t("objectsPage.showingCount", { shown: t.number(rows.length), total: t.number(total) })}
          </span>
        </div>

        {/*
          A real GET form. The previous version was three `<select>`s with no
          `name` and no enclosing form: it looked exactly like the official
          filter bar and filtered nothing, which is worse than having no filter.
          A plain form keeps it working without client JavaScript and makes the
          result URL shareable.
        */}
        <form className="filters" method="get">
          <button
            className="filter-btn"
            type="button"
            title={t.t("filter.title")}
            aria-label={t.t("filter.title")}
          >
            <FilterIcon />
          </button>
          <div className="filter-group">
            <span>{t.t("column.alive")}</span>
            <select name="alive" defaultValue={sp.alive ?? ""} aria-label={t.t("column.alive")}>
              <option value="">{t.t("filter.any")}</option>
              <option value="true">{t.t("filter.true")}</option>
              <option value="false">{t.t("filter.false")}</option>
            </select>
          </div>
          <div className="filter-group">
            <span>{t.t("column.name")}</span>
            <select defaultValue="contains" aria-label={t.t("filter.contains")} disabled>
              <option value="contains">{t.t("filter.contains")}</option>
            </select>
            <input
              name="name"
              defaultValue={sp.name ?? ""}
              aria-label={t.t("objectsPage.nameFilter")}
              placeholder={t.t("filter.contains")}
            />
          </div>
          <div className="filter-group">
            <span>{t.t("column.noradId")}</span>
            <select defaultValue="equals" aria-label={t.t("filter.equals")} disabled>
              <option value="equals">{t.t("filter.equals")}</option>
            </select>
            <input
              name="norad"
              defaultValue={sp.norad ?? ""}
              aria-label={t.t("objectsPage.noradFilter")}
              inputMode="numeric"
              placeholder={t.t("filter.equals")}
            />
          </div>
          <button className="btn" type="submit">
            {t.t("filter.apply")}
          </button>
          <Link className="btn" href="/objects">
            {t.t("filter.reset")}
          </Link>
          <div className="filters-spacer" />
        </form>

        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <SortableTh
                    label={t.t("column.name")}
                    column="objectName"
                    current={sort}
                    pathname="/objects"
                    params={sp}
                  />
                  <SortableTh
                    label={t.t("column.noradId")}
                    column="noradId"
                    current={sort}
                    pathname="/objects"
                    params={sp}
                  />
                  <th>{t.t("column.cospar")}</th>
                  <SortableTh
                    label={t.t("column.objectClass")}
                    column="objectClass"
                    current={sort}
                    pathname="/objects"
                    params={sp}
                  />
                  <th className="num">{t.t("column.mass")}</th>
                  <th className="num">{t.t("column.hardBodyRadius")}</th>
                  <SortableTh
                    label={t.t("column.country")}
                    column="country"
                    current={sort}
                    pathname="/objects"
                    params={sp}
                  />
                  <SortableTh
                    label={t.t("column.operator")}
                    column="operatorName"
                    current={sort}
                    pathname="/objects"
                    params={sp}
                  />
                  <SortableTh
                    label={t.t("column.alive")}
                    column="alive"
                    current={sort}
                    pathname="/objects"
                    params={sp}
                  />
                  <SortableTh
                    label={t.t("column.maneuverable")}
                    column="maneuverability"
                    current={sort}
                    pathname="/objects"
                    params={sp}
                  />
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/objects/${o.id}`}>{o.objectName}</Link>
                    </td>
                    <td className="mono-sm muted">{o.noradId ?? t.t("common.none")}</td>
                    <td className="mono-sm muted">{o.cosparId ?? t.t("common.none")}</td>
                    <td className="muted">{o.objectClass ?? t.t("common.none")}</td>
                    <td className="num">
                      {o.massKg === null
                        ? t.t("common.none")
                        : t.number(o.massKg, { maximumFractionDigits: 1 })}
                    </td>
                    <td className="num">{t.number(o.hardBodyRadius, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}</td>
                    <td className="muted">{o.country ?? t.t("common.none")}</td>
                    <td className="muted">{o.operatorName}</td>
                    <td>
                      <span className={`chip ${o.alive}`}>{String(o.alive)}</span>
                    </td>
                    <td>
                      <span className={`chip ${o.maneuverability}`}>
                        {String(o.maneuverability)}
                      </span>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={10} className="empty">
                      {t.t("objectsPage.empty")}{" "}
                      <code className="mono">{"POST /api/v1/object"}</code>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function FilterIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 4h18l-7 8v6l-4 2v-8z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
    </svg>
  );
}
