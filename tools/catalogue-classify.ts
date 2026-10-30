/**
 * Multi-dimensional object classification.
 *
 * ## What this adds that the catalogue lacked
 *
 * `master_object.object_class` answers only "payload / debris / rocket body". The
 * questions actually asked of a space-safety catalogue are different: which country
 * owns it, which constellation it belongs to, what it does, and what orbit regime it
 * is in. Those are four independent axes, not one field.
 *
 * Each is derived from a different source, and each has a different reliability:
 *
 *   country       Space-Track `COUNTRY` — 100% of records, ISO-ish codes (`CIS`, `PRC`)
 *   constellation derived from the name — reliable for named fleets, empty otherwise
 *   purpose       KeepTrack `purpose` — 11 377 of 34 110, the only source with a
 *                 free-text mission role
 *   orbit regime  computed from apogee/perigee when both are known, else from GCAT's
 *                 `orbit_type` string, else left unknown
 *
 * ## Why the regime is computed rather than copied
 *
 * GCAT's `orbit_type` mixes two things: regime (`LEO`/`MEO`/`GEO`/`HEO`) and the
 * leading letter of a further qualifier (`LLEO` = low LEO, `LEO/S` = sun-synchronous).
 * Parsing that string alone would classify a satellite by a third party's mid-2000s
 * snapshot. Where apogee and perigee are known, the regime is arithmetic:
 *
 *   GEO   perigee > 35 000 km
 *   MEO   2 000 km ≤ perigee < 35 000 km
 *   LEO   apogee < 2 000 km
 *   HEO   perigee < 2 000 km ≤ apogee
 *
 * The string is the fallback, reported as such.
 *
 * Run: npx tsx tools/catalogue-classify.ts
 */

import Database from "better-sqlite3";

export type OrbitRegime = "LEO" | "MEO" | "GEO" | "HEO" | "UNKNOWN";

export interface Classification {
  noradId: number;
  /** ISO-like country code from Space-Track, e.g. `US`, `PRC`, `CIS`. */
  country: string | null;
  /** Named fleet, when the object name identifies one. */
  constellation: string | null;
  /** Organisation that operates the fleet, when the fleet is known. */
  operator: string | null;
  /** Free-text role from KeepTrack, normalised. */
  purpose: string | null;
  /** Normalised role group, e.g. `communication`, `earth-observation`. */
  purposeGroup: string | null;
  regime: OrbitRegime;
  /** How the regime was determined. */
  regimeBasis: "computed" | "stated" | "unknown";
  /** Manufacturer's bus, when known. */
  bus: string | null;
}

/**
 * Constellation patterns, longest-prefix first.
 *
 * Order matters: `STARLINK` must be matched before a shorter pattern that is also a
 * prefix of a different fleet, and a name like `ONEWEB-0123` must not be captured by
 * a generic rule. Each entry is a regex on the upper-cased name.
 */
