import { NextResponse } from "next/server";

import { getDb } from "@/db";
import { matchModel } from "@/lib/geo/model-match";

export const dynamic = "force-dynamic";

/**
 * Find a downloadable 3D model for a satellite name.
 *
 * The models come from NASA's 3D Resources repository, whose names describe the
 * object ("ISS", "1999 RQ36 asteroid", "70-meter Dish") and not a NORAD catalogue.
 * Matching is therefore by name, and it is deliberately conservative: a wrong model
 * on a satellite is worse than no model, so the matcher returns the best token
 * match or nothing.
 *
 * Returns `{ match: { name, url } }` served by `/api/models/...`, or `{ match: null }`
 * — the globe then says so instead of showing a generic shape.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const name = (url.searchParams.get("name") ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "name is required", parameter: "name" }, { status: 400 });
  }

  const { sqlite } = getDb();
  const has = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='model_asset'")
      .get() as { n: number }
  ).n;
  if (has === 0) {
    return NextResponse.json({
      match: null,
      note: "model catalogue not built; run `npm run models:sync`",
    });
  }

  const rows = sqlite
    .prepare("SELECT name, path, filename, local_path AS localPath FROM model_asset")
    .all() as Array<{ name: string; path: string; filename: string; localPath: string | null }>;

  const hit = matchModel(name, rows);
  if (!hit) return NextResponse.json({ match: null });

  // Only files present on disk can be served; a row without `local_path` would
  // 404 the moment Cesium asked for it.
  if (!hit.localPath) {
    return NextResponse.json({ match: null, note: "model not downloaded on this deployment" });
  }
  const relative = hit.localPath.replace(/^data\/models\//, "");
  return NextResponse.json({
    match: {
      name: hit.name,
      url: `/api/models/${relative.split("/").map(encodeURIComponent).join("/")}`,
    },
  });
}
