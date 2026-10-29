import { and, eq, gt, sql } from "drizzle-orm";

import { getDb, nextSeq } from "@/db";
import { objects, trajectoryFiles, trajectories } from "@/db/schema";
import { ApiError } from "@/lib/api/errors";
import {
  json,
  readJson,
  route,
} from "@/lib/api/http";
import {
  hashFilters,
  issueToken,
  MAX_PAGE_SIZE,
  resolveCursor,
} from "@/lib/api/pagination";
import { enqueueScreening } from "@/lib/api/screening-service";
import {
  normaliseTrajectory,
  MAX_FILE_CHARS,
  type TrajectoryUploadTypeInput,
} from "@/lib/api/validate-trajectory";

export const dynamic = "force-dynamic";

const UPLOAD_TYPES = ["hypothetical", "definitive", "candidate"] as const;
const STATE_SOURCES = ["operator_ephemeris", "spacex_optical"] as const;

function serialize(t: typeof trajectories.$inferSelect) {
  return {
    id: t.id,
    object_id: t.objectId,
    operator_id: t.operatorId,
    upload_type: t.uploadType,
    state_source: t.stateSource,
    screened_status: t.screenedStatus,
    screened_at: t.screenedAt,
    uploaded_at: t.uploadedAt,
    created_at: t.createdAt,
    start_at: t.startAt,
    end_at: t.endAt,
    auto_relinquish_pc_threshold: t.autoRelinquishPcThreshold,
  };
}

/**
 * GET /api/v1/trajectory — streaming feed of trajectories.
 *
 * Ordered by upload time then id, and paged with an opaque token. Reusing the
 * same token when nothing is new returns zero rows, exactly as documented.
 */
export const GET = route(async ({ request, principal }) => {
  const url = new URL(request.url);
  const filters = {
    object_id: url.searchParams.get("object_id") ?? undefined,
    operator_id: url.searchParams.get("operator_id") ?? undefined,
    upload_type: url.searchParams.get("upload_type") ?? undefined,
    state_source: url.searchParams.get("state_source") ?? undefined,
    min_update_time: url.searchParams.get("min_update_time") ?? undefined,
  };
  const token = url.searchParams.get("token") ?? undefined;
  const filterHash = hashFilters(filters);

  const cursor = resolveCursor("trajectories", token, filterHash);

  const { db } = getDb();
  const conditions = [gt(trajectories.seq, cursor)];

  if (filters.object_id) conditions.push(eq(trajectories.objectId, filters.object_id));
  if (filters.operator_id) conditions.push(eq(trajectories.operatorId, filters.operator_id));
  if (filters.upload_type) {
    if (!UPLOAD_TYPES.includes(filters.upload_type as never)) {
      throw ApiError.badRequest("invalid upload_type", { parameter: "upload_type" });
    }
    conditions.push(eq(trajectories.uploadType, filters.upload_type));
    // Hypothetical trajectories are only visible to their submitter.
    if (filters.upload_type === "hypothetical") {
      conditions.push(eq(trajectories.operatorId, principal.operatorId));
    }
  }
  if (filters.state_source) {
    if (!STATE_SOURCES.includes(filters.state_source as never)) {
      throw ApiError.badRequest("invalid state_source", { parameter: "state_source" });
    }
    conditions.push(eq(trajectories.stateSource, filters.state_source));
  } else {
    // Documented default: only operator ephemerides unless asked otherwise.
    conditions.push(eq(trajectories.stateSource, "operator_ephemeris"));
  }
  if (filters.min_update_time) {
    conditions.push(sql`${trajectories.uploadedAt} >= ${filters.min_update_time}`);
  }

  // Hypothetical rows never leak to other operators, whatever the filter.
  conditions.push(
    sql`(${trajectories.uploadType} <> 'hypothetical' OR ${trajectories.operatorId} = ${principal.operatorId})`,
  );

  const rows = db
    .select()
    .from(trajectories)
    .where(and(...conditions))
    .orderBy(trajectories.seq)
    .limit(MAX_PAGE_SIZE)
    .all();

  const nextCursor = rows.length ? rows[rows.length - 1].seq : cursor;
  const nextToken = issueToken("trajectories", nextCursor, filterHash);

  return json(200, { result: rows.map(serialize), token: nextToken });
});

