import Link from "next/link";
import { notFound } from "next/navigation";

import { Markdown, localised } from "@/components/Markdown";
import { Topbar } from "@/components/Shell";
import {
  docsEndpoints,
  docsNav,
  endpointBySlug,
  loadDocPage,
  stripTitle,
  type DocSection,
  type Endpoint,
  type LoadedDocPage,
} from "@/lib/docs";
import { currentLocale, getTranslator } from "@/lib/i18n/registry";
import { pageMetadata } from "@/lib/i18n/page-title";
import type { Metadata } from "next";
import type { Translator } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/**
 * The documentation area.
 *
 * ## Information architecture
 *
 * Mirrors the upstream documentation set page for page — getting started, API
 * reference, tutorials, articles — because a reader who has used the official docs
 * should not have to relearn the shape of this one. The content itself is written
 * from this deployment's behaviour, not copied: prose that described someone else's
 * service would be worse than none.
 *
 * ## Routes
 *
 *   /docs                      index
 *   /docs/api                  endpoint groups
 *   /docs/api/<endpoint>       one endpoint's reference
 *   /docs/<section>            section index
 *   /docs/<page>               a page (sections are navigation, not directories)
 *   /docs/<section>/<page>     the same page under its section path
 *
 * Section paths exist so the links inside the content — which use the full
 * `/docs/<section>/<page>` form — resolve without a redirect.
 */
/**
 * A docs page's title is the page it shows, not the site name: six open tabs of
 * "Documentation" is the same problem six object tabs had.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const segments = slug ?? [];
  const locale = await currentLocale();
  const t = await getTranslator();
  const nav = docsNav();

  if (segments.length === 0) return pageMetadata(t, t.t("docs.indexTitle"));
  if (segments[0] === "api") {
    if (segments[1]) {
      const endpoint = endpointBySlug(segments[1]);
      if (endpoint) return pageMetadata(t, `${localised(endpoint.title, locale)} · ${endpoint.method} ${endpoint.path}`);
    }
    return pageMetadata(t, t.t("docs.apiReference"));
  }
  for (const section of nav.sections) {
    const page = section.pages?.find((p) => p.slug === (segments[1] ?? segments[0]));
    if (page) return pageMetadata(t, `${localised(page.title, locale)} · ${localised(section.title, locale)}`);
    if (section.id === segments[0]) return pageMetadata(t, localised(section.title, locale));
  }
  return pageMetadata(t, t.t("docs.indexTitle"));
}

export default async function DocsPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  const segments = slug ?? [];
  const t = await getTranslator();
  const locale = await currentLocale();

  if (segments.length === 0) return <DocsIndex locale={locale} />;
  if (segments.length > 2) notFound();

  const [first, second] = segments;

  // ---- /docs/api and /docs/api/<endpoint> ---------------------------------
  if (first === "api") {
    if (!second) return <ApiIndex locale={locale} />;
    const endpoint = endpointBySlug(second);
    if (!endpoint) notFound();
    return <EndpointPage endpoint={endpoint} locale={locale} />;
  }

  // ---- /docs/<section> ----------------------------------------------------
  const nav = docsNav();
  const section = nav.sections.find((s) => s.id === first);
  if (section && !second) {
    if (section.endpoints) return <ApiIndex locale={locale} />;
    return <SectionIndex section={section} locale={locale} />;
  }

  // ---- /docs/<page> or /docs/<section>/<page> -----------------------------
  const pageSlug = second ?? first;
  if (second) {
    // A two-segment path is only valid under its own section.
    if (!section || section.endpoints || !section.pages?.some((p) => p.slug === second)) {
      notFound();
    }
  }
  const page = loadDocPage(locale, pageSlug);
  if (!page) notFound();
  return <ProsePage page={page} locale={locale} t={t} />;
}

const METHODS_WITH_BODY = new Set(["POST", "PATCH", "PUT"]);

async function DocsIndex({ locale }: { locale: string }) {
  const t = await getTranslator();
  const nav = docsNav();
  const { endpoints } = docsEndpoints();
  const official = endpoints.filter((e) => !e.extension).length;
  const extensions = endpoints.length - official;

  return (
    <>
      <Topbar section={t.t("nav.docs")} />
      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">{t.t("docs.indexTitle")}</h1>
            <span className="page-sub">{t.t("docs.indexLead")}</span>
          </div>
          <span className="count">
            {t.t("docs.indexCounts", {
              pages: official,
              extensions,
              articles: nav.sections.flatMap((s) => s.pages ?? []).length,
            })}
          </span>
        </div>

        <div className="banner info" style={{ marginBottom: 16 }}>
          {t.t("docs.indexNote")}
        </div>

        <div className="doc-grid">
          {nav.sections.map((section) => (
            <Link className="doc-card" href={`/docs/${section.id}`} key={section.id}>
              <span className="doc-card-title">{localised(section.title, locale)}</span>
              <span className="doc-card-sub">
                {section.endpoints
                  ? t.t("docs.endpointCount", { count: endpoints.length })
                  : t.t("docs.pageCount", { count: section.pages?.length ?? 0 })}
              </span>
            </Link>
          ))}
        </div>

        <SectionList locale={locale} />
      </div>
    </>
  );
}

/** Flat list of every page, grouped by section — the "everything" view. */
async function SectionList({ locale }: { locale: string }) {
  const nav = docsNav();
  const t = await getTranslator();
  return (
    <>
      {nav.sections
        .filter((s) => !s.endpoints)
        .map((section) => (
          <section className="card" style={{ marginTop: 16 }} key={section.id}>
            <div className="card-head">{localised(section.title, locale)}</div>
            <div className="card-body" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {(section.pages ?? []).map((page) => (
                <Link className="btn" href={`/docs/${section.id}/${page.slug}`} key={page.slug}>
                  {localised(page.title, locale)}
                </Link>
              ))}
            </div>
          </section>
        ))}
      <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
        {/* The index has no body of its own, so it cannot have "fallen back" —
            using the fallback notice here told a Chinese reader that their page
            was showing English, which was false. This states the policy instead;
            the notice stays on pages that actually fall back. */}
        {t.t("docs.localePolicy")}
      </p>
    </>
  );
}

