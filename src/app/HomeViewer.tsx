"use client";

/**
 * Loads renderable orbits from the server, the country outlines, and animates
 * the scene.
 *
 * Sampling happens server-side (the parser and frame transforms live there), so
 * the browser only receives plain coordinate arrays. The country basemap is a
 * static asset fetched once and cached by the browser.
 */

import { useEffect, useMemo, useState } from "react";

import OrbitViewer, { type OrbitTrack } from "@/components/OrbitViewer";
import { parseCountries, type CountryFeature } from "@/lib/geo/countries";
import { ELECTRIC_ORBIT, mix } from "@/lib/vi/palette";
import { useLocale, useTranslator } from "@/lib/i18n/client";

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

export default function HomeViewer({ limit = 60 }: Props) {
  const t = useTranslator();
  const locale = useLocale();
  const [tracks, setTracks] = useState<ApiTrack[]>([]);
  const [countries, setCountries] = useState<CountryFeature[]>([]);
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

  // Basemap. A failure is not fatal: the globe still renders, just without
  // borders, so the orbits remain usable.
  useEffect(() => {
    let cancelled = false;
    fetch("/geo/countries-110m.geojson")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (!cancelled) setCountries(parseCountries(data));
      })
      .catch(() => {
        if (!cancelled) setCountries([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  /**
   * Emphasise a few orbits, thin the rest.
   *
   * Sixty full polylines inside one Earth radius reads as a ball of yarn: every
   * track crosses every other and the globe underneath disappears. The VI's
   * "restrained orbital language" is taken literally here — three tracked
   * orbits drawn in full, the remainder as a sparse point cloud, which conveys
   * constellation density without drowning the basemap.
   */
  const MAX_FULL_ORBITS = 2;
  const rendered = useMemo<OrbitTrack[]>(() => {
    return tracks.map((item, index) => {
      const full = index < MAX_FULL_ORBITS;
      return {
        objectId: item.objectId,
        objectName: item.objectName,
        // Decimate the background orbits to roughly one point per 8.
        points: full ? item.points : item.points.filter((_, i) => i % 14 === 0),
        tMs: full ? item.tMs : item.tMs.filter((_, i) => i % 14 === 0),
        color: trackColor(index),
        emphasis: full,
        showSatellite: full,
      };
    });
  }, [tracks]);

  if (error) {
    return (
      <div className="empty">
        {t.t("viewer.loadFailed", { error })}
        <br />
        {t.t("viewer.loadFailedHint")} <code className="mono">npm run demo:seed</code>
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <OrbitViewer
        tracks={rendered}
        sceneTimeMs={now}
        height={420}
        countries={countries}
        locale={locale}
        showCountryLabels
      />
      <div className="viewer-overlay">
        <span className="viewer-badge">
          {t.t("viewer.orbitsRendered", { count: tracks.length })}
        </span>
      </div>
      <div className="viewer-legend">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: trackColor(0) }} />
          {t.t("viewer.catalog")}
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: trackColor(3) }} />
          {t.t("viewer.otherOperators")}
        </span>
      </div>
    </div>
  );
}

/**
 * Track colours derived from the palette rather than listed by hand.
 *
 * Rotating the hue between the palette's accents keeps every track distinguishable
 * while staying inside the VI, which a hard-coded list would not.
 */
function trackColor(index: number): string {
  const accents = [
    ELECTRIC_ORBIT.primary,
    ELECTRIC_ORBIT.success,
    ELECTRIC_ORBIT.warning,
    ELECTRIC_ORBIT.secondary,
    ELECTRIC_ORBIT.accent,
    mix(ELECTRIC_ORBIT.primary, ELECTRIC_ORBIT.accent, 0.5),
  ];
  return accents[index % accents.length];
}
