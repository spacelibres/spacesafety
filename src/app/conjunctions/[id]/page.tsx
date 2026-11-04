import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PcHistoryChart } from "@/components/Charts";
import { ConvergenceChart } from "@/components/ConvergenceChart";
import { Topbar } from "@/components/Shell";
import { getTranslator } from "@/lib/i18n/registry";
import { pageMetadata } from "@/lib/i18n/page-title";
import { distanceLabel, formatDistance } from "@/lib/space-safety/distance";
import {
  getEventDetail,
  getPublishedConjunction,
  riskBand,
  type PublishedConjunctionDetail,
} from "@/lib/queries";
import { countdownTo, countdownUnits, formatCountdown, formatGps } from "@/lib/space-safety/gps";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const t = await getTranslator();
  const { id } = await params;
  return pageMetadata(t, `${t.t("conjunction.title")} ${id.slice(0, 8)}`);
}

export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { event, history, latest } = getEventDetail(id);
  if (!event) {
    // Not one of our own screening events — it may be a published CDM opened from
    // the conjunction list, which has its own detail view.
    const published = getPublishedConjunction(id);
    if (!published) notFound();
    return <PublishedConjunctionPage detail={published} />;
  }
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
              {latest ? (countdownTo(latest.tcaGpsNanos, new Date(), countdownUnits((k) => t.t(k))) ?? t.t("common.none")) : t.t("common.none")}
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

/**
 * A published conjunction, opened from the list.
 *
 * Same page, second data source: `/conjunctions/<id>` answers for both our own
 * screening events (uuid) and the publicly published CDM feed (numeric message
 * id). The two are labelled differently because they are different claims — one
 * is our screening, the other is the screening centre's message about two
 * catalogue objects — and merging them silently would misreport both.
 */
async function PublishedConjunctionPage({ detail }: { detail: PublishedConjunctionDetail }) {
  const t = await getTranslator();
  const c = detail.latest;
  const firstMessage = detail.messages[0];
  const lastMessage = detail.messages[detail.messages.length - 1];

  return (
    <>
      <Topbar section={t.t("nav.conjunctions")} entityId={c.cdmId} />
      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">
              {t.t("conjunction.titleWithId", { id: c.cdmId.slice(0, 8) })}
            </h1>
            <span className="page-sub">{t.t("publishedConjunction.subtitle")}</span>
          </div>
          <Link className="btn" href="/conjunctions">
            {t.t("common.backArrow")}
          </Link>
        </div>

        {/* The meta strip the reference UI puts under every detail title. */}
        <div className="meta-strip">
          <div>
            <span className="k">{t.t("conjunction.pc")}</span>
            <span className="v">{t.probability(c.pc ?? NaN)}</span>
          </div>
          <div>
            <span className="k">{t.t("column.missDistance")}</span>
            <span className="v">
              {distanceLabel(c.minRangeKm, t.t("common.none"), (k) => t.t(k))}
            </span>
          </div>
          <div>
            <span className="k">{t.t("column.tca")}</span>
            <span className="v mono-sm">{fmtIso(c.tcaIso, t.t("common.none"))}</span>
          </div>
          <div>
            <span className="k">{t.t("conjunction.created")}</span>
            <span className="v mono-sm">{fmtIso(c.createdIso, t.t("common.none"))}</span>
          </div>
          <div>
            <span className="k">{t.t("column.messages")}</span>
            <span className="v">{detail.messages.length}</span>
          </div>
          <div>
            <span className="k">{t.t("column.risk")}</span>
            <span className={`chip risk-${c.band}`}>{t.t(`risk.${c.band}`).toUpperCase()}</span>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">{t.t("publishedConjunction.estimate")}</div>
          <div className="card-body">
            <ConvergenceChart
              points={detail.messages.map((m, i) => ({
                hoursToTca: m.hoursToTca,
                pc: m.pc,
                minRangeKm: m.minRangeKm,
                label: `#${i + 1}`,
              }))}
            />
            <p className="faint" style={{ margin: "6px 0 0", fontSize: 11.5 }}>
              {t.t("publishedConjunction.estimateNote")}
            </p>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">{t.t("publishedConjunction.objects")}</div>
          <table className="kv">
            <tbody>
              <tr>
                <td className="k">{t.t("column.object1")}</td>
                <td className="v-mono">
                  {c.object1Name} · {c.object1Norad}
                  {c.object1Type ? ` · ${c.object1Type}` : ""}
                </td>
              </tr>
              <tr>
                <td className="k">{t.t("column.object2")}</td>
                <td className="v-mono">
                  {c.object2Name} · {c.object2Norad}
                  {c.object2Type ? ` · ${c.object2Type}` : ""}
                </td>
              </tr>
              <tr>
                <td className="k">{t.t("publishedConjunction.firstSeen")}</td>
                <td className="v-mono">
                  {fmtIso(firstMessage.createdIso, t.t("common.none"))} ·{" "}
                  {t.t("publishedConjunction.missAtFirst", {
                    distance: distanceLabel(firstMessage.minRangeKm, "—", (k) => t.t(k)),
                  })}
                </td>
              </tr>
              <tr>
                <td className="k">{t.t("publishedConjunction.latest")}</td>
                <td className="v-mono">{fmtIso(lastMessage.createdIso, t.t("common.none"))}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-head">{t.t("publishedConjunction.history")}</div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.cdm")}</th>
                  <th>{t.t("conjunction.created")}</th>
                  <th className="num">{t.t("column.missDistance")}</th>
                  <th className="num">{t.t("column.pc")}</th>
                  <th className="num">{t.t("publishedConjunction.hoursToTca")}</th>
                  <th>{t.t("publishedConjunction.estimateTrend")}</th>
                </tr>
              </thead>
              <tbody>
                {detail.messages.map((m, i) => {
                  const prev = i > 0 ? detail.messages[i - 1] : null;
                  return (
                    <tr key={m.cdmId}>
                      <td className="mono-sm">{m.cdmId}</td>
                      <td className="mono-sm">{fmtIso(m.createdIso, t.t("common.none"))}</td>
                      <td className="num mono-sm">
                        {distanceLabel(m.minRangeKm, "—", (k) => t.t(k))}
                      </td>
                      <td className="num mono-sm">{t.probability(m.pc ?? NaN)}</td>
                      <td className="num mono-sm">
                        {m.hoursToTca === null
                          ? "—"
                          : formatCountdown(
                              m.hoursToTca * 3_600_000,
                              countdownUnits((k) => t.t(k)),
                            )}
                      </td>
                      <td className="muted mono-sm">{delta(prev?.minRangeKm ?? null, m.minRangeKm, (km) => distanceLabel(km, "—", (k) => t.t(k)))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

/** ISO-8601 to a space-separated UTC stamp; `dash` when absent. */
function fmtIso(iso: string | null, dash: string): string {
  if (!iso) return dash;
  return iso.replace("T", " ").replace(/\.\d+Z$/, "").replace(/Z$/, "");
}

/**
 * Change in miss distance since the previous message.
 *
 * Signed, and the sign carries the meaning: a shrinking miss is the trend that
 * matters. The magnitude goes through `distanceLabel`, so a 40 m change reads as
 * "-40 m" rather than collapsing to "0.0".
 */
function delta(prev: number | null, cur: number | null, fix: (km: number) => string): string {
  if (prev === null || cur === null) return "—";
  const d = cur - prev;
  if (Math.abs(d) < 0.0005) return fix(0);
  return `${d > 0 ? "+" : "-"}${fix(Math.abs(d))}`;
}
