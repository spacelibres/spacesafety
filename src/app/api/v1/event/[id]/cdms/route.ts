import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { cdms, events } from "@/db/schema";
import { ApiError } from "@/lib/api/errors";
import { json, route } from "@/lib/api/http";

/** Documented cap on this endpoint's result size. */
const MAX_RESULTS = 1000;

/**
 * GET /api/v1/event/:id/cdms — CDM metadata for one conjunction event.
 *
 * Returns descriptors only; full files come from `/api/v1/cdm/:id`. Capped at
 * 1000 rows, matching the vendor.
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
    .limit(MAX_RESULTS)
    .all();

  return json(
    200,
    rows.map((c) => ({
      id: c.id,
      event_id: c.eventId,
      created_at: c.createdAt,
      probability_of_collision: c.probabilityOfCollision,
      tca: c.tcaGpsNanos,
      trajectory1_id: c.trajectory1Id,
      trajectory2_id: c.trajectory2Id,
      is_active: c.isActive,
    })),
  );
});

export const dynamic = "force-dynamic";
