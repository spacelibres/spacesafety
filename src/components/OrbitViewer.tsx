"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

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
  /** Simulation clock, ms. Drives the moving satellite markers. */
  sceneTimeMs: number;
  /** Optional close-approach pair to highlight. */
  highlight?: { a: [number, number, number]; b: [number, number, number] } | null;
  height?: number;
  /** Camera distance in globe radii. */
  zoom?: number;
}

const GLOBE_RADIUS = 1;
const KM_PER_GLOBE = 6378.137;

/**
 * Earth-centred inertial viewer.
 *
 * Deliberately texture-free: a shaded sphere plus a graticule conveys orientation
 * without an asset pipeline, which keeps the app deployable before any CDN or
 * imagery licence is in place.
 */
export default function OrbitViewer({
  tracks,
  sceneTimeMs,
  highlight,
  height = 460,
}: OrbitViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<ViewerState | null>(null);
  const dataRef = useRef({ tracks, sceneTimeMs, highlight });
  dataRef.current = { tracks, sceneTimeMs, highlight };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const state = createViewer(mount);
    stateRef.current = state;

    let frame = 0;
    const tick = () => {
      const { tracks: t, sceneTimeMs: now, highlight: h } = dataRef.current;
      state.syncTracks(t);
      state.updateSatellites(t, now);
      state.updateHighlight(h ?? null);
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
  }, []);

  return (
    <div className="viewer" ref={mountRef} style={{ height }} aria-label="卫星轨道三维视图" />
  );
}

// ---------------------------------------------------------------------------

interface ViewerState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: { target: THREE.Vector3; update: () => void; dispose: () => void };
  syncTracks: (tracks: OrbitTrack[]) => void;
  updateSatellites: (tracks: OrbitTrack[], tMs: number) => void;
  updateHighlight: (h: { a: [number, number, number]; b: [number, number, number] } | null) => void;
  resize: (w: number, h: number) => void;
  dispose: () => void;
}

