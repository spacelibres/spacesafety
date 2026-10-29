import Link from "next/link";
import { notFound } from "next/navigation";

import { PcHistoryChart } from "@/components/Charts";
import { Topbar } from "@/components/Shell";
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

  const band = riskBand(latest?.probabilityOfCollision ?? null);

  return (
    <>
      <Topbar section="Conjunctions" entityId={event.id} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Conjunction {event.id.slice(0, 8)}</h1>
          <Link className="btn" href="/conjunctions">
            ← back
          </Link>
        </div>

        <div className="meta-strip">
          <div className="meta-cell">
            <div className="meta-label">Collision probability</div>
            <div className={`meta-value pc ${band}`}>
              {latest?.probabilityOfCollision != null
                ? latest.probabilityOfCollision.toExponential(3)
                : "NULL"}
            </div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">TCA (UTC)</div>
            <div className="meta-value">
              {latest ? safeGps(latest.tcaGpsNanos) : "—"}
            </div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">Countdown</div>
            <div className="meta-value">
              {latest ? (countdownTo(latest.tcaGpsNanos) ?? "—") : "—"}
            </div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">Created at (UTC)</div>
            <div className="meta-value">{fmt(event.creationTime)}</div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">Updated at (UTC)</div>
            <div className="meta-value">{fmt(event.updatedTime)}</div>
          </div>
        </div>

        <div className="grid-2" style={{ marginBottom: 16 }}>
          <ObjectCard
            title="Object 1"
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
            title="Object 2"
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
            <span>Prediction consistency</span>
            <span className="count">Pc over successive CDMs (log scale)</span>
          </div>
          <div className="card-body">
            <PcHistoryChart points={history} />
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <span>Conjunction Data Messages</span>
            <span className="count">{history.length} CDMs</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Is active</th>
                  <th className="num">Collision probability</th>
                  <th>Trajectory 1 source</th>
                  <th>Trajectory 2 source</th>
                  <th>Created at (UTC)</th>
                  <th>File</th>
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
                        {h.pc != null ? h.pc.toExponential(2) : "NULL"}
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
  title,
  operatorName,
  objectName,
  maneuverable,
  claimStatus,
  source,
  rtn,
}: {
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
            <td className="k">Operator name</td>
            <td>{operatorName}</td>
          </tr>
          <tr>
            <td className="k">Object name</td>
            <td>{objectName}</td>
          </tr>
          <tr>
            <td className="k">Maneuverable</td>
            <td>
              <span className={`chip ${maneuverable}`}>{String(maneuverable)}</span>
            </td>
          </tr>
          <tr>
            <td className="k">Claim status</td>
            <td>
              <span className="chip neutral">{claimStatus}</span>
            </td>
          </tr>
          {rtn && (
            <tr>
              <td className="k">Miss vector R / T / N (km)</td>
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

function safeGps(gps: string): string {
  try {
    return formatGps(gps);
  } catch {
    return "—";
  }
}
