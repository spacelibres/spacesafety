import { asc } from "drizzle-orm";

import { getDb } from "@/db";
import { operators } from "@/db/schema";
import { ApiError } from "@/lib/api/errors";
import { json, readJson, route } from "@/lib/api/http";

/**
 * GET /api/v1/operator — every operator and their contact details.
 *
 * Peers need this to find who to call during conjunction coordination, so it is
 * readable by any authenticated operator (`SPEC-BEHAVIOR.md` §1).
 */
export const GET = route(async () => {
  const { db } = getDb();
  const rows = db.select().from(operators).orderBy(asc(operators.name)).all();

  return json(
    200,
    rows.map((o) => ({
      id: o.id,
      name: o.name,
      email: o.email ?? "",
      phone: o.phone ?? "",
      max_objects: o.maxObjects,
    })),
  );
});

interface CreateOperatorBody {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  max_objects?: unknown;
}

/**
 * POST /api/v1/operator — create an operator.
 *
 * The vendor restricts this to system administrators; there is no admin role in
 * the credential model yet, so we gate it on an explicit bootstrap flag.
 */
export const POST = route(async ({ request }) => {
  if (process.env.SPACE_SAFETY_ADMIN !== "1") {
    throw ApiError.forbidden("only system administrators may create operators");
  }

  const body = await readJson<CreateOperatorBody>(request);
  const issues: { field: string; reason: string }[] = [];

  if (typeof body.name !== "string" || body.name.trim() === "") {
    issues.push({ field: "name", reason: "required non-empty string" });
  }
  if (typeof body.max_objects !== "number" || !Number.isInteger(body.max_objects)) {
    issues.push({ field: "max_objects", reason: "required integer" });
  }
  if (issues.length > 0) {
    throw ApiError.badRequest("invalid operator payload", { fields: issues });
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const { db } = getDb();

  db.insert(operators)
    .values({
      id,
      name: (body.name as string).trim(),
      email: typeof body.email === "string" ? body.email : null,
      phone: typeof body.phone === "string" ? body.phone : null,
      maxObjects: body.max_objects as number,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return json(201, id, undefined, { location: `/api/v1/operator/${id}` });
});

export const dynamic = "force-dynamic";
