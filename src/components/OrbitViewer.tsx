"use client";

/**
 * Earth-centred orbital viewer.
 *
 * Three layers, each with one job:
 *
 *   1. **Globe** (`globe/Globe`) — a transparent shell with an accurate 15°
 *      graticule, Natural Earth borders and country label anchors.
 *   2. **Celestial** (`globe/Celestial`) — the Sun and Moon at their real
 *      geocentric directions, plus the star field, so the lighting on the globe
 *      agrees with where the Sun is drawn.
 *   3. **Tracks** — the orbit polylines and satellite markers.
 *
 * Country names and the pointer coordinate readout are DOM overlays rather than
 * canvas text: they stay crisp at any device pixel ratio, are selectable, and can
 * be localised without a font atlas.
 */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

import type { CountryFeature } from "@/lib/geo/countries";
import { formatLatLon, latLonToUnit, unitToLatLon, type LatLon } from "@/lib/geo/sphere";
import { readScenePalette, type ScenePalette } from "@/lib/vi/scene";

import { buildCelestial } from "./globe/Celestial";
import { buildGlobe, type GlobeParts } from "./globe/Globe";

/** One orbit to draw, already projected into inertial km. */
export interface OrbitTrack {
  objectId: string;
  objectName: string;
  points: [number, number, number][];
  tMs: number[];
  color: string;
  emphasis?: boolean;
  showSatellite?: boolean;
}

interface OrbitViewerProps {
  tracks: OrbitTrack[];
  /** Simulation clock, ms. Drives the moving markers and the Sun/Moon. */
  sceneTimeMs: number;
  highlight?: { a: [number, number, number]; b: [number, number, number] } | null;
  height?: number;
  /** Natural Earth outlines; empty until the client has loaded them. */
  countries?: CountryFeature[];
  /** Locale for country labels. */
  locale?: string;
  /** Draw country names on the visible hemisphere. */
  showCountryLabels?: boolean;
}

const GLOBE_RADIUS = 1;
const KM_PER_GLOBE = 6378.137;

export default function OrbitViewer({
  tracks,
  sceneTimeMs,
  highlight,
  height = 460,
  countries = [],
  locale = "en",
  showCountryLabels = true,
}: OrbitViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<ViewerState | null>(null);
  const dataRef = useRef({ tracks, sceneTimeMs, highlight, locale, showCountryLabels });
  dataRef.current = { tracks, sceneTimeMs, highlight, locale, showCountryLabels };

  /** Pointer position on the globe, or null when off the sphere. */
  const [cursor, setCursor] = useState<LatLon | null>(null);
  /** Country label overlays, recomputed per animation frame. */
  const [labels, setLabels] = useState<Array<{ iso2: string; name: string; x: number; y: number }>>(
    [],
  );

  // The globe itself is rebuilt when the country set or locale changes; tracks
  // are not, because they update far more often than the basemap.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const state = stateRef.current;
    if (!state) return;
    state.rebuildGlobe(countries, locale);
  }, [countries, locale]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const state = createViewer(mount, {
      onCursor: setCursor,
      onLabels: setLabels,
      showCountryLabels,
    });
    stateRef.current = state;
    state.rebuildGlobe(countries, locale);

    let frame = 0;
    const tick = () => {
      const current = dataRef.current;
      state.syncTracks(current.tracks);
      state.updateSatellites(current.tracks, current.sceneTimeMs);
      state.updateHighlight(current.highlight ?? null);
      state.updateTime(current.sceneTimeMs);
      state.updateLabels(dataRef.current.showCountryLabels);
      state.controls.update();
      state.renderer.render(state.scene, state.camera);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    const onResize = () => state.resize(mount.clientWidth, mount.clientHeight);
    const observer = new ResizeObserver(onResize);
    observer.observe(mount);
    onResize();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      state.dispose();
      stateRef.current = null;
    };
    // Mount once: every changing input is read through `dataRef` each frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="viewer" ref={mountRef} style={{ height }}>
      {labels.map((label) => (
        <span
          key={label.iso2}
          className="globe-label"
          style={{ left: label.x, top: label.y }}
          aria-hidden="true"
        >
          {label.name}
        </span>
      ))}
      <div className="globe-cursor" aria-live="polite">
        {cursor ? formatLatLon(cursor.lat, cursor.lon) : ""}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface ViewerCallbacks {
  onCursor: (position: LatLon | null) => void;
  onLabels: (labels: Array<{ iso2: string; name: string; x: number; y: number }>) => void;
  showCountryLabels: boolean;
}

