"use client";

/**
 * Lightweight SVG charts.
 *
 * The official UI renders these panels with an interactive charting library; we
 * only need the visual contract (dark grid, thin strokes, monospace axes) and
 * zero client-side dependencies, so they are drawn by hand.
 */

import { logDomain, logTicks, logToY } from "./chart-axes";

export interface PcPoint {
  id: string;
  createdAt: string;
  pc: number | null;
  isActive: boolean;
  source1: string;
  source2: string;
}

/**
 * Pc over successive CDMs for one conjunction event.
 *
 * Plotted on a log axis because collision probabilities span many decades; a
 * linear axis would flatten everything except the last point.
 */
export function PcHistoryChart({ points }: { points: PcPoint[] }) {
  const W = 760;
  const H = 240;
  const PAD = { l: 56, r: 16, t: 16, b: 34 };

  const usable = points.filter((p) => p.pc !== null && p.pc > 0);
  if (usable.length === 0) {
    return (
      <div className="empty">
        No probability values recorded yet.
        <br />
        Pc is NULL when either trajectory carried no covariance.
      </div>
    );
  }

  // A single point (or several identical ones) makes `hi === lo`; `logDomain`
  // widens that case instead of collapsing the axis. See `chart-axes.ts`.
  const domain = logDomain(usable.map((p) => p.pc as number));

  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const x = (i: number) =>
    PAD.l + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (pc: number) => logToY(Math.log10(pc), domain, PAD.t, innerH);

  const path = points
    .map((p, i) => (p.pc && p.pc > 0 ? `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.pc).toFixed(1)}` : ""))
    .filter(Boolean)
    .join(" ");

  // One grid line per whole decade: readable on a log axis, and integers can
  // never collide as React keys.
  const yTicks = logTicks(domain);

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Collision probability history"
    >
      {yTicks.map((v) => {
        const yy = logToY(v, domain, PAD.t, innerH);
        return (
          <g key={`tick-${v}`}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={yy}
              y2={yy}
              stroke="#262626"
              strokeWidth="1"
            />
            <text
              x={PAD.l - 8}
              y={yy + 4}
              textAnchor="end"
              fill="#6b6b6b"
              fontSize="10"
              fontFamily="ui-monospace, monospace"
            >
              {Math.pow(10, v).toExponential(0)}
            </text>
          </g>
        );
      })}

      <path d={path} fill="none" stroke="#2ec27e" strokeWidth="1.5" />

      {points.map((p, i) =>
        p.pc && p.pc > 0 ? (
          <circle
            key={p.id}
            cx={x(i)}
            cy={y(p.pc)}
            r={p.isActive ? 3.5 : 2}
            fill={p.isActive ? "#2ec27e" : "#1d5c3c"}
            stroke={p.isActive ? "#0a0a0a" : "none"}
            strokeWidth="1"
          />
        ) : null,
      )}

      <text
        x={W / 2}
        y={H - 8}
        textAnchor="middle"
        fill="#6b6b6b"
        fontSize="10"
      >
        CDM sequence ({points.length})
      </text>
      <text x={PAD.l - 44} y={PAD.t + innerH / 2} fill="#6b6b6b" fontSize="10" transform={`rotate(-90 ${PAD.l - 44} ${PAD.t + innerH / 2})`} textAnchor="middle">
        Collision probability
      </text>
    </svg>
  );
}

/** Simple bar chart used for distribution summaries. */
export function TinyBars({
  data,
  height = 60,
}: {
  data: { label: string; value: number; color?: string }[];
  height?: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height }}>
      {data.map((d) => (
        <div key={d.label} style={{ flex: 1, textAlign: "center" }}>
          <div
            style={{
              height: Math.max(2, (d.value / max) * (height - 18)),
              background: d.color ?? "#4da3ff",
              borderRadius: 2,
            }}
          />
          <div style={{ fontSize: 9, color: "#6b6b6b", marginTop: 3 }}>
            {d.label}
          </div>
        </div>
      ))}
    </div>
  );
}
