import Link from "next/link";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/Shell";
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
  const traj = getTrajectory(id);
  if (!traj) notFound();

  const file = getTrajectoryFile(id);
  const cdms = listTrajectoryCdms(id);
  const series = file ? elementSeries(file.text, file.format) : [];

  return (
    <>
      <Topbar section="Trajectories" entityId={traj.id} />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">Trajectory {traj.id.slice(0, 8)}</h1>
          <div className="btn-group">
            <a className="btn" href={`/api/v1/trajectory/${traj.id}`}>
              Download
            </a>
            <a className="btn" href={`/api/v1/trajectory/${traj.id}/metadata`}>
              Metadata
            </a>
          </div>
        </div>

        <div className="meta-strip">
          <div className="meta-cell">
            <div className="meta-label">Screened status</div>
            <div className="meta-value">
              <span
                className={`chip ${
                  traj.screenedStatus === "screened" ? "true" : "neutral"
                }`}
              >
                {traj.screenedStatus}
              </span>
            </div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">Uploaded at (UTC)</div>
            <div className="meta-value">{fmt(traj.uploadedAt)}</div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">Start at (UTC)</div>
            <div className="meta-value">{fmt(traj.startAt)}</div>
          </div>
          <div className="meta-cell">
            <div className="meta-label">End at (UTC)</div>
            <div className="meta-value">{fmt(traj.endAt)}</div>
          </div>
        </div>

        <div className="grid-detail">
          <section className="card">
            <table className="kv">
              <tbody>
                <tr>
                  <td className="k">Operator</td>
                  <td>{traj.operatorName}</td>
                </tr>
                <tr>
                  <td className="k">Object</td>
                  <td>{traj.objectName}</td>
                </tr>
                <tr>
                  <td className="k">State source</td>
                  <td>
                    <span className={`chip ${traj.stateSource}`}>
                      {traj.stateSource}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="k">Type</td>
                  <td>
                    <span className="chip neutral">{traj.uploadType}</span>
                  </td>
                </tr>
                <tr>
                  <td className="k">Format</td>
                  <td className="v-mono">{traj.fileFormat}</td>
                </tr>
                <tr>
                  <td className="k">State vectors</td>
                  <td className="v-mono">{traj.pointCount}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="card">
            <div className="card-head">
              <span>Orbital elements</span>
              <span className="count">semi-major axis altitude over the arc</span>
            </div>
            <div className="card-body">
              <ElementsChart series={series} />
            </div>
          </section>
        </div>

        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <span>Conjunction Data Messages</span>
            <span className="count">{cdms.length} CDMs</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Conjunction</th>
                  <th>Is active</th>
                  <th className="num">Collision probability</th>
                  <th>Object 1</th>
                  <th>Object 2</th>
                  <th>T1 source</th>
                  <th>T2 source</th>
                  <th>File</th>
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
                        <span className="faint">—</span>
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
                        : "NULL"}
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
                      No CDMs against this trajectory yet.
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