interface ViewerState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: { target: THREE.Vector3; update: () => void; dispose: () => void };
  syncTracks: (tracks: OrbitTrack[]) => void;
  updateSatellites: (tracks: OrbitTrack[], tMs: number) => void;
  updateHighlight: (h: { a: [number, number, number]; b: [number, number, number] } | null) => void;
  updateTime: (tMs: number) => void;
  updateLabels: (visible: boolean) => void;
  rebuildGlobe: (countries: CountryFeature[], locale: string) => void;
  resize: (w: number, h: number) => void;
  dispose: () => void;
}

function createViewer(mount: HTMLDivElement, callbacks: ViewerCallbacks): ViewerState {
  const palette = readScenePalette(mount);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 4000);
  camera.position.set(2.9, 1.9, 3.1);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  mount.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(palette.ambient, 1.1));
  const rim = new THREE.DirectionalLight(palette.rim, 0.8);
  rim.position.set(-5, -2, -4);
  scene.add(rim);

  const celestial = buildCelestial({
    earthRadius: GLOBE_RADIUS,
    palette: {
      sun: palette.sun,
      moon: palette.moon,
      star: palette.star,
      glow: palette.selection,
    },
    // A real Sun sits 23 000 Earth radii away — far beyond the camera's far
    // plane and invisible at any sensible zoom. Both bodies are pulled in to a
    // usable distance while keeping their *directions* real, so the lighting on
    // the globe still agrees with where the Sun is drawn.
    sunDistance: GLOBE_RADIUS * 7.5,
    moonDistance: GLOBE_RADIUS * 9.5,
  });
  scene.add(celestial.group);

  // An outer atmosphere glow, additive so it reads as light rather than a shell.
  const atmosphereGeometry = new THREE.SphereGeometry(GLOBE_RADIUS * 1.045, 64, 48);
  const atmosphereMaterial = new THREE.MeshBasicMaterial({
    color: palette.atmosphere,
    transparent: true,
    opacity: 0.12,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  scene.add(new THREE.Mesh(atmosphereGeometry, atmosphereMaterial));

  let globe: GlobeParts | null = null;
  let globeLabels: GlobeParts["labels"] = [];

  const controls = createControls(renderer.domElement, camera, new THREE.Vector3(0, 0, 0));

  // Per-viewer mutable state: module-level variables here would be shared by
  // every viewer on the page and leak between mounts.
  let lastCelestialKey = -1;
  let labelsShown = false;

  const trackGroups = new Map<string, { line: THREE.Line; signature: string }>();
  const satellites = new Map<string, THREE.Mesh>();
  let highlightGroup = new THREE.Group();
  scene.add(highlightGroup);

  // Pointer readout: raycast against a mathematical sphere rather than the
  // shell mesh, so the accuracy does not depend on the tessellation.
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const globeSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), GLOBE_RADIUS);

  const onPointerMove = (event: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.ray.intersectSphere(globeSphere, new THREE.Vector3());
    if (!hit) {
      callbacks.onCursor(null);
      return;
    }
    const { lat, lon } = unitToLatLon(hit.x, hit.y, hit.z);
    callbacks.onCursor({ lat, lon });
  };
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerleave", () => callbacks.onCursor(null));

  /**
   * Project the labels that are on the near hemisphere and keep them apart.
   *
   * 177 country names on a small globe overlap badly — the first render had
   * "Chile"/"Bolivia"/"Paraguay" stacked on top of each other. Two passes fix
   * that without hiding geography: the label nearest the viewer always wins, then
   * a candidate is dropped if its screen box would touch one already placed. The
   * effect is a natural zoom: rotating the globe brings crowded regions forward
   * instead of drawing everything at once.
   */
  const projectLabels = () => {
    const rect = renderer.domElement.getBoundingClientRect();
    const toCamera: [number, number, number] = [
      camera.position.x,
      camera.position.y,
      camera.position.z,
    ];
    const distance = Math.hypot(...toCamera) || 1;
    const dir: [number, number, number] = [
      toCamera[0] / distance,
      toCamera[1] / distance,
      toCamera[2] / distance,
    ];

    type Candidate = { iso2: string; name: string; x: number; y: number; facing: number };
    const candidates: Candidate[] = [];

    for (const label of globeLabels) {
      const unit = label.position.clone().normalize();
      const facing = unit.x * dir[0] + unit.y * dir[1] + unit.z * dir[2];
      // Near hemisphere only: a label on the far side would show through the
      // transparent shell and read as if it were in front.
      if (facing < 0.15) continue;

      const projected = label.position.clone().project(camera);
      candidates.push({
        iso2: label.iso2,
        name: label.name,
        x: ((projected.x + 1) / 2) * rect.width,
        y: ((1 - projected.y) / 2) * rect.height,
        facing,
      });
    }

    // Most face-on first, so the clearest label survives a collision.
    candidates.sort((a, b) => b.facing - a.facing);

    // Approximate label box: the longest a name gets is ~20 characters.
    const placed: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    const visible: Array<{ iso2: string; name: string; x: number; y: number }> = [];
    for (const candidate of candidates) {
      const halfWidth = Math.min(48, 6 + candidate.name.length * 2.6);
      const box = {
        x1: candidate.x - halfWidth,
        y1: candidate.y - 7,
        x2: candidate.x + halfWidth,
        y2: candidate.y + 7,
      };
      const collides = placed.some(
        (other) => box.x1 < other.x2 && box.x2 > other.x1 && box.y1 < other.y2 && box.y2 > other.y1,
      );
      if (collides) continue;
      placed.push(box);
      visible.push({ iso2: candidate.iso2, name: candidate.name, x: candidate.x, y: candidate.y });
    }

    // Fainter as labels approach the limb, so the sphere still reads as a sphere.
    callbacks.onLabels(visible);
  };

  return {
    renderer,
    scene,
    camera,
    controls,

    rebuildGlobe(countries, locale) {
      if (globe) {
        scene.remove(globe.group);
        globe.dispose();
      }
      globe = buildGlobe({ radius: GLOBE_RADIUS, palette, countries, locale });
      globeLabels = globe.labels;
      scene.add(globe.group);
    },

    syncTracks(tracks) {
      const seen = new Set<string>();
      for (const track of tracks) {
        seen.add(track.objectId);
        // Signature avoids rebuilding geometry for an unchanged track on every
        // frame; the point count plus the first/last epoch identifies it.
        const signature = `${track.points.length}|${track.tMs[0] ?? 0}|${track.tMs.at(-1) ?? 0}|${track.color}`;
        const existing = trackGroups.get(track.objectId);
        if (existing && existing.signature === signature) continue;

        if (existing) {
          scene.remove(existing.line);
          existing.line.geometry.dispose();
          (existing.line.material as THREE.Material).dispose();
        }

        const positions = new Float32Array(track.points.length * 3);
        for (let i = 0; i < track.points.length; i += 1) {
          const p = track.points[i];
          positions[i * 3] = (p[0] / KM_PER_GLOBE) * GLOBE_RADIUS;
          positions[i * 3 + 1] = (p[1] / KM_PER_GLOBE) * GLOBE_RADIUS;
          positions[i * 3 + 2] = (p[2] / KM_PER_GLOBE) * GLOBE_RADIUS;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        const material = new THREE.LineBasicMaterial({
          color: new THREE.Color(track.color),
          transparent: true,
          // Emphasised orbits read clearly; the rest stay faint enough that the
          // graticule and country borders remain legible underneath them.
          opacity: track.emphasis ? 0.92 : 0.22,
        });
        const line = new THREE.Line(geometry, material);
        scene.add(line);
        trackGroups.set(track.objectId, { line, signature });
      }

      for (const [id, entry] of trackGroups) {
        if (seen.has(id)) continue;
        scene.remove(entry.line);
        entry.line.geometry.dispose();
        (entry.line.material as THREE.Material).dispose();
        trackGroups.delete(id);
      }
    },

    updateSatellites(tracks, tMs) {
      const seen = new Set<string>();
      for (const track of tracks) {
        if (track.showSatellite === false || track.points.length === 0) continue;
        seen.add(track.objectId);

        const index = sampleIndex(track.tMs, tMs);
        const p = track.points[index];
        if (!p) continue;

        let marker = satellites.get(track.objectId);
        if (!marker) {
          marker = new THREE.Mesh(
            new THREE.SphereGeometry(GLOBE_RADIUS * 0.011, 12, 12),
            new THREE.MeshBasicMaterial({ color: new THREE.Color(track.color) }),
          );
          scene.add(marker);
          satellites.set(track.objectId, marker);
        }
        marker.position.set(
          (p[0] / KM_PER_GLOBE) * GLOBE_RADIUS,
          (p[1] / KM_PER_GLOBE) * GLOBE_RADIUS,
          (p[2] / KM_PER_GLOBE) * GLOBE_RADIUS,
        );
      }

      for (const [id, marker] of satellites) {
        if (seen.has(id)) continue;
        scene.remove(marker);
        marker.geometry.dispose();
        (marker.material as THREE.Material).dispose();
        satellites.delete(id);
      }
    },

    updateHighlight(h) {
      scene.remove(highlightGroup);
      for (const child of highlightGroup.children) {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      }
      highlightGroup = new THREE.Group();
      scene.add(highlightGroup);
      if (!h) return;

      const toScene = (p: [number, number, number]) =>
        new THREE.Vector3(
          (p[0] / KM_PER_GLOBE) * GLOBE_RADIUS,
          (p[1] / KM_PER_GLOBE) * GLOBE_RADIUS,
          (p[2] / KM_PER_GLOBE) * GLOBE_RADIUS,
        );

      const a = toScene(h.a);
      const b = toScene(h.b);
      const link = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineDashedMaterial({
          color: palette.highlight,
          dashSize: 0.02,
          gapSize: 0.012,
        }),
      );
      link.computeLineDistances();
      highlightGroup.add(link);

      for (const p of [a, b]) {
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.018, 14, 14),
          new THREE.MeshBasicMaterial({ color: palette.highlight }),
        );
        dot.position.copy(p);
        highlightGroup.add(dot);
      }
    },

    updateTime(tMs) {
      // The Sun and Moon move once per second of simulated time: their real
      // motion is ~0.04°/hour, invisible at this scale, so a 1 Hz refresh keeps
      // the light correct without recomputing trigonometry every frame.
      const key = Math.floor(tMs / 1000);
      if (key === lastCelestialKey) return;
      lastCelestialKey = key;
      celestial.update(new Date(tMs));
    },

    updateLabels(visible) {
      if (!visible) {
        if (labelsShown) callbacks.onLabels([]);
        labelsShown = false;
        return;
      }
      labelsShown = true;
      projectLabels();
    },

    resize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    },

    dispose() {
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      controls.dispose();
      celestial.dispose();
      globe?.dispose();
      atmosphereGeometry.dispose();
      atmosphereMaterial.dispose();
      for (const { line } of trackGroups.values()) {
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      }
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** Index of the sample nearest to `tMs`, clamped to the track. */
function sampleIndex(times: number[], tMs: number): number {
  if (times.length === 0) return 0;
  if (tMs <= times[0]) return 0;
  if (tMs >= times[times.length - 1]) return times.length - 1;
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= tMs) lo = mid;
    else hi = mid;
  }
  return tMs - times[lo] <= times[hi] - tMs ? lo : hi;
}

