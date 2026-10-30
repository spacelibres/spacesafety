import { eq } from "drizzle-orm";

import { Topbar } from "@/components/Shell";
import { getDb } from "@/db";
import { credentials, operators } from "@/db/schema";
import { getTranslator } from "@/lib/i18n/registry";

export const dynamic = "force-dynamic";

/**
 * Users — who may act in this deployment.
 *
 * The vendor's sidebar has a `Users` entry (admin only), and its operator page
 * describes "a list of users and API keys associated with your account". In this
 * deployment an identity **is** an mTLS certificate: `docs/SPEC-BEHAVIOR.md` §1
 * makes the client certificate the credential, and there is no separate user
 * table to list. So this page reports exactly that — the issued credentials,
 * grouped by the operator they belong to — rather than inventing a user database
 * so the columns look more like the official screenshots.
 *
 * The distinction is stated on the page itself: a reader comparing the two
 * deserves to know why the columns differ.
 */
export default async function UsersPage() {
  const { db } = getDb();
  const t = await getTranslator();

  const rows = db
    .select({ c: credentials, opName: operators.name })
    .from(credentials)
    .leftJoin(operators, eq(operators.id, credentials.operatorId))
    .all();

  const byOperator = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.opName ?? row.c.operatorId;
    const list = byOperator.get(key) ?? [];
    list.push(row);
    byOperator.set(key, list);
  }

  return (
    <>
      <Topbar section={t.t("nav.users")} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t.t("users.title")}</h1>
          <span className="count">{t.t("users.count", { count: t.number(rows.length) })}</span>
        </div>

        <div className="banner info">{t.t("users.identityNote")}</div>

        {[...byOperator.entries()].map(([operatorName, members]) => (
          <section className="card" key={operatorName} style={{ marginBottom: 16 }}>
            <div className="card-head">
              <span>{operatorName}</span>
              <span className="count">{t.number(members.length)}</span>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t.t("users.commonName")}</th>
                    <th>{t.t("users.fingerprint")}</th>
                    <th>{t.t("users.created")}</th>
                    <th>{t.t("users.lastUsed")}</th>
                    <th>{t.t("column.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map(({ c }) => (
                    <tr key={c.id}>
                      <td className="mono-sm">{c.commonName}</td>
                      <td className="mono-sm muted">{`${c.fingerprint.slice(0, 16)}…`}</td>
                      <td className="muted">{c.createdAt}</td>
                      <td className="muted">{c.lastSeenAt ?? t.t("keys.never")}</td>
                      <td>
                        <span className={`chip ${c.revokedAt ? "false" : "true"}`}>
                          {c.revokedAt ? t.t("keys.revoked") : t.t("users.active")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}

        {rows.length === 0 && (
          <div className="card">
            <div className="table-wrap">
              <p className="empty">{t.t("users.empty")}</p>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
