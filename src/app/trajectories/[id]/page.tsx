import Link from "next/link";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/Shell";
import { getTranslator } from "@/lib/i18n/registry";
import {
  getTrajectory,
  getTrajectoryFile,
  listTrajectoryCdms,
} from "@/lib/queries";
import { elementsFromState, type OrbitalElements } from "@/lib/core/kinematics";
import { parseOcm, mergeOcmCovariance } from "@/lib/orbit/ocm";
import { parseOem } from "@/lib/orbit/oem";
import { itrfStateToJ2000 } from "@/lib/orbit/frames-rigorous";
import { ElementsChart } from "@/components/Charts2";

export const dynamic = "force-dynamic";

export default async function TrajectoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslator();
  const traj = getTrajectory(id);
  if (!traj) notFound();

  const file = getTrajectoryFile(id);
  const cdms = listTrajectoryCdms(id);
  const series = file ? elementSeries(file.text, file.format) : [];

  return (
    <>
      <Topbar section={t.t("nav.trajectories")} entityId={traj.id} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">
            {t.t("trajectory.titleWithId", { id: traj.id.slice(0, 8) })}
          </h1>
          <div className="btn-group">
            <a className="btn" href={`/api/v1/trajectory/${traj.id}`}>
              {t.t("trajectory.download")}
            </a>
            <a className="btn" href={`/api/v1/trajectory/${traj.id}/metadata`}>
              {t.t("trajectory.metadata")}
            </a>
          </div>
        </div>

        <div className="meta-strip">
          <div className="meta-cell">
            <div className="meta-label">{t.t("column.screenedStatus")}</div>
            <div className="meta-value">
              <span
                className={`chip ${
                  traj.screenedStatus === "screened" ? "true" : "neutral"
                }`}
              >
                {t.t(`common.screenedStatus.${traj.screenedStatus}`)}
              </span>
            </div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">{t.t("column.uploadedAt")}</div>
            <div className="meta-value">{fmt(traj.uploadedAt)}</div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">{t.t("trajectory.startAt")}</div>
            <div className="meta-value">{fmt(traj.startAt)}</div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">{t.t("trajectory.endAt")}</div>
            <div className="meta-value">{fmt(traj.endAt)}</div>
          </div>
        </div>

        <div className="grid-detail">
          <section className="card">
            <table className="kv">
              <tbody>
                <tr>
                  <td className="k">{t.t("column.operator")}</td>
                  <td>{traj.operatorName}</td>
                </tr>
                <tr>
                  <td className="k">{t.t("column.object")}</td>
                  <td>{traj.objectName}</td>
                </tr>
                <tr>
                  <td className="k">{t.t("column.stateSource")}</td>
                  <td>
                    <span className={`chip ${traj.stateSource}`}>
                      {traj.stateSource}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="k">{t.t("column.type")}</td>
                  <td>
                    <span className="chip neutral">
                      {t.t(`common.uploadType.${traj.uploadType}`)}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="k">{t.t("trajectory.format")}</td>
                  <td className="v-mono">{traj.fileFormat}</td>
                </tr>
                <tr>
                  <td className="k">{t.t("trajectory.states")}</td>
                  <td className="v-mono">{t.number(traj.pointCount)}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="card">
            <div className="card-head">
              <span>{t.t("trajectory.orbitalElements")}</span>
              <span className="count">{t.t("trajectory.orbitalElementsCaption")}</span>
            </div>
            <div className="card-body">
              <ElementsChart series={series} />
            </div>
          </section>
        </div>

        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <span>{t.t("conjunction.cdmList")}</span>
            <span className="count">{t.t("conjunction.cdmCount", { count: cdms.length })}</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t.t("column.id")}</th>
                  <th>{t.t("column.conjunction")}</th>
                  <th>{t.t("filter.isActive")}</th>
                  <th className="num">{t.t("conjunction.pc")}</th>
                  <th>{t.t("column.object1")}</th>
                  <th>{t.t("column.object2")}</th>
                  <th>{t.t("column.trajectory1Source")}</th>
                  <th>{t.t("column.trajectory2Source")}</th>
                  <th>{t.t("column.file")}</th>
                </tr>
              </thead>
              <tbody>
                {cdms.map((c) => (
                  <tr key={c.id}>
                    <td className="mono-sm">{c.id.slice(0, 8)}</td>
                    <td>
                      {c.eventId ? (
                        <Link href={`/conjunctions/${c.eventId}`} className="mono-sm">
                          {c.eventId.slice(0, 8)}
                        </Link>
                      ) : (
                        <span className="faint">{t.t("common.none")}</span>
                      )}
                    </td>
                    <td>
                      <span className={`chip ${c.isActive}`}>
                        {String(c.isActive)}
                      </span>
                    </td>
                    <td className="num pc">
                      {c.probabilityOfCollision != null
                        ? c.probabilityOfCollision.toExponential(2)
                        : t.t("common.null")}
                    </td>
                    <td>{c.object1Name}</td>
                    <td className="muted">{c.object2Name}</td>
                    <td>
                      <span className={`chip ${c.trajectory1Source}`}>
                        {c.trajectory1Source}
                      </span>
                    </td>
                    <td>
                      <span className={`chip ${c.trajectory2Source}`}>
                        {c.trajectory2Source}
                      </span>
                    </td>
                    <td className="nowrap">
                      <a href={`/api/v1/cdm/${c.id}?format=json`} className="mono-sm">
                        json
                      </a>{" "}
                      <a href={`/api/v1/cdm/${c.id}?format=kvn`} className="mono-sm">
                        kvn
                      </a>
                    </td>
                  </tr>
                ))}
                {cdms.length === 0 && (
                  <tr>
                    <td colSpan={9} className="empty">
                      {t.t("trajectory.noCdmsAgainst")}
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

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace("T", " ").replace(/\.\d+Z?$/, "");
}

/** Derive orbital elements across the arc, for the trend chart. */
function elementSeries(
  text: string,
  format: string,
): { tMs: number; el: OrbitalElements }[] {
  const out: { tMs: number; el: OrbitalElements }[] = [];
  try {
    if (format === "ocm") {
      const ocm = parseOcm(text);
      const earthFixed = /ITRF/i.test(ocm.trajectoryFrame);
      const states = mergeOcmCovariance(ocm);
      const step = Math.max(1, Math.floor(states.length / 200));
      for (let i = 0; i < states.length; i += step) {
        const s = states[i];
        const pv = earthFixed
          ? itrfStateToJ2000(s.position, s.velocity, s.ms)
          : { position: s.position, velocity: s.velocity };
        out.push({
          tMs: s.ms,
          el: elementsFromState(pv.position, pv.velocity),
        });
      }
    } else if (format === "oem") {
      const oem = parseOem(text);
      const earthFixed = /ITRF/i.test(oem.refFrame);
      const step = Math.max(1, Math.floor(oem.states.length / 200));
      for (let i = 0; i < oem.states.length; i += step) {
        const s = oem.states[i];
        const pv = earthFixed
          ? itrfStateToJ2000(s.position, s.velocity, s.tMs)
          : { position: s.position, velocity: s.velocity };
        out.push({ tMs: s.tMs, el: elementsFromState(pv.position, pv.velocity) });
      }
    }
  } catch {
    return [];
  }
  return out;
}