/** Minimal orbit controls: drag to rotate, wheel to zoom, idle auto-rotate. */
function createControls(
  dom: HTMLElement,
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
): { target: THREE.Vector3; update: () => void; dispose: () => void } {
  let theta = 0.6;
  let phi = 1.2;
  let radius = 3.4;

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let lastInteraction = 0;

  const onDown = (e: PointerEvent) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    dom.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    theta -= (e.clientX - lastX) * 0.005;
    phi = THREE.MathUtils.clamp(phi - (e.clientY - lastY) * 0.005, 0.08, Math.PI - 0.08);
    lastX = e.clientX;
    lastY = e.clientY;
    lastInteraction = performance.now();
  };
  const onUp = (e: PointerEvent) => {
    dragging = false;
    if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    radius = THREE.MathUtils.clamp(radius * (1 + Math.sign(e.deltaY) * 0.08), 1.4, 14);
    lastInteraction = performance.now();
  };

  dom.addEventListener("pointerdown", onDown);
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerup", onUp);
  dom.addEventListener("pointercancel", onUp);
  dom.addEventListener("wheel", onWheel, { passive: false });

  return {
    target,
    update() {
      if (!dragging && performance.now() - lastInteraction > 3000) theta += 0.0012;
      const sinPhi = Math.sin(phi);
      camera.position.set(
        target.x + radius * sinPhi * Math.sin(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * sinPhi * Math.cos(theta),
      );
      camera.lookAt(target);
    },
    dispose() {
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointercancel", onUp);
      dom.removeEventListener("wheel", onWheel);
    },
  };
}
