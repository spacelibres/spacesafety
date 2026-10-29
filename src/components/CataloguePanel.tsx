/**
 * Catalogue reference card for the object detail page.
 *
 * ## What this is, and what it is not
 *
 * This shows the *catalogue's* mean elements (TLE, SGP4) — how the 18th Space
 * Defense Squadron sees the object, and how stale their view is. It is **not** the
 * trajectory this platform screens with: for Starlink the screening input is the
 * operator's own OCM (7-day propagated arc with 6x6 covariance), and this card is
 * a cross-check against it.
 *
 * The distinction is the point of the page, so the card says so instead of
 * presenting SGP4 elements as if they were the object's state.
 *
 * ## Why it reads the database
 *
 * It used to call Space-Track on every render. That made opening an object wait on
 * a slow external API, and frequent reloads tripped Space-Track's rate limit — for
 * data `ingest:tle` had already stored. The stored row is now read directly;
 * `npm run ingest:tle` refreshes it.
 */

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { trajectoryFiles, trajectories } from "@/db/schema";
import { getTranslator } from "@/lib/i18n/registry";
import { tleElements } from "@/lib/orbit/sgp4";
import { parseTleFile } from "@/lib/orbit/tle";
import type { Tle } from "@/lib/orbit/tle";

export interface CataloguePanelProps {
  noradId: number | null;
  /** Object row id, used to read the stored element set. */
  objectId: string;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(".000Z", " UTC").replace("Z", " UTC");
}

/** Format an age in hours as "3.2 h" or "2.1 d". */
function age(hours: number): string {
  if (Math.abs(hours) < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

/**
 * Freshness band.
 *
 * SGP4 error grows roughly linearly with element age, dominated by the drag term.
 * The thresholds here are practical rather than theoretical: inside a day the
 * elements are good for kilometre-scale work, beyond a week the along-track error
 * is large enough that a screening result from them should not be trusted.
 */
function freshness(hours: number): { labelKey: string; cls: string } {
  if (hours <= 24) return { labelKey: "catalogue.fresh", cls: "true" };
  if (hours <= 168) return { labelKey: "catalogue.aging", cls: "false" };
  return { labelKey: "catalogue.stale", cls: "false" };
}

function row(k: string, v: string, mono = false) {
  return (
    <tr>
      <td className="k">{k}</td>
      <td className={mono ? "v-mono" : undefined}>{v}</td>
    </tr>
  );
}

/** The newest stored TLE for an object, if `ingest:tle` has run. */
async function storedTle(objectId: string): Promise<Tle | null> {
  const { db } = getDb();
  const row = db
    .select({ text: trajectoryFiles.fileText })
    .from(trajectories)
    .innerJoin(trajectoryFiles, eq(trajectoryFiles.trajectoryId, trajectories.id))
    .where(and(eq(trajectories.objectId, objectId), eq(trajectories.stateSource, "tle")))
    .orderBy(desc(trajectories.uploadedAt))
    .limit(1)
    .get();
  if (!row) return null;
  const parsed = parseTleFile(row.text);
  return parsed.tles[0] ?? null;
}

export async function CataloguePanel({ noradId, objectId }: CataloguePanelProps) {
  const t = await getTranslator();

  if (noradId === null) {
    return (
      <section className="card">
        <div className="card-head">{t.t("overview.catalog")}</div>
        <div className="card-body muted">
          {t.t("catalogue.noNoradBefore")}{" "}
          <code className="mono">npm run norad:backfill</code>
          {t.t("catalogue.noNoradAfter")}
        </div>
      </section>
    );
  }

  const tle = await storedTle(objectId);

  if (!tle) {
    return (
      <section className="card">
        <div className="card-head">
          <span>{t.t("catalogue.referenceSgp4")}</span>
          <span className="count">{t.t("catalogue.noradId", { id: noradId })}</span>
        </div>
        <div className="card-body muted">
          {t.t("catalogue.noElementsBefore")}{" "}
          <code className="mono">npm run ingest:tle</code>
          {t.t("catalogue.noElementsAfter")}
        </div>
      </section>
    );
  }

  const el = tleElements(tle);
  const ageHours = (Date.now() - tle.epochMs) / 3_600_000;
  const fresh = freshness(ageHours);

  return (
    <section className="card">
      <div className="card-head">
        <span>{t.t("catalogue.referenceSgp4")}</span>
        <span className="count">
          <span className={`chip ${fresh.cls}`}>{t.t(fresh.labelKey)}</span>{" "}
          {t.t("catalogue.age", { age: age(ageHours) })}
        </span>
      </div>
      <div className="card-body muted" style={{ paddingTop: 0, paddingBottom: 8, fontSize: 12 }}>
        {t.t("catalogue.caption")}
      </div>
      <table className="kv">
        <tbody>
          {row(t.t("catalogue.noradIdLabel"), String(tle.noradId), true)}
          {row(t.t("catalogue.name"), tle.name ?? t.t("common.none"))}
          {row(t.t("catalogue.intlDesignator"), tle.intlDesignator || t.t("common.none"), true)}
          {row(t.t("catalogue.epoch"), iso(tle.epochMs), true)}
          {row(t.t("catalogue.inclination"), `${tle.inclinationDeg.toFixed(4)}°`)}
          {row(t.t("catalogue.raan"), `${tle.raanDeg.toFixed(4)}°`)}
          {row(t.t("catalogue.eccentricity"), tle.eccentricity.toExponential(4))}
          {row(t.t("catalogue.argPerigee"), `${tle.argPerigeeDeg.toFixed(4)}°`)}
          {row(t.t("catalogue.meanAnomaly"), `${tle.meanAnomalyDeg.toFixed(4)}°`)}
          {row(t.t("catalogue.meanMotion"), `${tle.meanMotionRevPerDay.toFixed(8)} rev/day`)}
          {row(t.t("catalogue.period"), `${el.periodMin.toFixed(3)} min`)}
          {row(
            t.t("catalogue.apogeePerigee"),
            `${el.apogeeKm.toFixed(1)} / ${el.perigeeKm.toFixed(1)} km`,
          )}
          {row("B*", tle.bstar.toExponential(4))}
          {row(t.t("catalogue.elementSet"), String(tle.elementSetNumber), true)}
        </tbody>
      </table>
      <div className="card-body" style={{ paddingTop: 0 }}>
        <div
          className="mono"
          style={{ fontSize: 11, lineHeight: 1.5, overflowX: "auto", whiteSpace: "pre" }}
        >
          {tle.line1}
          {"\n"}
          {tle.line2}
        </div>
      </div>
    </section>
  );
}