const CONSTELLATIONS: Array<{ pattern: RegExp; name: string; operator: string }> = [
  { pattern: /^STARLINK\b/, name: "Starlink", operator: "SpaceX" },
  { pattern: /^ONEWEB\b/, name: "OneWeb", operator: "Eutelsat OneWeb" },
  { pattern: /^IRIDIUM\b/, name: "Iridium", operator: "Iridium" },
  { pattern: /^GLOBALSTAR\b/, name: "Globalstar", operator: "Globalstar" },
  { pattern: /^PLANET\b|^FLOCK\b|^SKYSAT\b|^DOVE\b|^PELICAN\b/, name: "Planet", operator: "Planet Labs" },
  { pattern: /^SPIRE\b|^LEMUR\b/, name: "Spire", operator: "Spire Global" },
  { pattern: /^ICEYE\b/, name: "ICEYE", operator: "ICEYE" },
  { pattern: /^HAWK\b|^HAWKEYE\b/, name: "HawkEye 360", operator: "HawkEye 360" },
  { pattern: /^BLACKSKY\b/, name: "BlackSky", operator: "BlackSky" },
  { pattern: /^GALILEO\b/, name: "Galileo", operator: "EU/EUSPA" },
  { pattern: /^GLONASS\b/, name: "GLONASS", operator: "Roscosmos" },
  { pattern: /^BEIDOU\b|^BD-?\d/, name: "BeiDou", operator: "CNSA" },
  { pattern: /^NAVSTAR|^GPS\b/, name: "GPS", operator: "US Space Force" },
  { pattern: /^SENTINEL-?\d|^SENTINEL\b/, name: "Copernicus Sentinel", operator: "ESA/EU" },
  { pattern: /^LANDSAT\b/, name: "Landsat", operator: "NASA/USGS" },
  { pattern: /^NOAA\b|^GOES\b|^JPSS\b/, name: "NOAA", operator: "NOAA" },
  { pattern: /^METEOSAT\b/, name: "Meteosat", operator: "EUMETSAT" },
  { pattern: /^HULIANWANG|^GUOWANG|^SATNET\b|^WHJSW\b/, name: "Guowang", operator: "China SatNet" },
  { pattern: /^QIANFAN\b/, name: "Qianfan", operator: "SpaceSail" },
  { pattern: /^YAOGAN\b|^YG-?\d/, name: "Yaogan", operator: "CNSA" },
  { pattern: /^TIANHUI\b/, name: "Tianhui", operator: "CNSA" },
  { pattern: /^GAOFEN\b|^GF-?\d/, name: "Gaofen", operator: "CNSA" },
  { pattern: /^COSMOS\b|^KOSMOS\b/, name: "Cosmos", operator: "Roscosmos" },
  { pattern: /^TDRS\b/, name: "TDRS", operator: "NASA" },
  { pattern: /^MOLNIYA\b/, name: "Molniya", operator: "Roscosmos" },
  { pattern: /^TIANGONG\b|^CSS\b|^TIANHE\b|^WENTIAN\b|^MENGTIAN\b/, name: "Tiangong", operator: "CMSA" },
  { pattern: /^ISS\b|^ZARYA\b/, name: "ISS", operator: "International" },
];

/** Map KeepTrack's free-text purpose to a small vocabulary. */
function normalisePurpose(raw: string | null): { purpose: string | null; group: string | null } {
  if (!raw) return { purpose: null, group: null };
  const t = raw.trim();
  const lower = t.toLowerCase();

  let group: string | null = null;
  if (/communicat|internet|data relay|broadband/.test(lower)) group = "communication";
  else if (/navigat|positioning/.test(lower)) group = "navigation";
  else if (/earth observation|remote sensing|imagery|imaging|optical|radar/.test(lower)) {
    group = "earth-observation";
  } else if (/meteorolog|weather|climate/.test(lower)) group = "meteorology";
  else if (/science|research|astronomy|astrophysics|solar|space weather/.test(lower)) {
    group = "science";
  } else if (/military|reconnaissance|early warning|elint|sigint/.test(lower)) group = "military";
  else if (/technology|demonstrat|test/.test(lower)) group = "technology";
  else if (/navigation, data relay|data relay/.test(lower)) group = "communication";

  return { purpose: t, group };
}

/** Parse GCAT's `orbit_type` when apogee/perigee are unavailable. */
function regimeFromString(s: string | null): OrbitRegime {
  if (!s) return "UNKNOWN";
  const t = s.toUpperCase();
  if (t.includes("GEO")) return "GEO";
  if (t.includes("MEO")) return "MEO";
  if (t.includes("HEO")) return "HEO";
  if (t.includes("LEO")) return "LEO";
  if (t.includes("GTO")) return "GTO" as OrbitRegime;
  return "UNKNOWN";
}

function regimeFromRadii(apogee: number | null, perigee: number | null): OrbitRegime | null {
  if (apogee === null || perigee === null) return null;
  if (perigee > 35_000) return "GEO";
  if (perigee >= 2_000) return "MEO";
  if (apogee < 2_000) return "LEO";
  return "HEO";
}

