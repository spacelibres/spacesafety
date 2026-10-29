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
function freshness(hours: number): { label: string; cls: string } {
  if (hours <= 24) return { label: "fresh", cls: "true" };
  if (hours <= 168) return { label: "aging", cls: "false" };
  return { label: "stale", cls: "false" };
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
  if (noradId === null) {
    return (
      <section className="card">
        <div className="card-head">Catalogue</div>
        <div className="card-body muted">
          No NORAD id yet. Run <code className="mono">npm run norad:backfill</code> to
          match this object against the Space-Track catalogue.
        </div>
      </section>
    );
  }

  const tle = await storedTle(objectId);

  if (!tle) {
    return (
      <section className="card">
        <div className="card-head">
          <span>Catalogue reference (SGP4)</span>
          <span className="count">NORAD {noradId}</span>
        </div>
        <div className="card-body muted">
          No element set stored for this object. Run{" "}
          <code className="mono">npm run ingest:tle</code> to pull it from Space-Track.
          It is a cross-check only — screening uses the operator ephemeris above.
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
        <span>Catalogue reference (SGP4)</span>
        <span className="count">
          <span className={`chip ${fresh.cls}`}>{fresh.label}</span>{" "}
          {age(ageHours)} old
        </span>
      </div>
      <div className="card-body muted" style={{ paddingTop: 0, paddingBottom: 8, fontSize: 12 }}>
        The catalogue&rsquo;s mean elements — a cross-check on the operator
        ephemeris, not the trajectory used for screening.
      </div>
      <table className="kv">
        <tbody>
          {row("NORAD Id", String(tle.noradId), true)}
          {row("Catalogue name", tle.name ?? "—")}
          {row("International designator", tle.intlDesignator || "—", true)}
          {row("Epoch", iso(tle.epochMs), true)}
          {row("Inclination", `${tle.inclinationDeg.toFixed(4)}°`)}
          {row("RAAN", `${tle.raanDeg.toFixed(4)}°`)}
          {row("Eccentricity", tle.eccentricity.toExponential(4))}
          {row("Arg. of perigee", `${tle.argPerigeeDeg.toFixed(4)}°`)}
          {row("Mean anomaly", `${tle.meanAnomalyDeg.toFixed(4)}°`)}
          {row("Mean motion", `${tle.meanMotionRevPerDay.toFixed(8)} rev/day`)}
          {row("Period", `${el.periodMin.toFixed(3)} min`)}
          {row("Apogee / perigee", `${el.apogeeKm.toFixed(1)} / ${el.perigeeKm.toFixed(1)} km`)}
          {row("B*", tle.bstar.toExponential(4))}
          {row("Element set", String(tle.elementSetNumber), true)}
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
