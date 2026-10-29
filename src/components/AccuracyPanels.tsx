"use client";

import type { AccuracyReport } from "@/lib/core/accuracy-report";
import { chi2Cdf1 } from "@/lib/core/accuracy";

/**
 * Prediction-accuracy panels, mirroring the official object page:
 * error over time (with 1σ/3σ bands), its CDF, Mahalanobis distance, and the
 * Mahalanobis CDF against a chi-squared(k=1) reference.
 */
export function AccuracyPanels({ report }: { report: AccuracyReport }) {
  if (report.samples.length === 0) {
    return (
      <div className="empty">
        Not enough uploads to evaluate prediction accuracy.
        <br />
        Upload at least two trajectories for this object: the newest becomes the
        reference, earlier ones become predictions.
      </div>
    );
  }

  const errors = report.samples.map((s) => s.errorM);
  const sigmas = report.samples.map((s) => s.sigma1M);
  const finiteSigmas = sigmas.filter((s): s is number => s !== null);
  const sigma1 = finiteSigmas.length
    ? finiteSigmas.reduce((a, b) => a + b, 0) / finiteSigmas.length
    : null;

  const bound = Math.max(...errors.map(Math.abs), sigma1 ? sigma1 * 3 : 0, 1) * 1.15;

  return (
    <div className="grid-2">
      <Panel title={`${labelFor(report.axis)} Prediction Error at ${report.horizonHours}h`}>
        <ErrorTimeline
          points={report.samples.map((s) => ({ x: s.madeAtMs, y: s.errorM }))}
          sigma1={sigma1}
          bound={bound}
          axisLabel="Position Error (m)"
        />
      </Panel>

      <Panel title={`${labelFor(report.axis)} Prediction Error CDF at ${report.horizonHours}h`}>
        <CdfChart points={report.errorCdf} axisLabel="Position Error (m)" symmetric />
      </Panel>

      <Panel title={`${labelFor(report.axis)} Mahalanobis Distance at ${report.horizonHours}h`}>
        <ErrorTimeline
          points={report.samples
            .filter((s) => s.mahalanobis !== null)
            .map((s) => ({ x: s.madeAtMs, y: s.mahalanobis as number }))}
          sigma1={null}
          bound={Math.max(1, ...report.samples.map((s) => s.mahalanobis ?? 0)) * 1.15}
          axisLabel="1D Maha"
          nonNegative
        />
      </Panel>

      <Panel title={`${labelFor(report.axis)} Mahalanobis CDF at ${report.horizonHours}h`}>
        <CdfChart
          points={report.mahaCdf}
          axisLabel="1D Mahalanobis distance"
          reference={chi2Cdf1}
        />
      </Panel>

      <div style={{ gridColumn: "1 / -1" }} className="faint mono-sm">
        {report.summary.count} samples · mean error {report.summary.meanErrorM.toFixed(2)} m ·
        σ {report.summary.stdErrorM.toFixed(2)} m · RMS {report.summary.rmsErrorM.toFixed(2)} m
        {report.summary.meanMahalanobis !== null && (
          <> · mean Maha {report.summary.meanMahalanobis.toFixed(2)}</>
        )}
        {report.summary.fractionOutside3Sigma !== null && (
          <>
            {" "}
            · outside 3σ {(report.summary.fractionOutside3Sigma * 100).toFixed(1)}%
          </>
        )}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">{title}</div>
      <div className="card-body">{children}</div>
    </section>
  );
}

function labelFor(axis: string): string {
  return axis === "R" ? "Radial" : axis === "T" ? "InTrack" : "CrossTrack";
}