interface UploadBody {
  object_id?: unknown;
  file?: unknown;
  upload_type?: unknown;
  state_source?: unknown;
  auto_relinquish_pc_threshold?: unknown;
}

/**
 * POST /api/v1/trajectory — upload an ephemeris.
 *
 * Validates against every documented rule, normalises into inertial states,
 * stores the raw file, and queues screening against the catalog.
 */
export const POST = route(async ({ request, principal }) => {
  const body = await readJson<UploadBody>(request);
  const issues: { field: string; reason: string }[] = [];

  const objectId = typeof body.object_id === "string" ? body.object_id : "";
  if (!objectId) issues.push({ field: "object_id", reason: "required uuid" });

  const file = typeof body.file === "string" ? body.file : "";
  if (!file) {
    issues.push({ field: "file", reason: "required string" });
  } else if (file.length > MAX_FILE_CHARS) {
    issues.push({
      field: "file",
      reason: `must be at most ${MAX_FILE_CHARS} characters`,
    });
  }

  const uploadType = body.upload_type;
  if (!UPLOAD_TYPES.includes(uploadType as never)) {
    issues.push({
      field: "upload_type",
      reason: `must be one of ${UPLOAD_TYPES.join(", ")}`,
    });
  }

  let stateSource = "operator_ephemeris";
  if (body.state_source !== undefined) {
    if (!STATE_SOURCES.includes(body.state_source as never)) {
      issues.push({
        field: "state_source",
        reason: `must be one of ${STATE_SOURCES.join(", ")}`,
      });
    } else {
      stateSource = body.state_source as string;
    }
  }

  let threshold: number | null = null;
  if (body.auto_relinquish_pc_threshold !== undefined && body.auto_relinquish_pc_threshold !== null) {
    const v = body.auto_relinquish_pc_threshold;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      issues.push({
        field: "auto_relinquish_pc_threshold",
        reason: "must be a number in [0, 1]",
      });
    } else {
      threshold = v;
    }
  }

  if (issues.length > 0) {
    throw ApiError.badRequest("invalid trajectory payload", { fields: issues });
  }

  const { db } = getDb();
  const object = db.select().from(objects).where(eq(objects.id, objectId)).get();
  if (!object) throw ApiError.notFound(`object ${objectId} not found`);
  if (object.operatorId !== principal.operatorId) {
    throw ApiError.forbidden("trajectories may only be uploaded for your own objects");
  }

  // Parse + validate (throws a TrajectoryValidationError with all issues).
  const normalised = normaliseTrajectory(file);

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const { sqlite } = getDb();
  const seq = nextSeq(sqlite, "trajectories");

  db.insert(trajectories)
    .values({
      id,
      objectId,
      operatorId: principal.operatorId,
      uploadType: uploadType as TrajectoryUploadTypeInput,
      stateSource,
      screenedStatus: "not_screened",
      fileFormat: normalised.format,
      startAt: normalised.startAt,
      endAt: normalised.endAt,
      pointCount: normalised.states.length,
      uploadedAt: now,
      createdAt: now,
      autoRelinquishPcThreshold: threshold,
      seq,
    })
    .run();

  // The file lives in its own table so metadata queries never page through it.
  db.insert(trajectoryFiles).values({ trajectoryId: id, fileText: file }).run();

  const queued = enqueueScreening({
    trajectoryId: id,
    objectId,
    uploadType: uploadType as string,
    stateSource,
  });

  return json(
    201,
    { id },
    undefined,
    {
      location: `/api/v1/trajectory/${id}`,
      "x-screening-jobs-queued": String(queued),
      ...(normalised.warnings.length
        ? { "x-validation-warnings": String(normalised.warnings.length) }
        : {}),
    },
  );
});