function createViewer(mount: HTMLDivElement): ViewerState {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 4000);
  camera.position.set(2.9, 1.9, 3.1);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  mount.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0x5a7599, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(6, 3, 5);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x3f7fd0, 0.8);
  rim.position.set(-5, -2, -4);
  scene.add(rim);

  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(GLOBE_RADIUS, 96, 96),
    new THREE.MeshStandardMaterial({
      color: 0x16324d,
      roughness: 0.94,
      metalness: 0.05,
      emissive: 0x08131f,
      emissiveIntensity: 0.5,
    }),
  );
  scene.add(globe);

  scene.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_RADIUS * 1.04, 64, 64),
      new THREE.MeshBasicMaterial({
        color: 0x3f8fe0,
        transparent: true,
        opacity: 0.14,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );

  scene.add(buildGraticule());
  scene.add(
    new THREE.Line(
      circlePoints(GLOBE_RADIUS * 1.001, 128),
      new THREE.LineBasicMaterial({ color: 0x2f5f96, transparent: true, opacity: 0.5 }),
    ),
  );
  scene.add(buildStars());

  const trackGroup = new THREE.Group();
  const satGroup = new THREE.Group();
  const hiGroup = new THREE.Group();
  scene.add(trackGroup, satGroup, hiGroup);

  const controls = createControls(camera, renderer.domElement);

  const trackObjects = new Map<string, THREE.Line>();
  const markers = new Map<string, THREE.Mesh>();
  const markerGeom = new THREE.SphereGeometry(0.011, 10, 10);

  function syncTracks(tracks: OrbitTrack[]) {
    const seen = new Set<string>();
    for (const track of tracks) {
      seen.add(track.objectId);
      const arr = new Float32Array(track.points.length * 3);
      track.points.forEach((p, i) => {
        arr[i * 3] = (p[0] / KM_PER_GLOBE) * GLOBE_RADIUS;
        arr[i * 3 + 1] = (p[1] / KM_PER_GLOBE) * GLOBE_RADIUS;
        arr[i * 3 + 2] = (p[2] / KM_PER_GLOBE) * GLOBE_RADIUS;
      });

      let line = trackObjects.get(track.objectId);
      if (!line) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));
        line = new THREE.Line(
          geometry,
          new THREE.LineBasicMaterial({
            color: new THREE.Color(track.color),
            transparent: true,
            opacity: track.emphasis ? 0.95 : 0.4,
          }),
        );
        trackGroup.add(line);
        trackObjects.set(track.objectId, line);
      } else {
        const geometry = line.geometry as THREE.BufferGeometry;
        geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));
        geometry.computeBoundingSphere();
        const material = line.material as THREE.LineBasicMaterial;
        material.color.set(track.color);
        material.opacity = track.emphasis ? 0.95 : 0.4;
      }
    }
    for (const [id, line] of trackObjects) {
      if (seen.has(id)) continue;
      trackGroup.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
      trackObjects.delete(id);
    }
  }

  function updateSatellites(tracks: OrbitTrack[], tMs: number) {
    const seen = new Set<string>();
    for (const track of tracks) {
      if (track.showSatellite === false) continue;
      const p = positionAt(track, tMs);
      if (!p) continue;
      seen.add(track.objectId);

      let marker = markers.get(track.objectId);
      if (!marker) {
        marker = new THREE.Mesh(
          markerGeom,
          new THREE.MeshBasicMaterial({ color: new THREE.Color(track.color) }),
        );
        satGroup.add(marker);
        markers.set(track.objectId, marker);
      }
      marker.position.set(
        (p[0] / KM_PER_GLOBE) * GLOBE_RADIUS,
        (p[1] / KM_PER_GLOBE) * GLOBE_RADIUS,
        (p[2] / KM_PER_GLOBE) * GLOBE_RADIUS,
      );
      (marker.material as THREE.MeshBasicMaterial).color.set(track.color);
      marker.scale.setScalar(track.emphasis ? 1.6 : 1);
    }
    for (const [id, marker] of markers) {
      if (seen.has(id)) continue;
      satGroup.remove(marker);
      (marker.material as THREE.Material).dispose();
      markers.delete(id);
    }
  }

  let highlightKey = "";
  function updateHighlight(h: { a: [number, number, number]; b: [number, number, number] } | null) {
    const key = h ? `${h.a.join()}|${h.b.join()}` : "";
    if (key === highlightKey) return;
    highlightKey = key;

    for (const child of [...hiGroup.children]) {
      hiGroup.remove(child);
      disposeObject(child);
    }
    if (!h) return;

    const toScene = (p: [number, number, number]) =>
      new THREE.Vector3(
        (p[0] / KM_PER_GLOBE) * GLOBE_RADIUS,
        (p[1] / KM_PER_GLOBE) * GLOBE_RADIUS,
        (p[2] / KM_PER_GLOBE) * GLOBE_RADIUS,
      );

    const a = toScene(h.a);
    const b = toScene(h.b);
    const geom = new THREE.BufferGeometry().setFromPoints([a, b]);
    const link = new THREE.Line(
      geom,
      new THREE.LineDashedMaterial({ color: 0xff4d5e, dashSize: 0.02, gapSize: 0.012 }),
    );
    link.computeLineDistances();
    hiGroup.add(link);

    for (const p of [a, b]) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.018, 14, 14),
        new THREE.MeshBasicMaterial({ color: 0xff4d5e }),
      );
      dot.position.copy(p);
      hiGroup.add(dot);
    }
  }

  function resize(w: number, h: number) {
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function dispose() {
    for (const line of trackObjects.values()) disposeObject(line);
    for (const m of markers.values()) disposeObject(m);
    for (const child of [...hiGroup.children]) disposeObject(child);
    markerGeom.dispose();
    controls.dispose();
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
        disposeObject(o);
      }
    });
    renderer.dispose();
    if (renderer.domElement.parentElement === mount) {
      mount.removeChild(renderer.domElement);
    }
  }

  return {
    renderer,
    scene,
    camera,
    controls,
    syncTracks,
    updateSatellites,
    updateHighlight,
    resize,
    dispose,
  };
}

