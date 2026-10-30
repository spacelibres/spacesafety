import { NextResponse } from "next/server";

import {
  setFieldChoice,
  SOURCE_IDS,
  WIDE_FIELDS,
  wideCatalogueAvailable,
  type SourceId,
  type WideField,
} from "@/lib/wide-catalogue";

export const dynamic = "force-dynamic";

interface Body {
  norad_id?: unknown;
  field?: unknown;
  /** A source id, or null to clear the choice and fall back to the default. */
  source?: unknown;
}

/**
 * Change which source a field of one object is displayed from.
 *
 * This writes to the attached wide catalogue, which starts as a build artefact.
 * That is deliberate: a user's choice is data they produced, and rebuilding the
 * wide table (`npx tsx tools/build-wide-catalogue.ts`) resets every choice — worth
 * knowing before running it.
 */
export async function PATCH(request: Request): Promise<NextResponse> {
  if (!wideCatalogueAvailable()) {
    return NextResponse.json(
      { error: "wide catalogue not built; run `npx tsx tools/build-wide-catalogue.ts`" },
      { status: 503 },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "request body is not valid JSON" }, { status: 400 });
  }

  const noradId = Number(body.norad_id);
  if (!Number.isInteger(noradId) || noradId <= 0) {
    return NextResponse.json({ error: "norad_id must be a positive integer" }, { status: 400 });
  }

  const field = String(body.field ?? "");
  if (!(WIDE_FIELDS as readonly string[]).includes(field)) {
    return NextResponse.json({ error: `unknown field: ${field}` }, { status: 400 });
  }

  const raw = body.source;
  if (raw !== null && !(SOURCE_IDS as readonly string[]).includes(String(raw))) {
    return NextResponse.json(
      { error: `source must be one of ${SOURCE_IDS.join(" / ")} or null` },
      { status: 400 },
    );
  }

  try {
    setFieldChoice(noradId, field as WideField, raw === null ? null : (String(raw) as SourceId));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, norad_id: noradId, field, source: raw });
}
