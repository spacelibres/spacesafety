import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { operators } from "@/db/schema";
import { ApiError } from "@/lib/api/errors";
import { json, route } from "@/lib/api/http";

/** GET /api/v1/operator/:id — one operator. */
export const GET = route(async ({ params }) => {
  const id = params.id;
  if (!id) throw ApiError.badRequest("missing operator id");

  const { db } = getDb();
  const row = db.select().from(operators).where(eq(operators.id, id)).get();
  if (!row) throw ApiError.notFound(`operator ${id} not found`);

  return json(200, {
    id: row.id,
    name: row.name,
    email: row.email ?? "",
    phone: row.phone ?? "",
    max_objects: row.maxObjects,
  });
});

interface UpdateBody {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  max_objects?: unknown;
}

/**
 * PATCH /api/v1/operator/:id — update contact details.
 *
 * Operators may edit their own record; `max_objects` is administrator-only and
 * refused without the bootstrap flag, matching the vendor's description.
 */
export const PATCH = route(async ({ params, request, principal }) => {
  const id = params.id;
  if (!id) throw ApiError.badRequest("missing operator id");

  const { db } = getDb();
  const row = db.select().from(operators).where(eq(operators.id, id)).get();
  if (!row) throw ApiError.notFound(`operator ${id} not found`);

  const isSelf = principal.operatorId === id;
  const isAdmin = process.env.SPACE_SAFETY_ADMIN === "1";
  if (!isSelf && !isAdmin) {
    throw ApiError.forbidden("operators may only modify their own record");
  }

  const body = JSON.parse((await request.text()) || "{}") as UpdateBody;
  const patch: Record<string, string | number | null> = {};

  if (typeof body.name === "string" && body.name.trim() !== "") {
    patch.name = body.name.trim();
  }
  if (typeof body.email === "string") patch.email = body.email;
  if (typeof body.phone === "string") patch.phone = body.phone;
  if (body.max_objects !== undefined) {
    if (!isAdmin) {
      throw ApiError.forbidden("max_objects may only be changed by an administrator");
    }
    if (typeof body.max_objects !== "number" || !Number.isInteger(body.max_objects)) {
      throw ApiError.badRequest("max_objects must be an integer", {
        field: "max_objects",
      });
    }
    patch.maxObjects = body.max_objects;
  }

  if (Object.keys(patch).length === 0) {
    throw ApiError.badRequest("no updatable fields supplied");
  }

  db.update(operators)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(operators.id, id))
    .run();

  const updated = db.select().from(operators).where(eq(operators.id, id)).get()!;
  return json(200, {
    id: updated.id,
    name: updated.name,
    email: updated.email ?? "",
    phone: updated.phone ?? "",
    max_objects: updated.maxObjects,
  });
});

export const dynamic = "force-dynamic";
