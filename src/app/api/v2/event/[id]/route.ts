import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { cdms, events } from "@/db/schema";
import { ApiError } from "@/lib/api/errors";
import { json, route } from "@/lib/api/http";

/**
 * GET /api/v2/event/:id — a conjunction event with its CDM history.
 *
 * An event can hold *several* active CDMs at once: one per state-source pair
 * (operator-vs-operator and operator-vs-optical), per `SPEC-BEHAVIOR.md` §4.6.
 */
export const GET = route(async ({ params }) => {
  const id = params.id;
  if (!id) throw ApiError.badRequest("missing event id");

  const { db } = getDb();
  const ev = db.select().from(events).where(eq(events.id, id)).get();
  if (!ev) throw ApiError.notFound(`event ${id} not found`);

  const rows = db
    .select()
    .from(cdms)
    .where(eq(cdms.eventId, id))
    .orderBy(cdms.seq)
    .all();

  return json(200, {
    id: ev.id,

    object1_id: ev.object1Id,
    object1_name: ev.object1Name,
    object1_maneuverable: ev.object1Maneuverable,
    operator1_id: ev.operator1Id,
    operator1_name: ev.operator1Name,

    object2_id: ev.object2Id,
    object2_name: ev.object2Name,
    object2_maneuverable: ev.object2Maneuverable,
    operator2_id: ev.operator2Id,
    operator2_name: ev.operator2Name,

    claim_status_operator1: ev.claimStatusOperator1,
    claim_status_operator2: ev.claimStatusOperator2,
    last_status_update_time_operator1: ev.lastStatusUpdateOperator1,
    last_status_update_time_operator2: ev.lastStatusUpdateOperator2,

    first_cdm_tca_gps_nanos: ev.firstCdmTcaGpsNanos,
    creation_time: ev.creationTime,
    updated_time: ev.updatedTime,

    cdms: rows.map((c) => ({
      id: c.id,
      created_at: c.createdAt,
      is_active: c.isActive,
      probability_of_collision: c.probabilityOfCollision,
      tca_gps_nanos: c.tcaGpsNanos,
      trajectory1_id: c.trajectory1Id,
      trajectory1_source: c.trajectory1Source,
      trajectory1_created_at: c.trajectory1CreatedAt,
      trajectory2_id: c.trajectory2Id,
      trajectory2_source: c.trajectory2Source,
      trajectory2_created_at: c.trajectory2CreatedAt,
      file: c.fileJson,
    })),
  });
});

export const dynamic = "force-dynamic";
