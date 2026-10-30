import { Topbar } from "@/components/Shell";
import { getTranslator } from "@/lib/i18n/registry";

export const dynamic = "force-static";

/** Notes are dictionary keys: the paths and methods beside them are technical. */
const ENDPOINTS: { method: string; path: string; noteKey: string }[] = [
  { method: "GET", path: "/api/v1/operator", noteKey: "docs.ep.operatorList" },
  { method: "GET", path: "/api/v1/operator/:id", noteKey: "docs.ep.operatorOne" },
  { method: "POST", path: "/api/v1/operator", noteKey: "docs.ep.operatorCreate" },
  { method: "PATCH", path: "/api/v1/operator/:id", noteKey: "docs.ep.operatorUpdate" },
  { method: "GET", path: "/api/v1/object", noteKey: "docs.ep.objectList" },
  { method: "GET", path: "/api/v1/object/:id", noteKey: "docs.ep.objectOne" },
  { method: "POST", path: "/api/v1/object", noteKey: "docs.ep.objectCreate" },
  { method: "PATCH", path: "/api/v1/object/:id", noteKey: "docs.ep.objectUpdate" },
  { method: "GET", path: "/api/v1/trajectory", noteKey: "docs.ep.trajectoryStream" },
  { method: "POST", path: "/api/v1/trajectory", noteKey: "docs.ep.trajectoryUpload" },
  { method: "GET", path: "/api/v1/trajectory/:id", noteKey: "docs.ep.trajectoryRaw" },
  { method: "GET", path: "/api/v1/trajectory/:id/metadata", noteKey: "docs.ep.trajectoryMetadata" },
  { method: "GET", path: "/api/v2/trajectory/:id/cdms", noteKey: "docs.ep.trajectoryCdms" },
  { method: "GET", path: "/api/v2/cdm", noteKey: "docs.ep.cdmStream" },
  { method: "GET", path: "/api/v1/cdm/:id", noteKey: "docs.ep.cdmRaw" },
  { method: "GET", path: "/api/v1/cdm/:id/metadata", noteKey: "docs.ep.cdmMetadata" },
  { method: "GET", path: "/api/v2/event/:id", noteKey: "docs.ep.eventHistory" },
  { method: "GET", path: "/api/v1/event/:id/cdms", noteKey: "docs.ep.eventCdms" },
];

export default async function DocsPage() {
  const t = await getTranslator();

  return (
    <>
      <Topbar section={t.t("nav.docs")} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t.t("docs.apiReference")}</h1>
          <span className="count">{t.t("docs.endpointCount", { count: ENDPOINTS.length })}</span>
        </div>

        <div className="banner info">
          {t.t("docs.authLead")}{" "}
          <code className="mono">401 RBAC: access denied</code>.
        </div>

        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">{t.t("docs.endpoints")}</div>
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
                {ENDPOINTS.map((e) => (
                  <tr key={`${e.method} ${e.path}`}>
                    <td className="mono-sm">{e.method}</td>
                    <td className="mono-sm">{e.path}</td>
                    <td className="muted">{t.t(e.noteKey)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">{t.t("docs.paginationTitle")}</div>
          <div className="card-body" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
            <p style={{ marginTop: 0 }}>
              {t.t("docs.paginationEnvelopeBefore")}{" "}
              <code className="mono">{"{ result, token }"}</code>
              {t.t("docs.paginationEnvelopeAfter")}
            </p>
            <p>
              {t.t("docs.paginationErrorsBefore")}{" "}
              <code className="mono">400 pagination_too_old</code>
              {t.t("docs.paginationErrorsAfter")}
            </p>
          </div>
        </section>

        <section className="card">
          <div className="card-head">{t.t("docs.screeningTitle")}</div>
          <table className="kv">
            <tbody>
              <tr>
                <td className="k">{t.t("docs.screeningRadial")}</td>
                <td className="v-mono">± 2 km</td>
              </tr>
              <tr>
                <td className="k">{t.t("docs.screeningAlongTrack")}</td>
                <td className="v-mono">± 44 km</td>
              </tr>
              <tr>
                <td className="k">{t.t("docs.screeningCrossTrack")}</td>
                <td className="v-mono">± 51 km</td>
              </tr>
              <tr>
                <td className="k">{t.t("docs.screeningGroupingWindow")}</td>
                <td className="v-mono">{t.t("docs.screeningGroupingWindowValue")}</td>
              </tr>
              <tr>
                <td className="k">{t.t("docs.screeningProbability")}</td>
                <td>{t.t("docs.screeningProbabilityValue")}</td>
              </tr>
              <tr>
                <td className="k">{t.t("docs.screeningMinSpan")}</td>
                <td className="v-mono">{t.t("docs.screeningMinSpanValue")}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
