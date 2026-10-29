import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { trajectories } from "@/db/schema";
import { ApiError } from "@/lib/api/errors";
import { route } from "@/lib/api/http";
import { getTrajectoryFile } from "@/lib/queries";

/**
 * GET /api/v1/trajectory/:id — the raw trajectory file.
 *
 * Visibility rules (`SPEC-BEHAVIOR.md` §5): every `operator_ephemeris`
 * trajectory is readable, but `spacex_optical` contents are never exposed — only
 * the CDMs they produce. Hypothetical trajectories are private to the submitter.
 */
export const GET = route(async ({ params, principal }) => {
  const id = params.id;
  if (!id) throw ApiError.badRequest("missing trajectory id");

  const { db } = getDb();
  const row = db.select().from(trajectories).where(eq(trajectories.id, id)).get();
  if (!row) throw ApiError.notFound(`trajectory ${id} not found`);

  if (row.stateSource === "spacex_optical") {
    throw ApiError.forbidden(
      "spacex_optical trajectory contents are not available; query the CDMs instead",
    );
  }
  if (row.uploadType === "hypothetical" && row.operatorId !== principal.operatorId) {
    throw ApiError.forbidden("hypothetical trajectories are only visible to their submitter");
  }

  const file = getTrajectoryFile(row.id);
  if (!file) throw ApiError.notFound("trajectory file is missing");

  return new Response(file.text, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `inline; filename="${row.id}.${row.fileFormat}"`,
      "x-trajectory-format": row.fileFormat,
      "x-screened-status": row.screenedStatus,
    },
  });
});

export const dynamic = "force-dynamic";