/** Error over the sequence of predictions, with ±1σ and ±3σ bands. */
function ErrorTimeline({
  points,
  sigma1,
  bound,
  axisLabel,
  nonNegative = false,
}: {
  points: { x: number; y: number }[];
  sigma1: number | null;
  bound: number;
  axisLabel: string;
  nonNegative?: boolean;
}) {
  const W = 560;
  const H = 210;
  const PAD = { l: 52, r: 14, t: 14, b: 30 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const lo = nonNegative ? 0 : -bound;
  const hi = bound;
  const y = (v: number) => PAD.t + innerH - ((v - lo) / (hi - lo || 1)) * innerH;
  const x = (i: number) =>
    PAD.l + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`)
    .join(" ");

  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={axisLabel}>
      {sigma1 !== null && !nonNegative && (
        <>
          <rect
            x={PAD.l}
            y={y(sigma1 * 3)}
            width={innerW}
            height={Math.abs(y(-sigma1 * 3) - y(sigma1 * 3))}
            fill="#ff4d5e"
            opacity="0.16"
          />
          <rect
            x={PAD.l}
            y={y(sigma1)}
            width={innerW}
            height={Math.abs(y(-sigma1) - y(sigma1))}
            fill="#2ec27e"
            opacity="0.22"
          />
          <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="#3a3a3a" strokeWidth="1" />
        </>
      )}

      {[hi, 0, lo]
        .filter((v, i, arr) => !nonNegative || i > 0)
        .map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#222" strokeWidth="1" />
            <text
              x={PAD.l - 8}
              y={y(v) + 4}
              textAnchor="end"
              fill="#6b6b6b"
              fontSize="9.5"
              fontFamily="ui-monospace, monospace"
            >
              {v.toFixed(v === 0 ? 0 : 1)}
            </text>
          </g>
        ))}

      <path d={path} fill="none" stroke="#2ec27e" strokeWidth="1.3" />
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.y)} r="1.6" fill="#2ec27e" />
      ))}

      <text x={W / 2} y={H - 8} textAnchor="middle" fill="#6b6b6b" fontSize="9.5">
        Prediction sequence
      </text>
      <text
        x={PAD.l - 38}
        y={PAD.t + innerH / 2}
        fill="#6b6b6b"
        fontSize="9.5"
        textAnchor="middle"
        transform={`rotate(-90 ${PAD.l - 38} ${PAD.t + innerH / 2})`}
      >
        {axisLabel}
      </text>
    </svg>
  );
}

/** Empirical CDF, optionally overlaid with a theoretical reference curve. */
function CdfChart({
  points,
  axisLabel,
  reference,
  symmetric = false,
}: {
  points: { x: number; p: number }[];
  axisLabel: string;
  reference?: (x: number) => number;
  symmetric?: boolean;
}) {
  const W = 560;
  const H = 210;
  const PAD = { l: 46, r: 14, t: 14, b: 30 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const xs = points.map((p) => p.x);
  const lo = Math.min(...xs, 0);
  const hi = Math.max(...xs, 1);
  const span = hi - lo || 1;

  const x = (v: number) => PAD.l + ((v - lo) / span) * innerW;
  const y = (p: number) => PAD.t + innerH - p * innerH;

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.x).toFixed(1)},${y(p.p).toFixed(1)}`)
    .join(" ");

  const refPath = reference
    ? (() => {
        const step = span / 60;
        const segs: string[] = [];
        for (let i = 0; i <= 60; i += 1) {
          const v = lo + i * step;
          segs.push(`${i === 0 ? "M" : "L"}${x(v).toFixed(1)},${y(reference(v)).toFixed(1)}`);
        }
        return segs.join(" ");
      })()
    : null;

  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={axisLabel}>
      {[0, 0.2, 0.4, 0.6, 0.8, 1].map((p) => (
        <g key={p}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(p)} y2={y(p)} stroke="#222" />
          <text
            x={PAD.l - 8}
            y={y(p) + 4}
            textAnchor="end"
            fill="#6b6b6b"
            fontSize="9.5"
            fontFamily="ui-monospace, monospace"
          >
            {p}
          </text>
        </g>
      ))}

      {symmetric && (
        <line x1={x(0)} x2={x(0)} y1={PAD.t} y2={PAD.t + innerH} stroke="#3a3a3a" strokeDasharray="3 3" />
      )}

      <path d={path} fill="none" stroke="#2ec27e" strokeWidth="1.6" />
      {refPath && (
        <path d={refPath} fill="none" stroke="#9a9a9a" strokeWidth="1.2" strokeDasharray="5 4" />
      )}

      <text x={W / 2} y={H - 8} textAnchor="middle" fill="#6b6b6b" fontSize="9.5">
        {axisLabel}
      </text>
      <text
        x={PAD.l - 34}
        y={PAD.t + innerH / 2}
        fill="#6b6b6b"
        fontSize="9.5"
        textAnchor="middle"
        transform={`rotate(-90 ${PAD.l - 34} ${PAD.t + innerH / 2})`}
      >
        Fraction
      </text>
    </svg>
  );
}
