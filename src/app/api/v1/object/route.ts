import { and, eq, like } from "drizzle-orm";

import { getDb } from "@/db";
import { objects, operators } from "@/db/schema";
import { ApiError } from "@/lib/api/errors";
import { intParam, json, readJson, route } from "@/lib/api/http";

/** Hard-body radius cap documented by the vendor, in metres. */
const MAX_HARD_BODY_RADIUS_M = 512;
const MAX_NAME_LENGTH = 256;
/** Upper bound on `limit`, so one request cannot ask for an unbounded body. */
const MAX_LIST_LIMIT = 50_000;

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

/**
 * GET /api/v1/object — all objects, filtered.
 *
 * Filters: `operator_id`, `norad_id`, and `object_name` (case-insensitive but
 * must fully match, per the vendor's note).
 *
 * `limit` / `offset` are an addition to the vendor's signature, not a change: it
 * accepts no paging, which was tolerable when the only objects were a few
 * thousand Starlinks but is not now that the Spacebook catalogue is loaded — an
 * unfiltered call returns 40 000 rows as a single 7 MB JSON body. They default to
 * "everything", so a vendor-compatible client sees identical results.
 */
export const GET = route(async ({ request }) => {
  const url = new URL(request.url);
  const operatorId = url.searchParams.get("operator_id") ?? undefined;
  const noradId = intParam(url, "norad_id");
  const objectName = url.searchParams.get("object_name") ?? undefined;
  const limit = intParam(url, "limit", { min: 1, max: MAX_LIST_LIMIT });
  const offset = intParam(url, "offset", { min: 0 }) ?? 0;

  const { db } = getDb();
  const conditions = [];
  if (operatorId) conditions.push(eq(objects.operatorId, operatorId));
  if (noradId !== undefined) conditions.push(eq(objects.noradId, noradId));
  if (objectName) {
    // SQLite LIKE is case-insensitive for ASCII by default; escaping keeps the
    // whole-value match honest.
    conditions.push(like(objects.objectName, objectName));
  }

  // Ordered by name so paging is stable: without an ORDER BY, SQLite is free to
  // return a different physical order between the two calls a pager makes.
  const base = db
    .select()
    .from(objects)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(objects.objectName)
    .offset(offset);

  const rows = (limit === undefined ? base : base.limit(limit)).all();

  return json(200, rows.map(serialize));
});

interface CreateBody {
  object_name?: unknown;
  operator_id?: unknown;
  hard_body_radius?: unknown;
  maneuverability?: unknown;
  norad_id?: unknown;
  alive?: unknown;
}

/**
 * POST /api/v1/object — create an object owned by the caller's operator.
 *
 * The vendor lets an operator create objects for itself and enforces a
 * `max_objects` cap; both are enforced here.
 */
export const POST = route(async ({ request, principal }) => {
  const body = await readJson<CreateBody>(request);
  const issues: { field: string; reason: string }[] = [];

  const objectName = typeof body.object_name === "string" ? body.object_name.trim() : "";
  if (!objectName) {
    issues.push({ field: "object_name", reason: "required non-empty string" });
  } else if (objectName.length > MAX_NAME_LENGTH) {
    issues.push({
      field: "object_name",
      reason: `must be at most ${MAX_NAME_LENGTH} characters`,
    });
  }

  const hardBodyRadius = body.hard_body_radius;
  if (typeof hardBodyRadius !== "number" || !Number.isFinite(hardBodyRadius) || hardBodyRadius <= 0) {
    issues.push({ field: "hard_body_radius", reason: "required positive number (metres)" });
  } else if (hardBodyRadius > MAX_HARD_BODY_RADIUS_M) {
    issues.push({
      field: "hard_body_radius",
      reason: `must be <= ${MAX_HARD_BODY_RADIUS_M} m`,
    });
  }

  if (typeof body.maneuverability !== "boolean") {
    issues.push({ field: "maneuverability", reason: "required boolean" });
  }

  let noradId: number | null = null;
  if (body.norad_id !== undefined && body.norad_id !== null) {
    if (typeof body.norad_id !== "number" || !Number.isInteger(body.norad_id)) {
      issues.push({ field: "norad_id", reason: "must be an integer" });
    } else {
      noradId = body.norad_id;
    }
  }

  if (issues.length > 0) {
    throw ApiError.badRequest("invalid object payload", { fields: issues });
  }

  // Ownership: honour operator_id only when it is the caller's own.
  let ownerId = principal.operatorId;
  if (body.operator_id !== undefined) {
    if (typeof body.operator_id !== "string") {
      throw ApiError.badRequest("operator_id must be a string", { field: "operator_id" });
    }
    if (body.operator_id !== principal.operatorId) {
      throw ApiError.forbidden("objects may only be created for your own operator");
    }
    ownerId = body.operator_id;
  }

  const { db } = getDb();
  const owner = db.select().from(operators).where(eq(operators.id, ownerId)).get();
  if (!owner) throw ApiError.notFound(`operator ${ownerId} not found`);

  const owned = db.select().from(objects).where(eq(objects.operatorId, ownerId)).all();
  if (owned.length >= owner.maxObjects) {
    throw ApiError.forbidden(
      `operator has reached its object limit (${owner.maxObjects})`,
      { max_objects: owner.maxObjects },
    );
  }

  // Names must be unique within an operator: CDMs identify objects by name.
  if (owned.some((o) => o.objectName.toLowerCase() === objectName.toLowerCase())) {
    throw ApiError.badRequest("object_name already in use by this operator", {
      field: "object_name",
    });
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  db.insert(objects)
    .values({
      id,
      operatorId: ownerId,
      objectName,
      noradId,
      hardBodyRadius: hardBodyRadius as number,
      maneuverability: body.maneuverability as boolean,
      alive: body.alive === false ? false : true,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return json(201, id, undefined, { location: `/api/v1/object/${id}` });
});

export const dynamic = "force-dynamic";
