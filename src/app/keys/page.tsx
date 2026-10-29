import { Topbar } from "@/components/Shell";
import { getDb } from "@/db";
import { credentials, operators } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default function KeysPage() {
  const { db } = getDb();
  const rows = db
    .select({ c: credentials, opName: operators.name })
    .from(credentials)
    .leftJoin(operators, eq(operators.id, credentials.operatorId))
    .all();

  return (
    <>
      <Topbar section="Keys" />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">API Keys</h1>
          <span className="count">{rows.length} credentials</span>
        </div>

        <div className="banner info">
          This deployment authenticates with <strong>mutual TLS</strong>, not bearer
          tokens. Generate a key pair and CSR with{" "}
          <code className="mono">
            npm run cert:request -- --cn your-org --org &quot;Your Org&quot;
          </code>
          , then sign it with <code className="mono">npm run cert:sign</code>. The
          resulting certificate is the credential.
        </div>

        <section className="card">
          <div className="card-head">
            <span>Issued certificates</span>
            <span className="count">SHA-256 fingerprints</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Common name</th>
                  <th>Operator</th>
                  <th>Fingerprint</th>
                  <th>Issued</th>
                  <th>Last used</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ c, opName }) => (
                  <tr key={c.id}>
                    <td className="mono-sm">{c.commonName}</td>
                    <td>{opName ?? c.operatorId}</td>
                    <td className="mono-sm faint">{c.fingerprint.slice(0, 24)}…</td>
                    <td className="mono-sm">
                      {c.createdAt.replace("T", " ").replace(/\.\d+Z$/, "")}
                    </td>
                    <td className="mono-sm">
                      {c.lastSeenAt
                        ? c.lastSeenAt.replace("T", " ").replace(/\.\d+Z$/, "")
                        : "never"}
                    </td>
                    <td>
                      <span className={`chip ${c.revokedAt ? "false" : "true"}`}>
                        {c.revokedAt ? "revoked" : "active"}
                      </span>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">
                      No certificates issued yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
