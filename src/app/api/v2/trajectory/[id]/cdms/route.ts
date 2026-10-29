import { and, eq, gt, or, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { cdms, trajectories } from "@/db/schema";
import { ApiError } from "@/lib/api/errors";
import { json, route } from "@/lib/api/http";
import {
  hashFilters,
  issueToken,
  MAX_PAGE_SIZE,
  resolveCursor,
} from "@/lib/api/pagination";

/**
 * GET /api/v2/trajectory/:id/cdms — streaming CDMs for one trajectory.
 *
 * Ordered by CDM creation time; since CDMs are immutable each appears once.
 * Covers CDMs where this trajectory is either primary or secondary, against both
 * `operator_ephemeris` and `spacex_optical` counterparts.
 */
export const GET = route(async ({ params, request, principal }) => {
  const id = params.id;
  if (!id) throw ApiError.badRequest("missing trajectory id");

  const { db } = getDb();
  const traj = db.select().from(trajectories).where(eq(trajectories.id, id)).get();
  if (!traj) throw ApiError.notFound(`trajectory ${id} not found`);

  if (traj.uploadType === "hypothetical" && traj.operatorId !== principal.operatorId) {
    throw ApiError.notFound(`trajectory ${id} not found`);
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? undefined;
  const filterHash = hashFilters({ trajectory_id: id });
  const cursor = resolveCursor("trajectory_cdms", token, filterHash);

  const rows = db
    .select()
    .from(cdms)
    .where(
      and(
        gt(cdms.seq, cursor),
        or(eq(cdms.trajectory1Id, id), eq(cdms.trajectory2Id, id))!,
        sql`(${cdms.isHypothetical} = 0 OR ${cdms.operator1Id} = ${principal.operatorId})`,
      ),
    )
    .orderBy(cdms.seq)
    .limit(MAX_PAGE_SIZE)
    .all();

  const nextCursor = rows.length ? rows[rows.length - 1].seq : cursor;

  return json(200, {
    result: rows.map((c) => ({
      id: c.id,
      event_id: c.eventId,
      creation_time: c.createdAt,
      is_active: c.isActive,

      object1_id: c.object1Id,
      object1_name: c.object1Name,
      object1_maneuverable: c.object1Maneuverable ?? false,
      operator1_id: c.operator1Id,
      operator1_name: c.operator1Name,

      object2_id: c.object2Id,
      object2_name: c.object2Name,
      object2_maneuverable: c.object2Maneuverable ?? false,
      operator2_id: c.operator2Id,
      operator2_name: c.operator2Name,

      probability_of_collision: c.probabilityOfCollision,
      tca_gps_nanos: c.tcaGpsNanos,

      trajectory1_id: c.trajectory1Id,
      trajectory1_source: c.trajectory1Source,
      trajectory1_created_at: c.trajectory1CreatedAt,
      trajectory2_id: c.trajectory2Id,
      trajectory2_source: c.trajectory2Source,
      trajectory2_created_at: c.trajectory2CreatedAt,
    })),
    token: issueToken("trajectory_cdms", nextCursor, filterHash),
  });
});

export const dynamic = "force-dynamic";