const DDL = `
CREATE TABLE IF NOT EXISTS object_classification (
  norad_id      INTEGER PRIMARY KEY,
  country       TEXT,
  constellation TEXT,
  operator      TEXT,
  purpose       TEXT,
  purpose_group TEXT,
  regime        TEXT NOT NULL,
  regime_basis  TEXT NOT NULL,
  bus           TEXT,
  computed_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cls_country_idx ON object_classification(country);
CREATE INDEX IF NOT EXISTS cls_constellation_idx ON object_classification(constellation);
CREATE INDEX IF NOT EXISTS cls_regime_idx ON object_classification(regime);
CREATE INDEX IF NOT EXISTS cls_purpose_idx ON object_classification(purpose_group);
`;

function main(): void {
  const dbPath = process.env.SPACE_SAFETY_DB ?? "./data/catalogue.sqlite";
  const db = new Database(dbPath);
  db.exec(DDL);

  console.log("\n  多维分类\n");

  // One pass over the sources, keyed by NORAD.
  const st = new Map<number, { name: string | null; country: string | null; apogee: number | null; perigee: number | null; cls: string | null }>();
  for (const r of db
    .prepare("SELECT norad_id, sat_name, country, apogee_km, perigee_km, object_type FROM space_track_satcat")
    .all() as Array<Record<string, unknown>>) {
    st.set(Number(r.norad_id), {
      name: (r.sat_name as string) ?? null,
      country: (r.country as string) ?? null,
      apogee: r.apogee_km as number | null,
      perigee: r.perigee_km as number | null,
      cls: (r.object_type as string) ?? null,
    });
  }

  const gcat = new Map<number, { orbitType: string | null; bus: string | null; name: string | null }>();
  const hasGcat = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='object_launch_info'").get() as { n: number }).n > 0;
  if (hasGcat) {
    for (const r of db
      .prepare("SELECT norad_id, orbit_type, bus, payload_name FROM object_launch_info")
      .all() as Array<Record<string, unknown>>) {
      gcat.set(Number(r.norad_id), {
        orbitType: (r.orbit_type as string) ?? null,
        bus: (r.bus as string) ?? null,
        name: (r.payload_name as string) ?? null,
      });
    }
  }

  const kt = new Map<number, { purpose: string | null; name: string | null; bus: string | null }>();
  const hasKt = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='keeptrack_object'").get() as { n: number }).n > 0;
  if (hasKt) {
    for (const r of db
      .prepare("SELECT norad_id, purpose, name, bus FROM keeptrack_object WHERE norad_id > 0")
      .all() as Array<Record<string, unknown>>) {
      kt.set(Number(r.norad_id), {
        purpose: (r.purpose as string) ?? null,
        name: (r.name as string) ?? null,
        bus: (r.bus as string) ?? null,
      });
    }
  }

  /**
   * Analyst objects, which exist in none of the other three sources.
   *
   * They are the reason this loader was needed: `universe` used to be the union of
   * Space-Track, GCAT and KeepTrack, so the 429 provisional-number objects were
   * absent from both the catalogue and the classification table — they could be
   * found by NORAD but had no country, no regime and no entry in any breakdown.
   *
   * Only the orbital elements are available; there is no international designator,
   * no owner and no purpose, so those columns stay null rather than being guessed
   * from the name.
   */
  const sbsup = new Map<
    number,
    { name: string | null; country: string | null; apogee: number | null; perigee: number | null }
  >();
  for (const r of db
    .prepare(
      `SELECT norad_id, name, owner, apogee, perigee
         FROM satcat WHERE norad_id >= 270000`,
    )
    .all() as Array<Record<string, unknown>>) {
    sbsup.set(Number(r.norad_id), {
      name: (r.name as string) ?? null,
      country: (r.owner as string) ?? null,
      apogee: r.apogee as number | null,
      perigee: r.perigee as number | null,
    });
  }

  /**
   * DISCOS-only objects.
   *
   * DISCOS lists a few objects with a catalogue number Space-Track has never
   * carried — NORAD 69475 is a CZ-5 upper stage. They reach the wide table but had
   * no classification row, so they were findable by number yet absent from every
   * breakdown.
   */
  const ds = new Map<number, { name: string | null }>();
  for (const r of db
    .prepare("SELECT norad_id, name FROM discos_objects WHERE norad_id > 0")
    .all() as Array<Record<string, unknown>>) {
    ds.set(Number(r.norad_id), { name: (r.name as string) ?? null });
  }

  const universe = new Set<number>([
    ...st.keys(),
    ...gcat.keys(),
    ...kt.keys(),
    ...sbsup.keys(),
    ...ds.keys(),
  ]);

  const rows: Classification[] = [];
  const regimeBasis = { computed: 0, stated: 0, unknown: 0 };

  for (const norad of universe) {
    const s = st.get(norad);
    const g = gcat.get(norad);
    const k = kt.get(norad);
    const p = sbsup.get(norad);

    const name = s?.name ?? k?.name ?? g?.name ?? p?.name ?? ds.get(norad)?.name ?? null;

    let constellation: string | null = null;
    let operator: string | null = null;
    if (name) {
      const upper = name.toUpperCase();
      for (const c of CONSTELLATIONS) {
        if (c.pattern.test(upper)) {
          constellation = c.name;
          operator = c.operator;
          break;
        }
      }
    }

    const { purpose, group } = normalisePurpose(k?.purpose ?? null);

    let regime: OrbitRegime;
    let basis: Classification["regimeBasis"];
    const computed = regimeFromRadii(s?.apogee ?? p?.apogee ?? null, s?.perigee ?? p?.perigee ?? null);
    if (computed) {
      regime = computed === ("GTO" as OrbitRegime) ? "HEO" : computed;
      basis = "computed";
    } else {
      const stated = regimeFromString(g?.orbitType ?? null);
      if (stated !== "UNKNOWN") {
        regime = stated === ("GTO" as OrbitRegime) ? "HEO" : stated;
        basis = "stated";
      } else {
        regime = "UNKNOWN";
        basis = "unknown";
      }
    }
    regimeBasis[basis] += 1;

    rows.push({
      noradId: norad,
      country: s?.country ?? p?.country ?? null,
      constellation,
      operator,
      purpose,
      purposeGroup: group,
      regime,
      regimeBasis: basis,
      bus: g?.bus ?? k?.bus ?? null,
    });
  }

  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO object_classification
       (norad_id, country, constellation, operator, purpose, purpose_group, regime, regime_basis, bus, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction((list: Classification[]) => {
    db.prepare("DELETE FROM object_classification").run();
    for (const c of list) {
      stmt.run(c.noradId, c.country, c.constellation, c.operator, c.purpose, c.purposeGroup, c.regime, c.regimeBasis, c.bus, now);
    }
  })(rows);

  // ------------------------------------------------------------- report
  console.log(`  对象        ${rows.length}`);
  console.log(`  轨道判定    computed ${regimeBasis.computed}  stated ${regimeBasis.stated}  unknown ${regimeBasis.unknown}`);

  const show = (label: string, sql: string) => {
    console.log(`\n  ${label}`);
    for (const r of db.prepare(sql).all() as Array<{ k: string | null; n: number }>) {
      console.log(`    ${(r.k ?? "(未分类)").padEnd(26)} ${String(r.n).padStart(7)}`);
    }
  };

  show("按轨道类型", "SELECT regime AS k, COUNT(*) AS n FROM object_classification GROUP BY 1 ORDER BY n DESC");
  show("按国家（前 10）", "SELECT country AS k, COUNT(*) AS n FROM object_classification GROUP BY 1 ORDER BY n DESC LIMIT 10");
  show("按星座（前 12）", "SELECT constellation AS k, COUNT(*) AS n FROM object_classification WHERE constellation IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 12");
  show("按用途", "SELECT purpose_group AS k, COUNT(*) AS n FROM object_classification WHERE purpose_group IS NOT NULL GROUP BY 1 ORDER BY n DESC");

  db.close();
  console.log("");
}

main();
