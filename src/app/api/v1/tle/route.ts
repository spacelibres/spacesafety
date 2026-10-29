/**
 * TLE / GP endpoint.
 *
 *   GET /api/v1/tle?object_id=<uuid>            → elements for one of our objects
 *   GET /api/v1/tle?norad_id=44713              → elements straight from catalogue
 *   GET /api/v1/tle?norad_id=44713&format=3le   → raw text instead of JSON
 *   GET /api/v1/tle?norad_id=44713&propagate=6  → elements plus SGP4 states (hours)
 *
 * These are additions to the vendor's endpoint set: the Space Safety API is built
 * around operator ephemerides and carries no TLE support at all. They exist here
 * because the catalogue is the only public source of a NORAD id, and because SGP4
 * gives a usable track for objects we have no operator ephemeris for.
 *
 * The response deliberately carries `age_hours` alongside the elements: a TLE's
 * age is the dominant term in its accuracy, and hiding it would invite treating a
 * two-week-old element set as if it were current.
 */

import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { objects } from "@/db/schema";
import { ApiError } from "@/lib/api/errors";
import { floatParam, intParam, json, route } from "@/lib/api/http";
import { propagateTle, tleElements } from "@/lib/orbit/sgp4";
import type { Tle } from "@/lib/orbit/tle";
import { fetchGpByNorad } from "@/lib/sources/space-track";

function serialize(tle: Tle, source: string, asOfMs: number) {
  const el = tleElements(tle);
  return {
    norad_id: tle.noradId,
    object_name: tle.name,
    source,
    epoch: new Date(tle.epochMs).toISOString(),
    age_hours: Number(((asOfMs - tle.epochMs) / 3_600_000).toFixed(2)),
    classification: tle.classification,
    international_designator: tle.intlDesignator,
    inclination_deg: tle.inclinationDeg,
    raan_deg: tle.raanDeg,
    eccentricity: tle.eccentricity,
    arg_perigee_deg: tle.argPerigeeDeg,
    mean_anomaly_deg: tle.meanAnomalyDeg,
    mean_motion_rev_per_day: tle.meanMotionRevPerDay,
    bstar: tle.bstar,
    rev_number: tle.revNumber,
    element_set_number: tle.elementSetNumber,
    /** Derived from mean motion and eccentricity; not a propagated position. */
    altitude_km: Number(el.altitudeKm.toFixed(3)),
    apogee_km: Number(el.apogeeKm.toFixed(3)),
    perigee_km: Number(el.perigeeKm.toFixed(3)),
    period_min: Number(el.periodMin.toFixed(4)),
    tle: { line1: tle.line1, line2: tle.line2 },
  };
}

export const GET = route(async ({ request, correlationId }) => {
  const url = new URL(request.url);
  const objectId = url.searchParams.get("object_id");
  const noradParam = intParam(url, "norad_id");
  const format = (url.searchParams.get("format") ?? "json").toLowerCase();
  const spanHours = floatParam(url, "propagate", { min: 0, max: 168 });
  const stepSeconds = floatParam(url, "step_seconds", { min: 1, max: 3600 });

  if (!objectId && noradParam === undefined) {
    throw ApiError.badRequest("one of object_id or norad_id is required");
  }

  // Resolving one of our objects goes through its stored NORAD id: the catalogue
  // is keyed by that, not by the name the operator's ephemeris happened to use.
  let noradId = noradParam;
  if (objectId) {
    const { db } = getDb();
    const row = db.select().from(objects).where(eq(objects.id, objectId)).get();
    if (!row) throw ApiError.notFound(`no object with id ${objectId}`);
    if (row.noradId === null) {
      throw ApiError.badRequest(
        `object ${row.objectName} has no norad_id; run \`npm run norad:backfill\` first`,
      );
    }
    if (noradId !== undefined && noradId !== row.noradId) {
      throw ApiError.badRequest(
        `norad_id ${noradId} does not match object ${row.objectName} (${row.noradId})`,
      );
    }
    noradId = row.noradId;
  }

  const fetched = await fetchGpByNorad(noradId!);
  if (fetched.notConfigured) {
    throw ApiError.serviceUnavailable(
      "Space-Track credentials are not configured (SPACE_SAFETY_SPACETRACK_USER/PASS)",
    );
  }
  if (fetched.error) {
    throw ApiError.badGateway(`Space-Track lookup failed: ${fetched.error}`);
  }
  if (!fetched.tle) {
    throw ApiError.notFound(`no gp elements for NORAD id ${noradId}`);
  }

  if (format === "3le" || format === "text") {
    const name = fetched.tle.name ? `0 ${fetched.tle.name}\n` : "";
    return new Response(`${name}${fetched.tle.line1}\n${fetched.tle.line2}\n`, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const payload: Record<string, unknown> = serialize(fetched.tle, "space-track", Date.now());

  if (spanHours && spanHours > 0) {
    const propagated = propagateTle(fetched.tle, {
      spanHours,
      stepSeconds: stepSeconds ?? 60,
    });
    payload.propagation = {
      model: "SGP4",
      frame: "EME2000",
      span_hours: spanHours,
      step_seconds: stepSeconds ?? 60,
      // SGP4 carries no covariance, so any CDM built from these has a NULL Pc.
      has_covariance: false,
      states: propagated.states.map((s) => ({
        epoch: new Date(s.ms).toISOString(),
        position: s.position.map((x) => Number(x.toFixed(6))),
        velocity: s.velocity.map((x) => Number(x.toFixed(9))),
      })),
      failures: propagated.failures.length,
    };
  }

  return json(200, payload, correlationId);
});
