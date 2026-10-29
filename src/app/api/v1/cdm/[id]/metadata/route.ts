import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { cdms } from "@/db/schema";
import { ApiError } from "@/lib/api/errors";
import { json, route } from "@/lib/api/http";

/**
 * GET /api/v1/cdm/:id/metadata — lightweight CDM descriptor.
 *
 * `event_id` is null for CDMs generated from hypothetical trajectories, which by
 * design never join a conjunction event (`SPEC-BEHAVIOR.md` §3).
 */
export const GET = route(async ({ params, principal }) => {
  const id = params.id;
  if (!id) throw ApiError.badRequest("missing cdm id");

  const { db } = getDb();
  const row = db.select().from(cdms).where(eq(cdms.id, id)).get();
  if (!row) throw ApiError.notFound(`cdm ${id} not found`);

  if (row.isHypothetical && row.operator1Id !== principal.operatorId) {
    throw ApiError.notFound(`cdm ${id} not found`);
  }

  return json(200, {
    id: row.id,
    event_id: row.eventId,
    probability_of_collision: row.probabilityOfCollision,
    tca: row.tcaGpsNanos,
    trajectory1_id: row.trajectory1Id,
    trajectory2_id: row.trajectory2Id,
    created_at: row.createdAt,
  });
});

export const dynamic = "force-dynamic";
