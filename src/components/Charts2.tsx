"use client";

import { useMemo, useState } from "react";

import type { OrbitalElements } from "@/lib/core/kinematics";
import { useChartTheme } from "@/lib/vi/theme-bridge";
import { useTranslator } from "@/lib/i18n/client";

export interface ElementSample {
  tMs: number;
  el: OrbitalElements;
}

const METRICS = [
  { key: "smaAltitudeKm", label: "SMA", unit: "km", digits: 1 },
  { key: "inclinationDeg", label: "Inc", unit: "°", digits: 3 },
  { key: "e", label: "Ecc", unit: "", digits: 5 },
  { key: "raanDeg", label: "RAAN", unit: "°", digits: 2 },
  { key: "argPerigeeDeg", label: "AoP", unit: "°", digits: 2 },
  { key: "meanAnomalyDeg", label: "MA", unit: "°", digits: 1 },
] as const;

type MetricKey = (typeof METRICS)[number]["key"];

/**
 * Orbital-element trend, mirroring the official "Mean Orbital Elements" panel:
 * a scatter/line of one element across the trajectory's span, with a metric
 * switcher underneath.
 */
export function ElementsChart({ series }: { series: ElementSample[] }) {
  const t = useTranslator();
  const theme = useChartTheme();
  const [metric, setMetric] = useState<MetricKey>("smaAltitudeKm");
  const meta = METRICS.find((m) => m.key === metric)!;

  const chart = useMemo(() => {
    if (series.length < 2) return null;

    const W = 620;
    const H = 220;
    const PAD = { l: 62, r: 14, t: 14, b: 30 };

    const values = series.map((s) => s.el[metric] as number);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || Math.abs(max) || 1;

    const innerW = W - PAD.l - PAD.r;
    const innerH = H - PAD.t - PAD.b;

    const x = (i: number) => PAD.l + (i / (series.length - 1)) * innerW;
    const y = (v: number) => PAD.t + innerH - ((v - min) / span) * innerH;

    const path = values
      .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .join(" ");

    return { W, H, PAD, min, max, x, y, path, values };
  }, [series, metric]);

  if (!chart) {
    return (
      <div className="empty">
        {t.t("chart.notEnoughStates")}
        <br />
        {t.t("chart.supportedFormats")}
      </div>
    );
  }

  const { W, H, PAD, min, max, x, y, path, values } = chart;
  const firstT = series[0].tMs;
  const midT = series[Math.floor(series.length / 2)].tMs;
  const lastT = series[series.length - 1].tMs;

  return (
    <div>
      <svg
        className="sparkline"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t.t("chart.elementsOverTime", { metric: meta.label })}
      >
        {[max, (max + min) / 2, min].map((v, i) => (
          <g key={i}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(v)}
              y2={y(v)}
              stroke={theme.axis}
              strokeWidth="1"
            />
            <text
              x={PAD.l - 8}
              y={y(v) + 4}
              textAnchor="end"
              fill={theme.label}
              fontSize="9.5"
              fontFamily="ui-monospace, monospace"
            >
              {v.toFixed(meta.digits)}
            </text>
          </g>
        ))}

        <path d={path} fill="none" stroke={theme.series} strokeWidth="1.2" />

        {values.map((v, i) =>
          i % Math.max(1, Math.floor(values.length / 120)) === 0 ? (
            <circle key={i} cx={x(i)} cy={y(v)} r="1.1" fill={theme.series} opacity="0.75" />
          ) : null,
        )}

        {[firstT, midT, lastT].map((t, i) => {
          const idx = [0, Math.floor(series.length / 2), series.length - 1][i];
          return (
            <text
              key={t}
              x={x(idx)}
              y={H - 10}
              textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
              fill={theme.label}
              fontSize="9.5"
            >
              {shortDate(t)}
            </text>
          );
        })}

        <text
          x={W / 2}
          y={H - 10}
          textAnchor="middle"
          fill={theme.grid}
          fontSize="9"
        >
          {" "}
        </text>
      </svg>

      <div className="toggle-row" style={{ marginTop: 8 }}>
        {METRICS.map((m) => (
          <button
            key={m.key}
            className={m.key === metric ? "active" : ""}
            onClick={() => setMetric(m.key)}
            type="button"
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="faint" style={{ fontSize: 10.5, marginTop: 6 }}>
        {meta.label} ({meta.unit || "ratio"}) · {series.length} sampled states
      </div>
    </div>
  );
}

function shortDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