async function SectionIndex({
  section,
  locale,
}: {
  section: DocSection;
  locale: string;
}) {
  const t = await getTranslator();
  return (
    <>
      <Topbar section={`${t.t("nav.docs")} · ${localised(section.title, locale)}`} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{localised(section.title, locale)}</h1>
          <span className="count">
            {t.t("docs.pageCount", { count: section.pages?.length ?? 0 })}
          </span>
        </div>
        <div className="doc-grid">
          {(section.pages ?? []).map((page, i) => (
            <Link className="doc-card" href={`/docs/${section.id}/${page.slug}`} key={page.slug}>
              <span className="doc-card-title">{localised(page.title, locale)}</span>
              <span className="doc-card-sub">{`${i + 1} / ${section.pages?.length ?? 0}`}</span>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}

async function ApiIndex({ locale }: { locale: string }) {
  const t = await getTranslator();
  const nav = docsNav();
  const { endpoints, baseUrl, note } = docsEndpoints();
  const groups = nav.sections.find((s) => s.endpoints)?.groups ?? [];

  return (
    <>
      <Topbar section={`${t.t("nav.docs")} · ${t.t("docs.endpoints")}`} />
      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">{t.t("docs.apiReference")}</h1>
            <span className="page-sub">{note}</span>
          </div>
          <span className="count">{t.t("docs.endpointCount", { count: endpoints.length })}</span>
        </div>

        <div className="banner info" style={{ marginBottom: 16 }}>
          {t.t("docs.authLead")} <code className="mono">401 RBAC: access denied</code>.
        </div>

        {groups.map((group) => {
          const rows = endpoints.filter((e) => e.section === group.id);
          if (rows.length === 0) return null;
          return (
            <section className="card" style={{ marginBottom: 16 }} key={group.id}>
              <div className="card-head">{localised(group.title, locale)}</div>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t.t("docs.method")}</th>
                      <th>{t.t("docs.path")}</th>
                      <th>{t.t("column.description")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((endpoint) => (
                      <tr key={endpoint.slug}>
                        <td className="mono-sm">{endpoint.method}</td>
                        <td className="mono-sm">
                          <Link href={`/docs/api/${endpoint.slug}`}>{endpoint.path}</Link>
                        </td>
                        <td className="muted">
                          {localised(endpoint.summary, locale)}
                          {endpoint.extension ? (
                            <span className="chip neutral" style={{ marginLeft: 6 }}>
                              {t.t("docs.extension")}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}

        <p className="faint" style={{ fontSize: 12 }}>
          {t.t("docs.baseUrl")} <code className="mono">{baseUrl}</code>
        </p>
      </div>
    </>
  );
}

async function EndpointPage({ endpoint, locale }: { endpoint: Endpoint; locale: string }) {
  const t = await getTranslator();
  const groups = docsNav().sections.find((s) => s.endpoints)?.groups ?? [];
  const group = groups.find((g) => g.id === endpoint.section);
  const all = docsEndpoints().endpoints;
  const index = all.findIndex((e) => e.slug === endpoint.slug);
  const prev = index > 0 ? all[index - 1] : null;
  const next = index >= 0 && index < all.length - 1 ? all[index + 1] : null;

  const params = endpoint.params;
  const hasBody = METHODS_WITH_BODY.has(endpoint.method) || endpoint.body.length > 0;

  return (
    <>
      <Topbar
        section={`${t.t("nav.docs")} · ${group ? localised(group.title, locale) : t.t("docs.endpoints")}`}
      />
      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">
              {localised(endpoint.title, locale)}
              {endpoint.extension ? (
                <span className="chip neutral" style={{ marginLeft: 8 }}>
                  {t.t("docs.extension")}
                </span>
              ) : null}
            </h1>
            <span className="page-sub">{localised(endpoint.summary, locale)}</span>
          </div>
        </div>

        <pre className="doc-pre doc-endpoint">
          <code className="mono-sm">
            {`${endpoint.method} ${endpoint.path}`}
          </code>
        </pre>

        {params.length > 0 && (
          <section className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">{t.t("docs.requestParams")}</div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t.t("docs.name")}</th>
                    <th>{t.t("docs.in")}</th>
                    <th>{t.t("docs.type")}</th>
                    <th>{t.t("docs.required")}</th>
                    <th>{t.t("column.description")}</th>
                  </tr>
                </thead>
                <tbody>
                  {params.map((p) => (
                    <tr key={`${p.in}:${p.name}`}>
                      <td className="mono-sm">
                        {p.name}
                        {p.extension ? (
                          <span className="chip neutral" style={{ marginLeft: 6 }}>
                            {t.t("docs.extension")}
                          </span>
                        ) : null}
                      </td>
                      <td className="muted mono-sm">{p.in}</td>
                      <td className="mono-sm">
                        {p.type}
                        {p.values ? <span className="faint"> · {p.values.join(" | ")}</span> : null}
                      </td>
                      <td className="muted">
                        {p.required ? t.t("docs.requiredYes") : t.t("docs.requiredNo")}
                        {p.default ? (
                          <span className="faint mono-sm"> · {p.default}</span>
                        ) : null}
                      </td>
                      <td>{localised(p.desc, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {hasBody && endpoint.body.length > 0 && (
          <section className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">{t.t("docs.requestBody")}</div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t.t("docs.name")}</th>
                    <th>{t.t("docs.type")}</th>
                    <th>{t.t("docs.required")}</th>
                    <th>{t.t("column.description")}</th>
                  </tr>
                </thead>
                <tbody>
                  {endpoint.body.map((field) => (
                    <tr key={field.name}>
                      <td className="mono-sm">{field.name}</td>
                      <td className="mono-sm">
                        {field.type}
                        {field.values ? <span className="faint"> · {field.values.join(" | ")}</span> : null}
                      </td>
                      <td className="muted">
                        {field.required ? t.t("docs.requiredYes") : t.t("docs.requiredNo")}
                      </td>
                      <td>{localised(field.desc, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">{t.t("docs.responses")}</div>
          <div className="card-body">
            {endpoint.responses.map((response) => (
              <div key={response.status} style={{ marginBottom: 14 }}>
                <div className="doc-status">
                  <span className={`chip ${response.status < 300 ? "true" : response.status < 500 ? "false" : "neutral"}`}>
                    {response.status}
                  </span>
                  <span className="muted">{localised(response.meaning, locale)}</span>
                </div>
                {response.fields && response.fields.length > 0 && (
                  <table className="kv" style={{ marginTop: 6 }}>
                    <tbody>
                      {response.fields.map(([name, type]) => (
                        <tr key={name}>
                          <td className="k mono-sm">{name}</td>
                          <td className="v-mono">{type}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {response.example !== undefined && (
                  <pre className="doc-pre">
                    <code className="mono-sm">
                      {typeof response.example === "string"
                        ? response.example
                        : JSON.stringify(response.example, null, 2)}
                    </code>
                  </pre>
                )}
              </div>
            ))}
          </div>
        </section>

        {endpoint.notes && endpoint.notes.length > 0 && (
          <section className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">{t.t("docs.notes")}</div>
            <div className="card-body">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {endpoint.notes.map((note, i) => (
                  <li key={i} style={{ marginBottom: 6 }}>
                    {localised(note, locale)}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        <nav className="doc-nav">
          {prev ? (
            <Link className="btn" href={`/docs/api/${prev.slug}`}>
              ← {localised(prev.title, locale)}
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link className="btn" href={`/docs/api/${next.slug}`}>
              {localised(next.title, locale)} →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </div>
    </>
  );
}

async function ProsePage({
  page,
  locale,
  t,
}: {
  page: LoadedDocPage;
  locale: string;
  t: Translator;
}) {
  return (
    <>
      <Topbar
        section={`${t.t("nav.docs")} · ${localised(page.section.title, locale)}`}
      />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{localised(page.title, locale)}</h1>
          <span className="count">{localised(page.section.title, locale)}</span>
        </div>

        {page.fellBack && (
          <div className="banner warn" style={{ marginBottom: 16 }}>
            {t.t("docs.fallbackNotice", { served: page.used })}
          </div>
        )}

        <article className="card">
          <div className="card-body">
            <Markdown markdown={stripTitle(page.markdown)} />
          </div>
        </article>

        <nav className="doc-nav">
          {page.prev ? (
            <Link className="btn" href={`/docs/${page.section.id}/${page.prev.slug}`}>
              ← {localised(page.prev.title, locale)}
            </Link>
          ) : (
            <span />
          )}
          {page.next ? (
            <Link className="btn" href={`/docs/${page.section.id}/${page.next.slug}`}>
              {localised(page.next.title, locale)} →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </div>
    </>
  );
}
