import Link from "next/link";

import { DownloadMenu } from "@/components/DownloadMenu";
import { Topbar } from "@/components/Shell";
import { SortableTh } from "@/components/SortableTh";
import { getTranslator } from "@/lib/i18n/registry";
import { countObjects, listObjects, OBJECT_SORTS, type ObjectFilters } from "@/lib/queries";
import { parseSort } from "@/lib/sort";
import { pageMetadata } from "@/lib/i18n/page-title";
import { columnsCookie, visibleColumns } from "@/lib/columns";
import { ColumnSettings } from "@/components/ColumnSettings";
import { cookies } from "next/headers";
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

  // Column preference: a display choice, read on the server so the table is
  // rendered once with exactly the columns chosen — no second client-side copy.
  const columnDefs = [
    { key: "objectName", label: t.t("column.name") },
    { key: "noradId", label: t.t("column.noradId") },
    { key: "cosparId", label: t.t("column.cospar") },
    { key: "objectClass", label: t.t("column.objectClass") },
    { key: "mass", label: t.t("column.mass") },
    { key: "hardBodyRadius", label: t.t("column.hardBodyRadius") },
    { key: "country", label: t.t("column.country") },
    { key: "operator", label: t.t("column.operator") },
    { key: "alive", label: t.t("column.alive") },
    { key: "maneuverable", label: t.t("column.maneuverable") },
  ] as const;
  const allKeys = columnDefs.map((c) => c.key);
  const cookie = (await cookies()).get(columnsCookie("objects"))?.value;
  const shown = new Set(visibleColumns(decodeURIComponent(cookie ?? ""), allKeys, "objectName"));
  // The export re-applies the same filters, so a download is the table the
  // reader is looking at and not a different one.
  const exportQuery = new URLSearchParams({ what: "objects" });
  if (sp.alive) exportQuery.set("alive", sp.alive);
  if (sp.name) exportQuery.set("name", sp.name);
  if (sp.norad) exportQuery.set("norad", sp.norad);

  return (
    <>
      <Topbar section={`${t.t("nav.catalogueGroup")} · ${t.t("nav.objects")}`} />
      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">{t.t("objectsPage.title")}</h1>
            <span className="page-sub">{t.t("download.hint")}</span>
          </div>
          <span className="count">
            {t.t("objectsPage.showingCount", { shown: t.number(rows.length), total: t.number(total) })}
          </span>
          <DownloadMenu
            label={t.t("download.label")}
            items={[
              { label: t.t("download.csv"), href: `/api/export?${exportQuery.toString()}&format=csv` },
              { label: t.t("download.json"), href: `/api/export?${exportQuery.toString()}&format=json` },
            ]}
          />
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
        {/* The gear the reference UI puts at the end of the filter bar. It sits
            outside the form so a click does not submit the filters. */}
        <div className="filters">
          <div className="filters-spacer" />
          <ColumnSettings table="objects" columns={columnDefs} visible={[...shown]} />
        </div>

        <div className="card">
          <div className="table-wrap" style={{ borderTop: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  {shown.has("objectName") && (
                    <SortableTh
                      label={t.t("column.name")}
                      column="objectName"
                      current={sort}
                      pathname="/objects"
                      params={sp}
                    />
                  )}
                  {shown.has("noradId") && (
                    <SortableTh
                      label={t.t("column.noradId")}
                      column="noradId"
                      current={sort}
                      pathname="/objects"
                      params={sp}
                    />
                  )}
                  {shown.has("cosparId") && <th>{t.t("column.cospar")}</th>}
                  {shown.has("objectClass") && (
                    <SortableTh
                      label={t.t("column.objectClass")}
                      column="objectClass"
                      current={sort}
                      pathname="/objects"
                      params={sp}
                    />
                  )}
                  {shown.has("mass") && <th className="num">{t.t("column.mass")}</th>}
                  {shown.has("hardBodyRadius") && (
                    <th className="num">{t.t("column.hardBodyRadius")}</th>
                  )}
                  {shown.has("country") && (
                    <SortableTh
                      label={t.t("column.country")}
                      column="country"
                      current={sort}
                      pathname="/objects"
                      params={sp}
                    />
                  )}
                  {shown.has("operator") && (
                    <SortableTh
                      label={t.t("column.operator")}
                      column="operatorName"
                      current={sort}
                      pathname="/objects"
                      params={sp}
                    />
                  )}
                  {shown.has("alive") && (
                    <SortableTh
                      label={t.t("column.alive")}
                      column="alive"
                      current={sort}
                      pathname="/objects"
                      params={sp}
                    />
                  )}
                  {shown.has("maneuverable") && (
                    <SortableTh
                      label={t.t("column.maneuverable")}
                      column="maneuverability"
                      current={sort}
                      pathname="/objects"
                      params={sp}
                    />
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    {shown.has("objectName") && (
                      <td>
                        <Link href={`/objects/${o.id}`}>{o.objectName}</Link>
                      </td>
                    )}
                    {shown.has("noradId") && (
                      <td className="mono-sm muted">{o.noradId ?? t.t("common.none")}</td>
                    )}
                    {shown.has("cosparId") && (
                      <td className="mono-sm muted">{o.cosparId ?? t.t("common.none")}</td>
                    )}
                    {shown.has("objectClass") && (
                      <td className="muted">{o.objectClass ?? t.t("common.none")}</td>
                    )}
                    {shown.has("mass") && (
                      <td className="num">
                        {o.massKg === null
                          ? t.t("common.none")
                          : t.number(o.massKg, { maximumFractionDigits: 1 })}
                      </td>
                    )}
                    {shown.has("hardBodyRadius") && (
                      <td className="num">
                        {t.number(o.hardBodyRadius, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </td>
                    )}
                    {shown.has("country") && (
                      <td className="muted">{o.country ?? t.t("common.none")}</td>
                    )}
                    {shown.has("operator") && <td className="muted">{o.operatorName}</td>}
                    {shown.has("alive") && (
                      <td>
                        <span className={`chip ${o.alive}`}>{String(o.alive)}</span>
                      </td>
                    )}
                    {shown.has("maneuverable") && (
                      <td>
                        <span className={`chip ${o.maneuverability}`}>
                          {String(o.maneuverability)}
                        </span>
                      </td>
                    )}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={shown.size} className="empty">
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
