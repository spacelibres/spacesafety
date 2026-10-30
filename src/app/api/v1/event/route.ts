import { and, eq, or, sql, type SQL } from "drizzle-orm";

import { getDb } from "@/db";
import { events } from "@/db/schema";
import { json, route } from "@/lib/api/http";
import { hashFilters, issueToken, MAX_PAGE_SIZE, resolveCursor } from "@/lib/api/pagination";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/event — the deprecated conjunction-event list.
 *
 * Same rule as `/api/v1/cdm` (`docs/starlink-space-safety/tutorial-basics__cdms.md`):
 * these deprecated endpoints *"will only return results based on owner/operator
 * data"*, so this lists only events the caller's operator is involved in. Stargaze
 * CDMs never create events of their own — they attach to the events the operator
 * ephemerides already produced — so operator scoping is what the rule reduces to
 * here.
 *
 * Field names follow the documented v1 vocabulary (`created_at`, `updated_at`)
 * rather than v2's `creation_time`/`updated_time`; the snapshot does not specify
 * this list, so the choice is recorded here and in `CHANGELOG.md`.
 */
export const GET = route(async ({ request, principal }) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? undefined;

  const filterHash = hashFilters({ endpoint: "v1/event", operator: principal.operatorId });
  const cursor = resolveCursor("events", token, filterHash);

  // `events` has no explicit sequence column, so the append-only `rowid` is the
  // cursor. Using it keeps the token opaque and monotonic without a schema change.
  const conditions: SQL[] = [
    sql`events.rowid > ${cursor}`,
    or(
      eq(events.operator1Id, principal.operatorId),
      eq(events.operator2Id, principal.operatorId),
    )!,
  ];

  const { db } = getDb();
  const rows = db
    .select({ row: sql<number>`events.rowid`, event: events })
    .from(events)
    .where(and(...conditions))
    .orderBy(sql`events.rowid`)
    .limit(MAX_PAGE_SIZE)
    .all();

  const nextCursor = rows.length ? rows[rows.length - 1].row : cursor;
  const nextToken = issueToken("events", nextCursor, filterHash);

  return json(200, {
    result: rows.map(({ event: e }) => ({
      id: e.id,
      object1_id: e.object1Id,
      object1_name: e.object1Name,
      operator1_id: e.operator1Id,
      object2_id: e.object2Id,
      object2_name: e.object2Name,
      operator2_id: e.operator2Id,
      first_cdm_tca_gps_nanos: e.firstCdmTcaGpsNanos,
      created_at: e.creationTime,
      updated_at: e.updatedTime,
    })),
    token: nextToken,
  });
});
