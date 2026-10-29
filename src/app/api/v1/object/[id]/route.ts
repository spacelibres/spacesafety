import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { objects } from "@/db/schema";
import { ApiError } from "@/lib/api/errors";
import { json, route } from "@/lib/api/http";

const MAX_HARD_BODY_RADIUS_M = 512;
const MAX_NAME_LENGTH = 256;

function serialize(o: typeof objects.$inferSelect) {
  return {
    id: o.id,
    operator_id: o.operatorId,
    object_name: o.objectName,
    norad_id: o.noradId ?? null,
    hard_body_radius: o.hardBodyRadius,
    maneuverability: o.maneuverability,
    alive: o.alive,
  };
}

/** GET /api/v1/object/:id */
export const GET = route(async ({ params }) => {
  const id = params.id;
  if (!id) throw ApiError.badRequest("missing object id");

  const { db } = getDb();
  const row = db.select().from(objects).where(eq(objects.id, id)).get();
  if (!row) throw ApiError.notFound(`object ${id} not found`);

  return json(200, serialize(row));
});

interface PatchBody {
  object_name?: unknown;
  norad_id?: unknown;
  hard_body_radius?: unknown;
  maneuverability?: unknown;
  alive?: unknown;
}

/**
 * PATCH /api/v1/object/:id — update our own object.
 *
 * The vendor's docs mention `PUT` in prose but the API reference documents
 * PATCH, so both verbs are handled by this handler (see `PUT` export below).
 */
export const PATCH = route(async ({ params, request, principal }) => {
  const id = params.id;
  if (!id) throw ApiError.badRequest("missing object id");

  const { db } = getDb();
  const row = db.select().from(objects).where(eq(objects.id, id)).get();
  if (!row) throw ApiError.notFound(`object ${id} not found`);
  if (row.operatorId !== principal.operatorId) {
    throw ApiError.forbidden("objects may only be modified by their owner");
  }

  const body = (JSON.parse((await request.text()) || "{}")) as PatchBody;
  const issues: { field: string; reason: string }[] = [];
  const patch: Record<string, string | number | boolean | null> = {};

  if (body.object_name !== undefined) {
    if (typeof body.object_name !== "string" || body.object_name.trim() === "") {
      issues.push({ field: "object_name", reason: "must be a non-empty string" });
    } else if (body.object_name.trim().length > MAX_NAME_LENGTH) {
      issues.push({ field: "object_name", reason: `must be at most ${MAX_NAME_LENGTH} characters` });
    } else {
      patch.objectName = body.object_name.trim();
    }
  }

  if (body.norad_id !== undefined) {
    if (body.norad_id === null) patch.noradId = null;
    else if (typeof body.norad_id !== "number" || !Number.isInteger(body.norad_id)) {
      issues.push({ field: "norad_id", reason: "must be an integer or null" });
    } else patch.noradId = body.norad_id;
  }

  if (body.hard_body_radius !== undefined) {
    const v = body.hard_body_radius;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_HARD_BODY_RADIUS_M) {
      issues.push({
        field: "hard_body_radius",
        reason: `must be a positive number <= ${MAX_HARD_BODY_RADIUS_M} m`,
      });
    } else patch.hardBodyRadius = v;
  }

  if (body.maneuverability !== undefined) {
    if (typeof body.maneuverability !== "boolean") {
      issues.push({ field: "maneuverability", reason: "must be a boolean" });
    } else patch.maneuverability = body.maneuverability;
  }

  if (body.alive !== undefined) {
    if (typeof body.alive !== "boolean") {
      issues.push({ field: "alive", reason: "must be a boolean" });
    } else patch.alive = body.alive;
  }

  if (issues.length > 0) {
    throw ApiError.badRequest("invalid object payload", { fields: issues });
  }
  if (Object.keys(patch).length === 0) {
    throw ApiError.badRequest("no updatable fields supplied");
  }

  db.update(objects)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(objects.id, id))
    .run();

  const updated = db.select().from(objects).where(eq(objects.id, id)).get()!;
  return json(200, serialize(updated));
});

/** PUT is accepted as a synonym, as the vendor's prose refers to PUT. */
export const PUT = PATCH;

export const dynamic = "force-dynamic";
