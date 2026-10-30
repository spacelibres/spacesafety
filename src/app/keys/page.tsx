import { Topbar } from "@/components/Shell";
import { getDb } from "@/db";
import { credentials, operators } from "@/db/schema";
import { getTranslator } from "@/lib/i18n/registry";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function KeysPage() {
  const { db } = getDb();
  const t = await getTranslator();
  const rows = db
    .select({ c: credentials, opName: operators.name })
    .from(credentials)
    .leftJoin(operators, eq(operators.id, credentials.operatorId))
    .all();

  return (
    <>
      <Topbar section={t.t("nav.keys")} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t.t("keys.title")}</h1>
          <span className="count">{t.t("keys.count", { count: rows.length })}</span>
        </div>

        <div className="banner info">
          {t.t("keys.mtlsLead")} <strong>{t.t("keys.mtlsMutualTls")}</strong>
          {t.t("keys.mtlsNotTokens")}{" "}
          <code className="mono">npm run cert:issue -- --ca</code>
          {t.t("keys.mtlsThen")}{" "}
          <code className="mono">
            npm run cert:issue -- --cn your-org --operator &lt;uuid&gt;
          </code>
          {t.t("keys.mtlsResult")}
        </div>

        <section className="card">
          <div className="card-head">
            <span>{t.t("keys.issuedCertificates")}</span>
            <span className="count">{t.t("keys.fingerprints")}</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("keys.commonName")}</th>
                  <th>{t.t("column.operator")}</th>
                  <th>{t.t("keys.fingerprint")}</th>
                  <th>{t.t("keys.created")}</th>
                  <th>{t.t("keys.lastUsed")}</th>
                  <th>{t.t("column.status")}</th>
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
                        : t.t("keys.never")}
                    </td>
                    <td>
                      <span className={`chip ${c.revokedAt ? "false" : "true"}`}>
                        {c.revokedAt ? t.t("keys.revoked") : t.t("keys.active")}
                      </span>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty">
                      {t.t("keys.noCertificates")}
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
