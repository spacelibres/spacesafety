import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { trajectories } from "@/db/schema";
import { ApiError } from "@/lib/api/errors";
import { json, route } from "@/lib/api/http";

/**
 * GET /api/v1/trajectory/:id/metadata — screening status and timing.
 *
 * This is the endpoint operators poll to learn whether a fresh upload has been
 * screened; `screened_status` flips to `screened` typically within a minute.
 */
export const GET = route(async ({ params, principal }) => {
  const id = params.id;
  if (!id) throw ApiError.badRequest("missing trajectory id");

  const { db } = getDb();
  const row = db.select().from(trajectories).where(eq(trajectories.id, id)).get();
  if (!row) throw ApiError.notFound(`trajectory ${id} not found`);

  // Metadata follows the same visibility rules as the file itself.
  if (
    row.uploadType === "hypothetical" &&
    row.operatorId !== principal.operatorId
  ) {
    throw ApiError.notFound(`trajectory ${id} not found`);
  }

  return json(200, {
    id: row.id,
    object_id: row.objectId,
    operator_id: row.operatorId,
    upload_type: row.uploadType,
    state_source: row.stateSource,
    screened_status: row.screenedStatus,
    screened_at: row.screenedAt,
    uploaded_at: row.uploadedAt,
    created_at: row.createdAt,
    start_at: row.startAt,
    end_at: row.endAt,
    auto_relinquish_pc_threshold: row.autoRelinquishPcThreshold,
  });
});

export const dynamic = "force-dynamic";
