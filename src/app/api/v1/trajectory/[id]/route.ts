import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { trajectories } from "@/db/schema";
import { ApiError } from "@/lib/api/errors";
import { route } from "@/lib/api/http";
import { normaliseTrajectory } from "@/lib/api/validate-trajectory";
import { REFERENCE_FRAMES, renderOem, type ReferenceFrame } from "@/lib/orbit/oem-write";
import { getTrajectoryFile } from "@/lib/queries";

/**
 * GET /api/v1/trajectory/:id — the raw trajectory file.
 *
 * Visibility rules (`SPEC-BEHAVIOR.md` §5): every `operator_ephemeris`
 * trajectory is readable, but `spacex_optical` contents are never exposed — only
 * the CDMs they produce. Hypothetical trajectories are private to the submitter.
 */
export const GET = route(async ({ params, principal, request }) => {
  const id = params.id;
  if (!id) throw ApiError.badRequest("missing trajectory id");

  // `?reference_frame` is documented on this endpoint: the same ephemeris
  // expressed in another frame. `original` (the default) returns the bytes that
  // were uploaded, untouched.
  const url = new URL(request.url);
  const requested = url.searchParams.get("reference_frame") ?? "original";
  if (!(REFERENCE_FRAMES as readonly string[]).includes(requested)) {
    throw ApiError.badRequest(
      `reference_frame must be one of ${REFERENCE_FRAMES.join(", ")}`,
      { parameter: "reference_frame" },
    );
  }
  const frame = requested as ReferenceFrame;

  const { db } = getDb();
  const row = db.select().from(trajectories).where(eq(trajectories.id, id)).get();
  if (!row) throw ApiError.notFound(`trajectory ${id} not found`);

  if (row.stateSource === "spacex_optical") {
    throw ApiError.forbidden(
      "spacex_optical trajectory contents are not available; query the CDMs instead",
    );
  }
  if (row.uploadType === "hypothetical" && row.operatorId !== principal.operatorId) {
    throw ApiError.forbidden("hypothetical trajectories are only visible to their submitter");
  }

  const file = getTrajectoryFile(row.id);
  if (!file) throw ApiError.notFound("trajectory file is missing");

  // `original`: hand back exactly what was stored.
  if (frame === "original") {
    return new Response(file.text, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `inline; filename="${row.id}.${row.fileFormat}"`,
        "x-trajectory-format": row.fileFormat,
        "x-screened-status": row.screenedStatus,
        "x-reference-frame": "original",
      },
    });
  }

  // Any other frame: parse once and re-emit. The future-window rule is *not*
  // re-applied here — a file accepted at upload time may well be in the past by
  // the time someone asks for it in ITRF, and that is not a reason to refuse.
  const parsed = normaliseTrajectory(file.text, { enforceFutureWindow: false });
  const body = renderOem(parsed.states, {
    frame,
    objectName: parsed.objectName,
    // Position/velocity move to the requested frame; the covariance section is
    // emitted in the same frame with the block-diagonal convention documented in
    // `frames-rigorous.ts`.
    covarianceFrame: parsed.states.some((s) => s.covariance)
      ? frame === "itrf"
        ? "ITRF"
        : "EME2000"
      : null,
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // The extension follows the emitted format, not the uploaded one.
      "content-disposition": `inline; filename="${row.id}.oem"`,
      "x-trajectory-format": "oem",
      "x-screened-status": row.screenedStatus,
      "x-reference-frame": frame,
    },
  });
});

export const dynamic = "force-dynamic";
