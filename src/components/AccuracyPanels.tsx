"use client";

import type { AccuracyReport } from "@/lib/core/accuracy-report";
import { useChartTheme } from "@/lib/vi/theme-bridge";
import { chi2Cdf1 } from "@/lib/core/accuracy";
import { useTranslator } from "@/lib/i18n/client";
import type { Translator } from "@/lib/i18n";

/**
 * Prediction-accuracy panels, mirroring the official object page:
 * error over time (with 1σ/3σ bands), its CDF, Mahalanobis distance, and the
 * Mahalanobis CDF against a chi-squared(k=1) reference.
 */
export function AccuracyPanels({ report }: { report: AccuracyReport }) {
  const t = useTranslator();
  if (report.samples.length === 0) {
    return (
      <div className="empty">
        {t.t("accuracy.notEnough")}
        <br />
        {t.t("accuracy.needTwo")}
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
      <Panel title={t.t("accuracy.panelError", { axis: labelFor(t, report.axis), hours: report.horizonHours })}>
        <ErrorTimeline
          points={report.samples.map((s) => ({ x: s.madeAtMs, y: s.errorM }))}
          sigma1={sigma1}
          bound={bound}
          axisLabel="Position Error (m)"
        />
      </Panel>

      <Panel title={t.t("accuracy.panelErrorCdf", { axis: labelFor(t, report.axis), hours: report.horizonHours })}>
        <CdfChart points={report.errorCdf} axisLabel="Position Error (m)" symmetric />
      </Panel>

      <Panel title={t.t("accuracy.panelMahalanobis", { axis: labelFor(t, report.axis), hours: report.horizonHours })}>
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

      <Panel title={t.t("accuracy.panelMahalanobisCdf", { axis: labelFor(t, report.axis), hours: report.horizonHours })}>
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

/**
 * Translate an RTN axis code.
 *
 * The code itself (`R`/`T`/`N`) is a technical identifier and stays as it is;
 * the word beside it is copy and comes from the dictionary.
 */
function labelFor(t: Translator, axis: string): string {
  const key = axis === "R" ? "accuracy.axisRadial" : axis === "T" ? "accuracy.axisInTrack" : "accuracy.axisCrossTrack";
  return t.t(key);
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
  const t = useTranslator();
  const theme = useChartTheme();
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
            fill={theme.danger}
            opacity="0.16"
          />
          <rect
            x={PAD.l}
            y={y(sigma1)}
            width={innerW}
            height={Math.abs(y(-sigma1) - y(sigma1))}
            fill={theme.ok}
            opacity="0.22"
          />
          <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke={theme.zero} strokeWidth="1" />
        </>
      )}

      {[hi, 0, lo]
        .filter((v, i, arr) => !nonNegative || i > 0)
        .map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke={theme.grid} strokeWidth="1" />
            <text
              x={PAD.l - 8}
              y={y(v) + 4}
              textAnchor="end"
              fill={theme.label}
              fontSize="9.5"
              fontFamily="ui-monospace, monospace"
            >
              {v.toFixed(v === 0 ? 0 : 1)}
            </text>
          </g>
        ))}

      <path d={path} fill="none" stroke={theme.ok} strokeWidth="1.3" />
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.y)} r="1.6" fill={theme.ok} />
      ))}

      <text x={W / 2} y={H - 8} textAnchor="middle" fill={theme.label} fontSize="9.5">
        {t.t("accuracy.sequenceAxis")}
      </text>
      <text
        x={PAD.l - 38}
        y={PAD.t + innerH / 2}
        fill={theme.label}
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
  const t = useTranslator();
  const theme = useChartTheme();
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
          <line x1={PAD.l} x2={W - PAD.r} y1={y(p)} y2={y(p)} stroke={theme.grid} />
          <text
            x={PAD.l - 8}
            y={y(p) + 4}
            textAnchor="end"
            fill={theme.label}
            fontSize="9.5"
            fontFamily="ui-monospace, monospace"
          >
            {p}
          </text>
        </g>
      ))}

      {symmetric && (
        <line x1={x(0)} x2={x(0)} y1={PAD.t} y2={PAD.t + innerH} stroke={theme.zero} strokeDasharray="3 3" />
      )}

      <path d={path} fill="none" stroke={theme.ok} strokeWidth="1.6" />
      {refPath && (
        <path d={refPath} fill="none" stroke={theme.reference} strokeWidth="1.2" strokeDasharray="5 4" />
      )}

      <text x={W / 2} y={H - 8} textAnchor="middle" fill={theme.label} fontSize="9.5">
        {axisLabel}
      </text>
      <text
        x={PAD.l - 34}
        y={PAD.t + innerH / 2}
        fill={theme.label}
        fontSize="9.5"
        textAnchor="middle"
        transform={`rotate(-90 ${PAD.l - 34} ${PAD.t + innerH / 2})`}
      >
        {t.t("accuracy.fractionAxis")}
      </text>
    </svg>
  );
}
