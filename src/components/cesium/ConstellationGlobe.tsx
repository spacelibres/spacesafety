"use client";

/**
 * The constellation view, on Cesium.
 *
 * Responsibilities kept here, and not in `CesiumGlobe`:
 *
 *   - fetching the snapshot and the basemap;
 *   - owning the instance's lifetime (create on mount, destroy on unmount);
 *   - reacting to a theme or language change by *re-applying* to the live
 *     instance rather than recreating it, which would drop the camera position
 *     and re-download 13 MB of tracks.
 *
 * The Cesium class knows nothing about React, and this component knows nothing
 * about Cesium's API — which is what makes the globe testable and the view
 * replaceable.
 */

import { useEffect, useRef, useState } from "react";

import type { SnapshotFile } from "@/lib/geo/snapshot";
import { shellColours, shellLabel, type ShellLegendEntry } from "@/lib/geo/shells";
import { useTranslator } from "@/lib/i18n/client";
import { defaultSceneTheme, onThemeChange, sceneTheme, type SceneTheme } from "@/lib/vi/theme-bridge";
import { ELECTRIC_ORBIT } from "@/lib/vi/palette";

import { CesiumGlobe, type SatelliteInfo } from "./CesiumGlobe";

interface Props {
  height?: number;
}

export function ConstellationGlobe({ height = 620 }: Props) {
  const t = useTranslator();
  const mountRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<CesiumGlobe | null>(null);

  const [snapshot, setSnapshot] = useState<SnapshotFile | null>(null);
  const [legend, setLegend] = useState<ShellLegendEntry[]>([]);
  const [theme, setTheme] = useState<SceneTheme>(() => defaultSceneTheme());
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<SatelliteInfo | null>(null);

  // Follow the document's theme attribute. The switcher, a cookie-driven reload
  // and the OS preference all end up writing it, so one observer covers all three.
  useEffect(() => onThemeChange((mode) => setTheme(sceneTheme(ELECTRIC_ORBIT, mode))), []);

  // Snapshot: one file, ~13 MB, built by `npm run build:snapshot` from TLEs.
  useEffect(() => {
    let cancelled = false;
    fetch("/data/constellation.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: SnapshotFile) => {
        if (cancelled) return;
        setSnapshot(data);
        const counts = new Map<string, number>();
        for (const track of data.tracks) {
          counts.set(track.shell, (counts.get(track.shell) ?? 0) + 1);
        }
        const ordered = [...counts]
          .map(([key, count]) => ({ key, count }))
          .sort((a, b) => b.count - a.count);
        setLegend(shellColours(ordered).legend);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Basemap: graticule only. Country names are deliberately not drawn — see
  // `src/lib/geo/countries.ts` for why the data is archived but not rendered.
  useEffect(() => {
    if (!ready) return;
    globeRef.current?.addBasemap();
  }, [ready]);

  // Create the globe once.
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    let disposed = false;
    let globe: CesiumGlobe | null = null;

    void CesiumGlobe.create({
      container,
      theme,
      onPick: setSelected,
    })
      .then((created) => {
        if (disposed) {
          created.dispose();
          return;
        }
        globe = created;
        globeRef.current = created;
        setReady(true);
      })
      .catch((e: Error) => setError(e.message));

    return () => {
      disposed = true;
      globe?.dispose();
      globeRef.current = null;
      setReady(false);
    };
    // Creation must happen once: the theme and the data are applied to the live
    // instance by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tracks.
  useEffect(() => {
    if (!ready || !snapshot || !globeRef.current) return;
    const colours = new Map(legend.map((entry) => [entry.key, entry.colour]));
    globeRef.current.addConstellation(snapshot, colours);
    // The previous selection refers to a dot that no longer exists.
    setSelected(null);
  }, [ready, snapshot, legend]);

  // Theme.
  useEffect(() => {
    globeRef.current?.applyTheme(theme);
  }, [ready, theme]);

  // Animation. Cesium drives its own render loop; this only exists for the
  // per-orbit trail phase that replaces the static polylines later.
  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    const loop = () => {
      globeRef.current?.tick();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  const summary = snapshot
    ? t.t("constellation.count", { count: snapshot.tracks.length })
    : error
      ? t.t("constellation.missing")
      : t.t("common.loading");

  return (
    <div className="constellation">
      <div className="constellation-canvas" ref={mountRef} style={{ height }} />
      {selected ? (
        <div className="satellite-card">
          <div className="satellite-card-head">
            <span className="satellite-card-title">{selected.name}</span>
            <button
              type="button"
              className="satellite-card-close"
              onClick={() => setSelected(null)}
              aria-label={t.t("constellation.clearSelection")}
            >
              ×
            </button>
          </div>
          <dl className="satellite-card-fields">
            <dt>{t.t("constellation.norad")}</dt>
            <dd className="mono">{selected.norad}</dd>
            <dt>{t.t("constellation.shell")}</dt>
            <dd className="mono">{shellLabel(selected.shell)}</dd>
            <dt>{t.t("constellation.latitude")}</dt>
            <dd className="mono">{formatAngle(selected.latitude)}</dd>
            <dt>{t.t("constellation.longitude")}</dt>
            <dd className="mono">{formatAngle(selected.longitude)}</dd>
            <dt>{t.t("constellation.altitude")}</dt>
            <dd className="mono">{Math.round(selected.altitudeKm).toLocaleString()} km</dd>
          </dl>
        </div>
      ) : (
        <div className="constellation-hint">{t.t("constellation.pickHint")}</div>
      )}
      <div className="constellation-legend">
        <div className="constellation-summary">{summary}</div>
        {legend.slice(0, 8).map((entry) => (
          <div className="legend-row" key={entry.key}>
            <span className="legend-swatch" style={{ background: entry.colour }} />
            <span className="legend-key">{shellLabel(entry.key)}</span>
            <span className="legend-count">{entry.count.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Latitude or longitude as `12.35°`.
 *
 * The hemisphere is carried by a sign rather than a letter: the numeric value is
 * what a reader compares against other tools, and `-58.20°` cannot be mistaken
 * for `58.20° E` the way an unlabelled `58.20°` can.
 */
function formatAngle(degrees: number): string {
  return `${degrees.toFixed(2)}°`;
}
