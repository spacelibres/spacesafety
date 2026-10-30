import { and, eq, gt, or, sql, type SQL } from "drizzle-orm";

import { getDb } from "@/db";
import { cdms } from "@/db/schema";
import { json, route } from "@/lib/api/http";
import { listPublishedConjunctions } from "@/lib/queries";
import { hashFilters, issueToken, MAX_PAGE_SIZE, resolveCursor } from "@/lib/api/pagination";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/cdm — the deprecated CDM list.
 *
 * `docs/starlink-space-safety/tutorial-basics__cdms.md` says of the two
 * deprecated list endpoints: *"The (deprecated) `GET /api/v1/event` and
 * `GET /api/v1/cdm` endpoints will only return results based on owner/operator
 * data."* They still exist upstream, so a client written against the tutorial
 * finds them here too, and they stay scoped exactly that way:
 *
 *   - only conjunctions the caller's operator takes part in;
 *   - only rows where **both** trajectories are `operator_ephemeris`, which is
 *     what excludes the Stargaze (`spacex_optical`) CDMs — those are reachable
 *     only through `/api/v2/cdm` / `/api/v2/cdms`;
 *   - hypothetical CDMs are excluded, matching the v2 stream and the fact that
 *     these endpoints are the shared, catalog-level view.
 *
 * The response shape is not specified in the snapshot, so it mirrors the field
 * names the documented v1 endpoints use (`/v1/cdm/:id/metadata`,
 * `/v1/event/:id/cdms`): `created_at`, `tca`, `probability_of_collision`.
 * `{result, token}` follows the pagination pattern the vendor documents for
 * every bulk endpoint.
 *
 * ## `?source=public` — an extension, not part of the vendor contract
 *
 * The endpoint above is empty whenever no operator has uploaded an ephemeris,
 * which is this deployment's state. The conjunction data that *does* exist is the
 * publicly published CDM feed, and it does not belong in the default response:
 * the vendor scopes this endpoint to owner/operator data, and a public CDM has no
 * covariance, no manoeuvre plan and no operator claim.
 *
 * So it is opt-in and self-describing. `?source=public` returns the published
 * conjunctions with an explicit `source` field and no operator scoping, and the
 * default request is byte-for-byte what it was before. An unknown `source` is a
 * 400 rather than a silent fallback, because a client that asked for one thing and
 * received another would misreport it.
 */
export const GET = route(async ({ request, principal }) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? undefined;

  const source = url.searchParams.get("source");
  if (source === "public") {
    const published = listPublishedConjunctions(500);
    return json(200, {
      result: published.map((c) => ({
        id: c.cdmId,
        source: "space-track-public-cdm",
        event_id: null,
        created_at: c.createdIso,
        tca: c.tcaIso,
        probability_of_collision: c.pc,
        miss_distance_km: c.minRangeKm,
        message_count: c.messageCount,
        object1: { norad_id: c.object1Norad, name: c.object1Name, type: c.object1Type },
        object2: { norad_id: c.object2Norad, name: c.object2Name, type: c.object2Type },
        operator1_id: null,
        operator2_id: null,
        is_active: c.tcaInFuture,
      })),
      // The published feed is complete per capture; there is no cursor to issue.
      token: null,
    });
  }
  if (source !== null && source !== "operator") {
    return json(400, {
      error: "invalid_source",
      message: `unknown source "${source}"; expected "operator" (default) or "public"`,
    });
  }

  const filterHash = hashFilters({ endpoint: "v1/cdm", operator: principal.operatorId });
  const cursor = resolveCursor("cdms", token, filterHash);

  const conditions: SQL[] = [
    gt(cdms.seq, cursor),
    // Owner/operator data only.
    or(
      eq(cdms.operator1Id, principal.operatorId),
      eq(cdms.operator2Id, principal.operatorId),
    )!,
    eq(cdms.trajectory1Source, "operator_ephemeris"),
    eq(cdms.trajectory2Source, "operator_ephemeris"),
    sql`${cdms.isHypothetical} = 0`,
  ];

  const { db } = getDb();
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
    result: rows.map((c) => ({
      id: c.id,
      event_id: c.eventId,
      created_at: c.createdAt,
      probability_of_collision: c.probabilityOfCollision,
      tca: c.tcaGpsNanos,
      trajectory1_id: c.trajectory1Id,
      trajectory2_id: c.trajectory2Id,
      is_active: c.isActive,
    })),
    token: nextToken,
  });
});
