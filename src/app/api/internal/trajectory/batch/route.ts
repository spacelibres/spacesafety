import { eq, inArray } from "drizzle-orm";

import { getDb } from "@/db";
import { objects, trajectoryFiles, trajectories } from "@/db/schema";
import { ApiError } from "@/lib/api/errors";
import { json, route } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/internal/trajectory/batch — raw trajectory files for compute nodes.
 *
 * The gRPC dispatch carries only trajectory ids, so workers need a way to fetch the
 * actual ephemeris. Returning it over HTTP keeps the stream small (a few hundred
 * bytes per job) while still letting workers run without database access.
 *
 * ## Companion feeds
 *
 * A Starlink object has two trajectories -- the OCM and the Modified ITC -- linked
 * by `companion_id`. The job names one of them, but the worker needs both to pick
 * the best input: the OCM's long arc, with the ITC's covariance when the OCM has
 * none. So the response carries the requested trajectory plus its companion, and
 * the worker combines them (`src/lib/orbit/feed-combination.ts`).
 *
 * Returning the pair rather than pre-combining here keeps the numerical decision in
 * the compute node, where the rest of the kernel lives, and leaves this endpoint a
 * plain database read.
 *
 * Access is gated on SPACE_EYES_WORKER_TOKEN, shared with the compute node.
 */
export const POST = route(
  async ({ request }) => {
    const expected = process.env.SPACE_EYES_WORKER_TOKEN;
    if (!expected) {
      throw ApiError.forbidden("trajectory batch endpoint is disabled");
    }
    if (request.headers.get("x-worker-token") !== expected) {
      throw ApiError.forbidden("invalid worker token");
    }

    const body = (await request.json()) as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.some((i) => typeof i !== "string")) {
      throw ApiError.badRequest("body must be { ids: string[] }");
    }
    const ids = (body.ids as string[]).slice(0, 64);
    if (ids.length === 0) return json(200, { trajectories: [] });

    const { db } = getDb();

    const selectTrajectories = (whereIds: string[]) =>
      db
        .select({
          id: trajectories.id,
          objectId: trajectories.objectId,
          objectName: objects.objectName,
          hardBodyRadius: objects.hardBodyRadius,
          stateSource: trajectories.stateSource,
          fileText: trajectoryFiles.fileText,
          format: trajectories.fileFormat,
          companionId: trajectories.companionId,
          hasCovariance: trajectories.hasCovariance,
        })
        .from(trajectories)
        .innerJoin(trajectoryFiles, eq(trajectoryFiles.trajectoryId, trajectories.id))
        .leftJoin(objects, eq(objects.id, trajectories.objectId))
        .where(inArray(trajectories.id, whereIds))
        .all();

    const requested = selectTrajectories(ids);

    // One extra indexed query for the companions, rather than a self-join: the set
    // is small and the lookup is cheap.
    const companionIds = requested
      .map((r) => r.companionId)
      .filter((id): id is string => typeof id === "string" && !ids.includes(id));
    const companions =
      companionIds.length > 0 ? selectTrajectories(companionIds) : [];

    const serialize = (r: (typeof requested)[number]) => ({
      id: r.id,
      object_id: r.objectId,
      object_name: r.objectName ?? r.objectId,
      hard_body_radius_km: (r.hardBodyRadius ?? 0) / 1000,
      state_source: r.stateSource,
      format: r.format,
      has_covariance: r.hasCovariance,
      file: r.fileText,
    });

    return json(200, {
      trajectories: requested.map(serialize),
      /**
       * Companion feeds, keyed by the id of the trajectory that names them.
       *
       * Kept separate from `trajectories` so a worker can tell which entry the job
       * asked for: the requested trajectory is what the CDM attributes its states
       * to, and the companion only contributes covariance.
       */
      companions: Object.fromEntries(
        requested
          .filter((r) => r.companionId)
          .map((r) => {
            const found = companions.find((c) => c.id === r.companionId);
            return [r.id, found ? serialize(found) : null];
          }),
      ),
    });
  },
  { auth: false },
);
