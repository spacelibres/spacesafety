import { Topbar } from "@/components/Shell";
import { getTranslator } from "@/lib/i18n/registry";

export const dynamic = "force-dynamic";

/**
 * Feedback — the sidebar's last entry in the official layout.
 *
 * What this page can honestly say: how to reach whoever runs *this* deployment,
 * and what to include so a report is actionable. The address comes from
 * configuration (`SPACE_SAFETY_CONTACT_EMAIL`) because this is our deployment,
 * not SpaceX's — printing their onboarding address here would be a lie a reader
 * could dial, and printing a made-up one would be worse.
 */
export default async function FeedbackPage() {
  const t = await getTranslator();
  const contact = process.env.SPACE_SAFETY_CONTACT_EMAIL ?? "";

  return (
    <>
      <Topbar section={t.t("nav.feedback")} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{t.t("feedback.title")}</h1>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">{t.t("feedback.contact")}</div>
          <div className="card-body">
            {contact ? (
              <p>
                <a href={`mailto:${contact}`} className="mono">
                  {contact}
                </a>
              </p>
            ) : (
              <p className="muted">{t.t("feedback.noContact")}</p>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">{t.t("feedback.include")}</div>
          <div className="card-body">
            <ul>
              <li>{t.t("feedback.includeCorrelation")}</li>
              <li>{t.t("feedback.includeRequest")}</li>
              <li>{t.t("feedback.includeExpected")}</li>
              <li>{t.t("feedback.includeSensitive")}</li>
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}
