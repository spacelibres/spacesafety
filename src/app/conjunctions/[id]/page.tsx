import Link from "next/link";
import { notFound } from "next/navigation";

import { PcHistoryChart } from "@/components/Charts";
import { Topbar } from "@/components/Shell";
import { getTranslator } from "@/lib/i18n/registry";
import { getEventDetail, riskBand } from "@/lib/queries";
import { countdownTo, formatGps } from "@/lib/space-safety/gps";

export const dynamic = "force-dynamic";

export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { event, history, latest } = getEventDetail(id);
  if (!event) notFound();
  const t = await getTranslator();

  const band = riskBand(latest?.probabilityOfCollision ?? null);

  return (
    <>
      <Topbar section={t.t("nav.conjunctions")} entityId={event.id} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">
            {t.t("conjunction.titleWithId", { id: event.id.slice(0, 8) })}
          </h1>
          <Link className="btn" href="/conjunctions">
            {t.t("common.backArrow")}
          </Link>
        </div>

        <div className="meta-strip">
          <div className="meta-cell">
            <div className="meta-label">{t.t("conjunction.pc")}</div>
            <div className={`meta-value pc ${band}`}>
              {latest?.probabilityOfCollision != null
                ? latest.probabilityOfCollision.toExponential(3)
                : t.t("common.null")}
            </div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">{t.t("conjunction.tcaUtc")}</div>
            <div className="meta-value">
              {latest ? safeGps(latest.tcaGpsNanos, t.t("common.none")) : t.t("common.none")}
            </div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">{t.t("column.countdown")}</div>
            <div className="meta-value">
              {latest ? (countdownTo(latest.tcaGpsNanos) ?? t.t("common.none")) : t.t("common.none")}
            </div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">{t.t("conjunction.createdAt")}</div>
            <div className="meta-value">{fmt(event.creationTime)}</div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">{t.t("conjunction.updatedAt")}</div>
            <div className="meta-value">{fmt(event.updatedTime)}</div>
          </div>
        </div>

        <div className="grid-2" style={{ marginBottom: 16 }}>
          <ObjectCard
            t={t}
            title={t.t("column.object1")}
            operatorName={event.operator1Name}
            objectName={event.object1Name}
            maneuverable={event.object1Maneuverable}
            claimStatus={event.claimStatusOperator1}
            source={latest?.trajectory1Source}
            rtn={
              latest ? [latest.rtnR ?? 0, latest.rtnT ?? 0, latest.rtnN ?? 0] : null
            }
          />
          <ObjectCard
            t={t}
            title={t.t("column.object2")}
            operatorName={event.operator2Name}
            objectName={event.object2Name}
            maneuverable={event.object2Maneuverable}
            claimStatus={event.claimStatusOperator2}
            source={latest?.trajectory2Source}
            rtn={null}
          />
        </div>

        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <span>{t.t("conjunction.pcConsistency")}</span>
            <span className="count">{t.t("conjunction.pcConsistencyCaption")}</span>
          </div>
          <div className="card-body">
            <PcHistoryChart points={history} />
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <span>{t.t("conjunction.cdmList")}</span>
            <span className="count">{t.t("conjunction.cdmCount", { count: history.length })}</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.id")}</th>
                  <th>{t.t("filter.isActive")}</th>
                  <th className="num">{t.t("conjunction.pc")}</th>
                  <th>{t.t("conjunction.trajectory1Source")}</th>
                  <th>{t.t("conjunction.trajectory2Source")}</th>
                  <th>{t.t("conjunction.createdAt")}</th>
                  <th>{t.t("conjunction.file")}</th>
                </tr>
              </thead>
              <tbody>
                {history
                  .slice()
                  .reverse()
                  .map((h) => (
                    <tr key={h.id}>
                      <td className="mono-sm">{h.id.slice(0, 8)}</td>
                      <td>
                        <span className={`chip ${h.isActive}`}>
                          {String(h.isActive)}
                        </span>
                      </td>
                      <td className="num pc">
                        {t.probability(h.pc ?? NaN)}
                      </td>
                      <td>
                        <span className={`chip ${h.source1}`}>{h.source1}</span>
                      </td>
                      <td>
                        <span className={`chip ${h.source2}`}>{h.source2}</span>
                      </td>
                      <td className="mono-sm">{fmt(h.createdAt)}</td>
                      <td className="nowrap">
                        <a
                          href={`/api/v1/cdm/${h.id}?format=json`}
                          className="mono-sm"
                        >
                          json
                        </a>{" "}
                        <a
                          href={`/api/v1/cdm/${h.id}?format=kvn`}
                          className="mono-sm"
                        >
                          kvn
                        </a>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}

function ObjectCard({
  t,
  title,
  operatorName,
  objectName,
  maneuverable,
  claimStatus,
  source,
  rtn,
}: {
  t: import("@/lib/i18n").Translator;
  title: string;
  operatorName: string;
  objectName: string;
  maneuverable: boolean;
  claimStatus: string;
  source?: string;
  rtn: [number, number, number] | null;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <span>{title}</span>
        {source && <span className={`chip ${source}`}>{source}</span>}
      </div>
      <table className="kv">
        <tbody>
          <tr>
            <td className="k">{t.t("column.operatorName")}</td>
            <td>{operatorName}</td>
          </tr>
          <tr>
            <td className="k">{t.t("column.objectName")}</td>
            <td>{objectName}</td>
          </tr>
          <tr>
            <td className="k">{t.t("conjunction.maneuverable")}</td>
            <td>
              <span className={`chip ${maneuverable}`}>{String(maneuverable)}</span>
            </td>
          </tr>
          <tr>
            <td className="k">{t.t("column.claimStatus")}</td>
            <td>
              <span className="chip neutral">{claimStatus}</span>
            </td>
          </tr>
          {rtn && (
            <tr>
              <td className="k">{t.t("conjunction.missVectorRtn")}</td>
              <td className="v-mono">{rtn.map((v) => v.toFixed(3)).join(" / ")}</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function fmt(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, "");
}

function safeGps(gps: string, dash: string): string {
  try {
    return formatGps(gps);
  } catch {
    return dash;
  }
}
