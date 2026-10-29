import { getDb } from "@/db";
import { catalog, objects, operators, trajectoryFiles, trajectories } from "@/db/schema";
import { eq } from "drizzle-orm";
import { json } from "@/lib/api/http";
import { parseOem } from "@/lib/orbit/oem";
import { parseOcm, mergeOcmCovariance } from "@/lib/orbit/ocm";
import { itrfStateToJ2000 } from "@/lib/orbit/frames-rigorous";

export const dynamic = "force-dynamic";

/** Samples per orbit sent to the browser. Keeps payloads around 20 KB. */
const SAMPLES = 180;

/**
 * GET /api/render/tracks — orbital polylines for the 3D viewer.
 *
 * This is a UI-support endpoint, not part of the vendor's API surface. It parses
 * each catalog trajectory, converts to inertial coordinates, and downsamples so
 * the browser receives a small, frame-independent polyline.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 60) || 60);

  const { db } = getDb();

  // Newest catalog entries, joined to the trajectory file.
  const rows = db
    .select({
      objectId: catalog.objectId,
      objectName: objects.objectName,
      operatorName: operators.name,
      trajectoryId: catalog.trajectoryId,
      fileText: trajectoryFiles.fileText,
      format: trajectories.fileFormat,
    })
    .from(catalog)
    .leftJoin(objects, eq(objects.id, catalog.objectId))
    .leftJoin(operators, eq(operators.id, objects.operatorId))
    .leftJoin(trajectories, eq(trajectories.id, catalog.trajectoryId))
    .leftJoin(trajectoryFiles, eq(trajectoryFiles.trajectoryId, catalog.trajectoryId))
    .limit(limit)
    .all();

  const tracks = [];

  for (const row of rows) {
    if (!row.fileText) continue;
    const sampled = sampleTrajectory(row.fileText ?? "", row.format ?? "");
    if (!sampled) continue;

    tracks.push({
      objectId: row.objectId,
      objectName: row.objectName ?? row.objectId,
      operatorName: row.operatorName ?? "UNKNOWN",
      points: sampled.points,
      tMs: sampled.tMs,
    });
  }

  // Fall back to any trajectory we hold when the catalog is empty, so the viewer
  // is not blank before the first screening cycle finishes.
  if (tracks.length === 0) {
    const fallback = db
      .select({
        objectId: trajectories.objectId,
        objectName: objects.objectName,
        operatorName: operators.name,
        fileText: trajectoryFiles.fileText,
        format: trajectories.fileFormat,
      })
      .from(trajectories)
      .innerJoin(trajectoryFiles, eq(trajectoryFiles.trajectoryId, trajectories.id))
      .leftJoin(objects, eq(objects.id, trajectories.objectId))
      .leftJoin(operators, eq(operators.id, trajectories.operatorId))
      .limit(limit)
      .all();

    const seen = new Set<string>();
    for (const row of fallback) {
      if (seen.has(row.objectId)) continue;
      seen.add(row.objectId);
      const sampled = sampleTrajectory(row.fileText ?? "", row.format ?? "");
      if (!sampled) continue;
      tracks.push({
        objectId: row.objectId,
        objectName: row.objectName ?? row.objectId,
        operatorName: row.operatorName ?? "UNKNOWN",
        points: sampled.points,
        tMs: sampled.tMs,
      });
    }
  }

  return json(200, { tracks });
}

function sampleTrajectory(
  text: string,
  format: string,
): { points: [number, number, number][]; tMs: number[] } | null {
  try {
    let states: { ms: number; position: [number, number, number] }[];

    if (format === "ocm") {
      const ocm = parseOcm(text);
      const earthFixed = /ITRF/i.test(ocm.trajectoryFrame);
      states = mergeOcmCovariance(ocm).map((s) => ({
        ms: s.ms,
        position: earthFixed
          ? itrfStateToJ2000(s.position, s.velocity, s.ms).position
          : s.position,
      }));
    } else if (format === "oem") {
      const oem = parseOem(text);
      const earthFixed = /ITRF/i.test(oem.refFrame);
      states = oem.states.map((s) => ({
        ms: s.tMs,
        position: earthFixed
          ? itrfStateToJ2000(s.position, s.velocity, s.tMs).position
          : s.position,
      }));
    } else {
      // Modified ITC: EME2000, one state per 4-line block.
      states = parseItcForRender(text);
    }

    if (states.length < 2) return null;

    const step = Math.max(1, Math.floor(states.length / SAMPLES));
    const points: [number, number, number][] = [];
    const tMs: number[] = [];
    for (let i = 0; i < states.length; i += step) {
      points.push(states[i].position);
      tMs.push(states[i].ms);
    }
    // Always include the final state so the line closes visually.
    if (tMs[tMs.length - 1] !== states[states.length - 1].ms) {
      points.push(states[states.length - 1].position);
      tMs.push(states[states.length - 1].ms);
    }

    return { points, tMs };
  } catch {
    return null;
  }
}

function parseItcForRender(text: string): { ms: number; position: [number, number, number] }[] {
  const lines = text.split(/\r?\n/);
  const out: { ms: number; position: [number, number, number] }[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!/^\d{13}(\.\d+)?\s/.test(t)) continue;
    const parts = t.split(/\s+/);
    const stamp = parts[0];
    const m = /^(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/.exec(stamp);
    if (!m) continue;
    const ms =
      Date.UTC(Number(m[1]), 0, 1) +
      ((Number(m[2]) - 1) * 86_400 + Number(m[3]) * 3_600 + Number(m[4]) * 60 + Number(m[5])) * 1000;
    out.push({
      ms,
      position: [Number(parts[1]), Number(parts[2]), Number(parts[3])],
    });
  }
  return out;
}