function disposeObject(o: THREE.Object3D) {
  const mesh = o as THREE.Mesh;
  mesh.geometry?.dispose?.();
  const mat = mesh.material;
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
  else mat?.dispose?.();
}

/** Interpolate a track position at `tMs`. */
export function positionAt(track: OrbitTrack, tMs: number): [number, number, number] | null {
  const { tMs: times, points } = track;
  if (times.length === 0) return null;
  if (tMs <= times[0]) return points[0];
  if (tMs >= times[times.length - 1]) return points[points.length - 1];

  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= tMs) lo = mid;
    else hi = mid;
  }
  const f = (tMs - times[lo]) / (times[hi] - times[lo] || 1);
  const a = points[lo];
  const b = points[hi];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

function buildGraticule(): THREE.LineSegments {
  const segments = 24;
  const pts: THREE.Vector3[] = [];
  const r = GLOBE_RADIUS * 1.0006;

  for (let i = 1; i < 12; i += 1) {
    const lat = -Math.PI / 2 + (Math.PI * i) / 12;
    const y = Math.sin(lat) * r;
    const ring = Math.cos(lat) * r;
    for (let s = 0; s < segments * 2; s += 1) {
      const t0 = (Math.PI * s) / segments;
      const t1 = (Math.PI * (s + 1)) / segments;
      pts.push(
        new THREE.Vector3(Math.cos(t0) * ring, y, Math.sin(t0) * ring),
        new THREE.Vector3(Math.cos(t1) * ring, y, Math.sin(t1) * ring),
      );
    }
  }

  for (let m = 0; m < 12; m += 1) {
    const lon = (Math.PI * 2 * m) / 12;
    for (let s = 0; s < segments; s += 1) {
      const a0 = (Math.PI * s) / segments - Math.PI / 2;
      const a1 = (Math.PI * (s + 1)) / segments - Math.PI / 2;
      pts.push(
        new THREE.Vector3(
          Math.cos(a0) * Math.cos(lon) * r,
          Math.sin(a0) * r,
          Math.cos(a0) * Math.sin(lon) * r,
        ),
        new THREE.Vector3(
          Math.cos(a1) * Math.cos(lon) * r,
          Math.sin(a1) * r,
          Math.cos(a1) * Math.sin(lon) * r,
        ),
      );
    }
  }

  return new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x24435f, transparent: true, opacity: 0.55 }),
  );
}

function circlePoints(radius: number, segments: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const a = (Math.PI * 2 * i) / segments;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

function buildStars(): THREE.Points {
  const count = 1500;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const r = 40 + Math.random() * 60;
    const s = Math.sqrt(1 - u * u);
    positions[i * 3] = Math.cos(theta) * s * r;
    positions[i * 3 + 1] = u * r;
    positions[i * 3 + 2] = Math.sin(theta) * s * r;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: 0x9fc0e8,
      size: 0.12,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.7,
    }),
  );
}

function createControls(
  camera: THREE.PerspectiveCamera,
  dom: HTMLElement,
): { target: THREE.Vector3; update: () => void; dispose: () => void } {
  const target = new THREE.Vector3(0, 0, 0);
  let radius = camera.position.length();
  let theta = Math.atan2(camera.position.x, camera.position.z);
  let phi = Math.acos(THREE.MathUtils.clamp(camera.position.y / radius, -1, 1));

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
      // Slow auto-rotation when idle, so the globe reads as 3D at a glance.
      if (!dragging && performance.now() - lastInteraction > 3000) {
        theta += 0.0012;
      }
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
