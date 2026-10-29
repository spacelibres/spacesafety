import { Topbar } from "@/components/Shell";

export const dynamic = "force-static";

const ENDPOINTS: { method: string; path: string; note: string }[] = [
  { method: "GET", path: "/api/v1/operator", note: "all operators and contacts" },
  { method: "GET", path: "/api/v1/operator/:id", note: "one operator" },
  { method: "POST", path: "/api/v1/operator", note: "create (admin only)" },
  { method: "PATCH", path: "/api/v1/operator/:id", note: "update contact details" },
  { method: "GET", path: "/api/v1/object", note: "list objects (operator_id/norad_id/name)" },
  { method: "GET", path: "/api/v1/object/:id", note: "one object" },
  { method: "POST", path: "/api/v1/object", note: "create object" },
  { method: "PATCH", path: "/api/v1/object/:id", note: "update object" },
  { method: "GET", path: "/api/v1/trajectory", note: "stream trajectories (token)" },
  { method: "POST", path: "/api/v1/trajectory", note: "upload ephemeris" },
  { method: "GET", path: "/api/v1/trajectory/:id", note: "raw trajectory file" },
  { method: "GET", path: "/api/v1/trajectory/:id/metadata", note: "screening status" },
  { method: "GET", path: "/api/v2/trajectory/:id/cdms", note: "CDM stream for a trajectory" },
  { method: "GET", path: "/api/v2/cdm", note: "CDM stream (operator/object/trajectory)" },
  { method: "GET", path: "/api/v1/cdm/:id", note: "raw CDM (json|kvn)" },
  { method: "GET", path: "/api/v1/cdm/:id/metadata", note: "CDM descriptor" },
  { method: "GET", path: "/api/v2/event/:id", note: "event with CDM history" },
  { method: "GET", path: "/api/v1/event/:id/cdms", note: "CDM list for an event" },
];

export default function DocsPage() {
  return (
    <>
      <Topbar section="Docs" />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">API Reference</h1>
          <span className="count">{ENDPOINTS.length} endpoints</span>
        </div>

        <div className="banner info">
          Authentication is mutual TLS. Present a client certificate issued by
          this deployment; requests without one receive <code className="mono">403 RBAC: access denied</code>.
        </div>

        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">Endpoints</div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {ENDPOINTS.map((e) => (
                  <tr key={`${e.method} ${e.path}`}>
                    <td className="mono-sm">{e.method}</td>
                    <td className="mono-sm">{e.path}</td>
                    <td className="muted">{e.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">Streaming pagination</div>
          <div className="card-body" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
            <p style={{ marginTop: 0 }}>
              Every bulk endpoint returns <code className="mono">{"{ result, token }"}</code>.
              Reuse the token on the next request to receive only what is new —
              even when the previous call returned zero rows.
            </p>
            <p>
              A token cannot be reused with different filters, and expires after
              24 hours; in both cases the server answers{" "}
              <code className="mono">400 pagination_too_old</code> and the client
              must discard it and restart the stream.
            </p>
          </div>
        </section>

        <section className="card">
          <div className="card-head">Screening parameters</div>
          <table className="kv">
            <tbody>
              <tr>
                <td className="k">Screening box, radial</td>
                <td className="v-mono">± 2 km</td>
              </tr>
              <tr>
                <td className="k">Screening box, along-track</td>
                <td className="v-mono">± 44 km</td>
              </tr>
              <tr>
                <td className="k">Screening box, cross-track</td>
                <td className="v-mono">± 51 km</td>
              </tr>
              <tr>
                <td className="k">Event grouping window</td>
                <td className="v-mono">20 minutes</td>
              </tr>
              <tr>
                <td className="k">Collision probability</td>
                <td>2D Alfano, encounter-plane projection</td>
              </tr>
              <tr>
                <td className="k">Minimum trajectory span</td>
                <td className="v-mono">6 states, 42 s, ≤ 21 days</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
