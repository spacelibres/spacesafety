import { and, eq, gt, or, sql, type SQL } from "drizzle-orm";

import { getDb } from "@/db";
import { cdms } from "@/db/schema";
import { ApiError } from "@/lib/api/errors";
import { boolParam, floatParam, intParam, json, route } from "@/lib/api/http";
import {
  hashFilters,
  issueToken,
  MAX_PAGE_SIZE,
  resolveCursor,
} from "@/lib/api/pagination";

export const dynamic = "force-dynamic";

function serialize(c: typeof cdms.$inferSelect, includeFile: boolean) {
  const base = {
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
  };

  return includeFile ? { ...base, file: c.fileJson } : base;
}

/**
 * GET /api/v2/cdm — streaming feed of CDMs.
 *
 * Requires at least one of `operator1_id`, `trajectory_id`, `object1_id`, per the
 * vendor's rule. Hypothetical CDMs never appear in this stream, and a token can
 * be reused indefinitely to pick up new rows — that is the documented polling
 * pattern (`docs/starlink-space-safety/api-patterns.md`).
 */
export const GET = route(async ({ request, principal }) => {
  const url = new URL(request.url);

  const filters = {
    operator1_id: url.searchParams.get("operator1_id") ?? undefined,
    operator2_id: url.searchParams.get("operator2_id") ?? undefined,
    object1_id: url.searchParams.get("object1_id") ?? undefined,
    object2_id: url.searchParams.get("object2_id") ?? undefined,
    trajectory_id: url.searchParams.get("trajectory_id") ?? undefined,
    min_creation_time: url.searchParams.get("min_creation_time") ?? undefined,
    pc_min: floatParam(url, "pc_min", { min: 0, max: 1 }),
    tca_min: intParam(url, "tca_min"),
    tca_max: intParam(url, "tca_max"),
    include_cdm_file: boolParam(url, "include_cdm_file"),
    only_active: boolParam(url, "only_active"),
    format: url.searchParams.get("format") ?? undefined,
    trajectory1_source: url.searchParams.get("trajectory1_source") ?? undefined,
    trajectory2_source: url.searchParams.get("trajectory2_source") ?? undefined,
    exclude_self_on_self: boolParam(url, "exclude_self_on_self"),
  };
  const token = url.searchParams.get("token") ?? undefined;

  if (!filters.operator1_id && !filters.trajectory_id && !filters.object1_id) {
    throw ApiError.badRequest(
      "at least one of operator1_id, trajectory_id, or object1_id is required",
    );
  }
  if (filters.operator2_id && !filters.operator1_id) {
    throw ApiError.badRequest("operator2_id requires operator1_id");
  }
  if (filters.object2_id && !filters.object1_id) {
    throw ApiError.badRequest("object2_id requires object1_id");
  }
  if (filters.trajectory2_source && !filters.trajectory1_source) {
    throw ApiError.badRequest("trajectory2_source requires trajectory1_source");
  }
  if (filters.format && !["json", "kvn"].includes(filters.format)) {
    throw ApiError.badRequest("format must be json or kvn", { parameter: "format" });
  }

  const filterHash = hashFilters(filters);
  const cursor = resolveCursor("cdms", token, filterHash);

  const { db } = getDb();
  const conditions: SQL[] = [gt(cdms.seq, cursor)];

  // Hypothetical CDMs are private to the operator that generated them.
  conditions.push(
    sql`(${cdms.isHypothetical} = 0 OR ${cdms.operator1Id} = ${principal.operatorId})`,
  );

  if (filters.operator1_id) {
    if (filters.operator2_id) {
      // Order does not matter between the two operators.
      conditions.push(
        or(
          and(
            eq(cdms.operator1Id, filters.operator1_id),
            eq(cdms.operator2Id, filters.operator2_id),
          ),
          and(
            eq(cdms.operator1Id, filters.operator2_id),
            eq(cdms.operator2Id, filters.operator1_id),
          ),
        )!,
      );
    } else if (filters.exclude_self_on_self) {
      conditions.push(
        or(
          and(
            eq(cdms.operator1Id, filters.operator1_id),
            sql`${cdms.operator2Id} <> ${filters.operator1_id}`,
          ),
          and(
            eq(cdms.operator2Id, filters.operator1_id),
            sql`${cdms.operator1Id} <> ${filters.operator1_id}`,
          ),
        )!,
      );
    } else {
      conditions.push(
        or(
          eq(cdms.operator1Id, filters.operator1_id),
          eq(cdms.operator2Id, filters.operator1_id),
        )!,
      );
    }
  }

  if (filters.object1_id) {
    if (filters.object2_id) {
      conditions.push(
        or(
          and(eq(cdms.object1Id, filters.object1_id), eq(cdms.object2Id, filters.object2_id)),
          and(eq(cdms.object1Id, filters.object2_id), eq(cdms.object2Id, filters.object1_id)),
        )!,
      );
    } else {
      conditions.push(
        or(eq(cdms.object1Id, filters.object1_id), eq(cdms.object2Id, filters.object1_id))!,
      );
    }
  }

  if (filters.trajectory_id) {
    conditions.push(
      or(
        eq(cdms.trajectory1Id, filters.trajectory_id),
        eq(cdms.trajectory2Id, filters.trajectory_id),
      )!,
    );
  }
  if (filters.min_creation_time) {
    conditions.push(sql`${cdms.createdAt} >= ${filters.min_creation_time}`);
  }
  if (filters.pc_min !== undefined) {
    conditions.push(sql`${cdms.probabilityOfCollision} >= ${filters.pc_min}`);
  }
  if (filters.tca_min !== undefined) {
    // GPS nanos are stored as TEXT; compare numerically with CAST.
    conditions.push(sql`CAST(${cdms.tcaGpsNanos} AS INTEGER) >= ${filters.tca_min}`);
  }
  if (filters.tca_max !== undefined) {
    conditions.push(sql`CAST(${cdms.tcaGpsNanos} AS INTEGER) <= ${filters.tca_max}`);
  }
  if (filters.only_active) {
    conditions.push(eq(cdms.isActive, true));
  }
  if (filters.trajectory1_source) {
    conditions.push(eq(cdms.trajectory1Source, filters.trajectory1_source));
  }
  if (filters.trajectory2_source) {
    conditions.push(eq(cdms.trajectory2Source, filters.trajectory2_source));
  }

  const rows = db
    .select()
    .from(cdms)
    .where(and(...conditions))
    .orderBy(cdms.seq)
    .limit(MAX_PAGE_SIZE)
    .all();

  const nextCursor = rows.length ? rows[rows.length - 1].seq : cursor;
  const nextToken = issueToken("cdms", nextCursor, filterHash);

  return json(200, {
    result: rows.map((r) => serialize(r, filters.include_cdm_file === true)),
    token: nextToken,
  });
});

