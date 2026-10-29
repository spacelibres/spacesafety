"use client";

import { useEffect, useMemo, useState } from "react";

import OrbitViewer, { type OrbitTrack } from "@/components/OrbitViewer";

interface Props {
  limit?: number;
}

interface ApiTrack {
  objectId: string;
  objectName: string;
  operatorName: string;
  points: [number, number, number][];
  tMs: number[];
}

/**
 * Loads renderable orbits from the server and animates them.
 *
 * Sampling happens server-side (the parser and frame transforms live there), so
 * the browser only receives plain coordinate arrays.
 */
export default function HomeViewer({ limit = 60 }: Props) {
  const [tracks, setTracks] = useState<ApiTrack[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/render/tracks?limit=${limit}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { tracks: ApiTrack[] }) => {
        if (!cancelled) setTracks(data.tracks ?? []);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [limit]);

  // Advance the simulation clock in real time, once any tracks are loaded.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const rendered = useMemo<OrbitTrack[]>(() => {
    return tracks.map((t, i) => ({
      objectId: t.objectId,
      objectName: t.objectName,
      points: t.points,
      tMs: t.tMs,
      color: PALETTE[i % PALETTE.length],
      emphasis: i < 3,
      showSatellite: true,
    }));
  }, [tracks]);

  if (error) {
    return (
      <div className="empty">
        Could not load orbits: {error}
        <br />
        Upload a trajectory (or run <code className="mono">npm run demo:seed</code>)
        to populate the catalog.
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <OrbitViewer tracks={rendered} sceneTimeMs={now} height={420} />
      <div className="viewer-overlay">
        <span className="viewer-badge">
          {tracks.length} orbit{tracks.length === 1 ? "" : "s"} rendered
        </span>
      </div>
      <div className="viewer-legend">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: PALETTE[0] }} />
          catalog
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: PALETTE[3] }} />
          other operators
        </span>
      </div>
    </div>
  );
}

const PALETTE = [
  "#4da3ff",
  "#2ec27e",
  "#ffb020",
  "#b48ef0",
  "#4fd1c5",
  "#f08a8a",
];
