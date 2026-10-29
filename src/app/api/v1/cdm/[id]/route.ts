import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { cdms } from "@/db/schema";
import { toKvn, type CdmJson } from "@/lib/api/cdm";
import { ApiError } from "@/lib/api/errors";
import { route } from "@/lib/api/http";

/**
 * GET /api/v1/cdm/:id — the raw CDM file.
 *
 * `?format=json` (default) returns the JSON projection; `?format=kvn` returns
 * CCSDS KVN. Hypothetical CDMs are private to the operator that caused them.
 */
export const GET = route(async ({ params, request, principal }) => {
  const id = params.id;
  if (!id) throw ApiError.badRequest("missing cdm id");

  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "json";
  if (!["json", "kvn"].includes(format)) {
    throw ApiError.badRequest("format must be json or kvn", { parameter: "format" });
  }

  const { db } = getDb();
  const row = db.select().from(cdms).where(eq(cdms.id, id)).get();
  if (!row) throw ApiError.notFound(`cdm ${id} not found`);

  if (row.isHypothetical && row.operator1Id !== principal.operatorId) {
    throw ApiError.notFound(`cdm ${id} not found`);
  }

  if (format === "kvn") {
    const cdm = JSON.parse(row.fileJson) as CdmJson;
    return new Response(toKvn(cdm), {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${row.id}.cdm"`,
      },
    });
  }

  return new Response(row.fileJson, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": `inline; filename="${row.id}.json"`,
    },
  });
});

export const dynamic = "force-dynamic";
