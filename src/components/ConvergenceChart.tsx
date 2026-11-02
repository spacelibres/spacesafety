"use client";

import { useTranslator } from "@/lib/i18n/client";
import { useChartTheme } from "@/lib/vi/theme-bridge";

/**
 * How a conjunction's estimate moved, message by message.
 *
 * ## What this is, and what it is not
 *
 * The reference UI shows a *prediction consistency* chart: the R/T/N position
 * error of each CDM against a reference trajectory. That needs both trajectories'
 * states at each message's creation time — real computation, not plotting — and it
 * is recorded as a gap (`docs/GAPS.md` P17).
 *
 * What the published feed does support is the part a reader actually acts on: the
 * miss distance and the probability that each successive message predicted, plotted
 * against the time remaining to the predicted TCA. An estimate that is settling
 * shows a converging, narrowing spread; one that keeps jumping between 400 km and
 * 70 km is not something to plan around, whatever the latest Pc says.
 *
 * The axis is drawn in hours-to-TCA, right to left, matching the reference chart:
 * the leftmost point is the earliest message and the rightmost is the prediction
 * closest to the encounter.
 */
export interface ConvergencePoint {
  /** Hours from this message's issue time to the TCA it predicted. */
  hoursToTca: number | null;
  pc: number | null;
  minRangeKm: number | null;
  label: string;
}

export function ConvergenceChart({ points }: { points: ConvergencePoint[] }) {
  const theme = useChartTheme();
  const t = useTranslator();
  const usable = points.filter((p) => p.hoursToTca !== null);
  if (usable.length < 2) {
    return (
      <p className="faint" style={{ fontSize: 12, margin: 0 }}>
        —
      </p>
    );
  }

  // Time-to-go decreases with every message, so plotting it as x draws the history
  // left-to-right in issue order with the encounter at the right edge.
  const xs = usable.map((p) => p.hoursToTca as number);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);

  const W = 520;
  const H = 72;
  const pad = { l: 40, r: 8, t: 8, b: 16 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  // Guard the degenerate case of a single distinct time-to-go value.
  const span = xMax - xMin || 1;
  const xOf = (hours: number) => pad.l + ((xMax - hours) / span) * innerW;

  /** One panel: a line through the points, own y-scale. */
  const panel = (
    values: Array<number | null>,
    colour: string,
    format: (v: number) => string,
    keyPrefix: string,
  ) => {
    const present = values.filter((v): v is number => v !== null);
    if (present.length === 0) return null;
    const lo = Math.min(...present);
    const hi = Math.max(...present);
    const range = hi - lo || 1;
    const yOf = (v: number) => pad.t + innerH - ((v - lo) / range) * innerH;

    let d = "";
    let started = false;
    values.forEach((v, i) => {
      if (v === null) return;
      const x = xOf(usable[i].hoursToTca as number);
      const y = yOf(v);
      d += `${started ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      started = true;
    });

    return (
      <g key={keyPrefix}>
        <line
          x1={pad.l}
          x2={W - pad.r}
          y1={pad.t + innerH}
          y2={pad.t + innerH}
          stroke={theme.grid}
          strokeWidth="1"
        />
        <path d={d} fill="none" stroke={colour} strokeWidth="1.6" />
        {values.map((v, i) =>
          v === null ? null : (
            <circle
              key={`${keyPrefix}-d${i}`}
              cx={xOf(usable[i].hoursToTca as number)}
              cy={yOf(v)}
              r="2.4"
              fill={colour}
            />
          ),
        )}
        <text x={4} y={pad.t + 8} fill={theme.label} fontSize="9">
          {format(hi)}
        </text>
        <text x={4} y={pad.t + innerH} fill={theme.label} fontSize="9">
          {format(lo)}
        </text>
      </g>
    );
  };

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={t.t("publishedConjunction.estimate")}>
        {panel(
          usable.map((p) => p.minRangeKm),
          theme.series,
          (v) => `${Math.round(v)} km`,
          "range",
        )}
        {panel(
          usable.map((p) => (p.pc === null ? null : p.pc * 1000)),
          theme.reference,
          (v) => `${v.toFixed(2)}‰`,
          "pc",
        )}
        {/* x labels: earliest message on the left, encounter at the right */}
        <text x={pad.l} y={H - 3} fill={theme.label} fontSize="9">
          T-{xMax.toFixed(0)}h
        </text>
        <text x={W - pad.r} y={H - 3} fill={theme.label} fontSize="9" textAnchor="end">
          T-{xMin.toFixed(0)}h
        </text>
      </svg>
      <div style={{ display: "flex", gap: 14, fontSize: 10.5, color: theme.label, marginTop: 2 }}>
        <span>
          <span style={{ color: theme.series }}>▬</span>{" "}
          {t.t("publishedConjunction.legendRange", { count: usable.length })}
        </span>
        <span>
          <span style={{ color: theme.reference }}>▬</span> {t.t("publishedConjunction.legendPc")}
        </span>
      </div>
    </div>
  );
}
