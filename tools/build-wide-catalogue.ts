/**
 * Build the wide catalogue: one row per object, every field carrying all three
 * sources' values side by side.
 *
 * ## The requirement this implements
 *
 * The three catalogues are not redundant. Space-Track is the US reference
 * catalogue, DISCOSweb is ESA's, Spacebook carries ComSpoc/AGI-STK's model. They
 * disagree on 4 834 inclinations and 9 680 classes — not because one is wrong, but
 * because they are separate authorities.
 *
 * So this does **not** pick a winner. Every field gets one column per source:
 *
 *   mass_kg__spacetrack | mass_kg__spacebook | mass_kg__discos | mass_kg__chosen
 *
 * and a matching `*__chosen` column holds the source id the user selected, or NULL
 * while the choice is still open. Our own preference is only a *default* written
 * into `*__chosen`; the other two values remain readable, and the choice can be
 * changed per object without re-downloading anything.
 *
 * ## Why a wide table when `object_field_claim` already exists
 *
 * The claim table is normalised and is the right shape for storage; a wide table
 * is the right shape for *reading and comparing*, which is what the catalogue page
 * does. Both are built from the same source rows so they cannot drift apart.
 *
 * Run: npx tsx tools/build-wide-catalogue.ts
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

function newest(dir: string): string {
  const days = readdirSync(dir)
    .filter((d) => statSync(join(dir, d)).isDirectory())
    .sort();
  const day = days.at(-1)!;
  const files = readdirSync(join(dir, day)).sort();
  return join(dir, day, files.at(-1)!);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * KeepTrack returns ISO timestamps (`1958-03-17T12:15:41.000Z`); the three catalogues
 * use plain dates. Left as-is, one row showed `1958-03-17T12:15:41.000Z` beside
 * `1958-03-17` and the comparison column became unreadable at four sources. The time
 * of day is not used anywhere, so it is dropped.
 */
function dateOnly(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  return m ? m[1]! : t;
}

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (t === "" || t.toUpperCase() === "NULL") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function txt(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === "" || t.toUpperCase() === "NULL" ? null : t;
}

/** One source's values for one object, keyed by canonical field name. */
type Row = Map<string, string | number | null>;

interface SourceLoad {
  id: string;
  label: string;
  rows: Map<number, Row>;
}

// ------------------------------------------------------------- loaders

function loadSpaceTrack(): SourceLoad {
  const rows = JSON.parse(readFileSync(newest("data/archive/space-track-satcat"), "utf8")) as Array<
    Record<string, string | null>
  >;
  const out = new Map<number, Row>();
  for (const r of rows) {
    const norad = Number(r.NORAD_CAT_ID);
    if (!Number.isFinite(norad)) continue;
    out.set(
      norad,
      new Map<string, string | number | null>([
        ["name", txt(r.SATNAME)],
        ["cospar_id", txt(r.INTLDES)],
        ["object_class", txt(r.OBJECT_TYPE)],
        ["country", txt(r.COUNTRY)],
        ["launch_site", txt(r.SITE)],
        ["launch_date", txt(r.LAUNCH)],
        ["decay_date", txt(r.DECAY)],
        ["inclination_deg", num(r.INCLINATION)],
        ["period_min", num(r.PERIOD)],
        ["apogee_km", num(r.APOGEE)],
        ["perigee_km", num(r.PERIGEE)],
        ["rcs_size", txt(r.RCS_SIZE)],
      ]),
    );
  }
  return { id: "spacetrack", label: "Space-Track（美国太空军）", rows: out };
}

function loadSpacebook(): SourceLoad {
  const text = readFileSync(newest("data/archive/spacebook-satcat-details-csv"), "utf8");
  const rows = parseCsv(text);
  const h = rows[0];
  const c = (n: string) => h.indexOf(n);
  const G = (r: string[], n: string) => txt(r[c(n)]);

  const out = new Map<number, Row>();
  for (const r of rows.slice(1)) {
    const norad = Number(r[c("NORAD Id")]);
    if (!Number.isFinite(norad)) continue;
    out.set(
      norad,
      new Map<string, string | number | null>([
        ["name", G(r, "Space-Track Name")],
        ["cospar_id", G(r, "Intl Desig")],
        ["mass_kg", num(r[c("COMSPOC Adopted Mass (kg)")])],
        ["hard_body_radius_m", num(r[c("COMSPOC HBR Mean (m)")])],
        ["cross_section_avg_m2", num(r[c("COMSPOC Cross Section Median (m^2)")])],
        ["span_m", num(r[c("COMSPOC Adopted Span (m)")])],
        ["diameter_m", num(r[c("COMSPOC Adopted Diameter (m)")])],
        ["ballistic_coefficient", num(r[c("COMSPOC Ballistic Coefficient")])],
        ["manufacturer", G(r, "GCAT Manufacturer")],
        ["bus", G(r, "GCAT Bus")],
        ["orbit_type", G(r, "GCAT OrbitType")],
        ["inclination_deg", num(r[c("GCAT Inclination (°)")])],
        ["decay_date", G(r, "GCAT DecayDate")],
        ["dry_mass_kg", num(r[c("GCAT DryMass (kg)")])],
        ["length_m", num(r[c("GCAT Length (m)")])],
      ]),
    );
  }
  return { id: "spacebook", label: "Spacebook（AGI/STK + ComSpoc）", rows: out };
}

/**
 * The analyst objects Spacebook tracks but never assigned a catalogue number.
 *
 * ## What these are
 *
 * When a sensor sees an object near a known one but cannot tie it to a catalogue
 * entry, the 18th Space Defense Squadron parks it on a provisional number in a high
 * reserved block — 270 000 and up in this capture — and calls it `N - Analyst Sat`.
 * They have real elements (period, inclination, apogee, perigee) and no
 * international designator, because nobody can say what launch they came from.
 *
 * ## Why they cannot be left out
 *
 * They appear in Spacebook's own conjunction reports and in public CDMs. A
 * catalogue that omits them will show a CDM naming an object the user cannot then
 * look up: the row was loaded into `satcat`, was counted in the coverage report,
 * and had no wide-table row to be found at. 429 objects in this capture.
 *
 * The values come from `satcat` rather than the archive's supplemental file: that
 * file keys its records by Spacebook UUID and carries no name, no NORAD id and no
 * elements, so it cannot be joined to a catalogue number at all. `satcat` is the
 * table that already has them joined, and is where the wide build reads from.
 *
 * ## Why the filter looks at the name and not just the number
 *
 * `satcat.source_snapshot` is the same string for all 72,310 rows, so it cannot
 * tell an analyst object from an ordinary one. The first version of this loader
 * filtered on `norad_id >= 270000`, which was wrong: analyst objects sit in three
 * separate provisional blocks, and that filter captured only one of them.
 *
 *   block      count   captured by `>= 270000`
 *   80000s       683   no   <- all missed
 *   270000s      401   yes
 *   290000s       28   no   <- all missed
 *
 * The result was 429 of 1,112 analyst objects in the wide table. The other 683
 * then appeared as "KeepTrack-only" objects named `UNKNOWN` or
 * `TBA - TO BE ASSIGNED`, because KeepTrack also holds them without a name while
 * Spacebook does hold `N - Analyst Sat` for each.
 *
 * All 1,112 rows whose name contains `Analyst Sat` are exactly the analyst objects:
 * verified that every such row has no international designator, and that no row
 * outside these three blocks has the name.
 */
function loadSpacebookSupplemental(): SourceLoad {
  const label = "Spacebook 分析目标";
  const out = new Map<number, Row>();
  const path = process.env.SPACE_SAFETY_DB ?? "data/catalogue.sqlite";
  if (!existsSync(path)) return { id: "sbsup", label, rows: out };

  const db = new Database(path, { readonly: true });
  const has = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='satcat'")
    .get() as { n: number };
  if (!has.n) {
    db.close();
    return { id: "sbsup", label, rows: out };
  }

  const rows = db
    .prepare(
      `SELECT norad_id, name, intl_id, object_type, owner, launch_site, launch_date,
              decay_date, period, inclination, apogee, perigee, rcs_size
         FROM satcat
        WHERE name LIKE '%Analyst Sat%'`,
    )
    .all() as Array<Record<string, unknown>>;
  db.close();

  for (const r of rows) {
    const norad = Number(r.norad_id);
    if (!Number.isFinite(norad) || norad <= 0) continue;
    out.set(norad, new Map<string, string | number | null>([
      ["name", txt(r.name as string)],
      ["cospar_id", txt(r.intl_id as string)],
      ["object_class", txt(r.object_type as string)],
      ["country", txt(r.owner as string)],
      ["launch_site", txt(r.launch_site as string)],
      ["launch_date", dateOnly(r.launch_date as string)],
      ["decay_date", dateOnly(r.decay_date as string)],
      ["period_min", num(String(r.period ?? ""))],
      ["inclination_deg", num(String(r.inclination ?? ""))],
      ["apogee_km", num(String(r.apogee ?? ""))],
      ["perigee_km", num(String(r.perigee ?? ""))],
      ["rcs_size", txt(r.rcs_size as string)],
    ]));
  }
  return { id: "sbsup", label, rows: out };
}

function loadDiscos(): SourceLoad {
  const doc = JSON.parse(readFileSync(newest("data/archive/discos-objects"), "utf8")) as {
    data: Array<{ attributes: Record<string, unknown> }>;
  };
  const out = new Map<number, Row>();
  for (const item of doc.data) {
    const a = item.attributes;
    // DISCOS carries 22 516 objects with no `satno` at all — recently launched
    // payloads it has catalogued before Space-Track assigned a number. `Number(null)`
    // is 0, so without this guard every one of them was written to NORAD 0 and
    // collapsed into a single nameless row.
    const raw = a.satno;
    if (raw === null || raw === undefined || String(raw).trim() === "") continue;
    const norad = Number(raw);
    if (!Number.isFinite(norad) || norad <= 0) continue;
    out.set(
      norad,
      new Map<string, string | number | null>([
        ["name", txt(a.name as string)],
        ["cospar_id", txt(a.cosparId as string)],
        ["object_class", txt(a.objectClass as string)],
        ["mass_kg", num(a.mass as string)],
        ["cross_section_avg_m2", num(a.xSectAvg as string)],
        ["cross_section_max_m2", num(a.xSectMax as string)],
        ["cross_section_min_m2", num(a.xSectMin as string)],
        ["shape", txt(a.shape as string)],
        ["span_m", num(a.span as string)],
        ["diameter_m", num(a.diameter as string)],
        ["decay_date", txt(a.predDecayDate as string)],
      ]),
    );
  }
  return { id: "discos", label: "ESA DISCOSweb（欧空局）", rows: out };
}

/**
 * KeepTrack, from the local table produced by `npm run keeptrack:sync`.
 *
 * Read from the database rather than the API: the sync archives the full response
 * and writes one row per object, so the wide build stays reproducible without a
 * network call and without depending on what the API returns today.
 */
function loadKeepTrack(): SourceLoad {
  const out = new Map<number, Row>();
  // Resolved from the project root, not the process cwd: this script is run both by
  // `npm run` (cwd = project root) and directly, and a relative path silently read an
  // empty file in the second case — producing a wide table with 24 039 KeepTrack
  // values in the report and none in the rows.
  const path = process.env.SPACE_SAFETY_DB ?? "data/catalogue.sqlite";
  if (!existsSync(path)) {
    console.log(`    （未找到 ${path}，跳过 KeepTrack）`);
    return { id: "keeptrack", label: "KeepTrack", rows: out };
  }
  const db = new Database(path, { readonly: true });
  const exists = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='keeptrack_object'")
    .get() as { n: number };
  if (!exists.n) {
    db.close();
    console.log(`    （${path} 中没有 keeptrack_object，先运行 npm run keeptrack:sync）`);
    return { id: "keeptrack", label: "KeepTrack", rows: out };
  }

  const rows = db
    .prepare(
      `SELECT norad_id AS noradId, name, manufacturer, bus, shape,
              launch_mass_kg AS mass, dry_mass_kg AS dryMass,
              length_m AS length, diameter_m AS diameter, span_m AS span,
              motor, owner, country, launch_date AS launchDate, source
         FROM keeptrack_object WHERE norad_id > 0`,
    )
    .all() as Array<Record<string, unknown>>;
  db.close();

  if (rows.length === 0) {
    console.log(`    （keeptrack_object 为 0 行，先运行 npm run keeptrack:sync）`);
    return { id: "keeptrack", label: "KeepTrack", rows: out };
  }

  for (const r of rows) {
    out.set(Number(r.noradId), new Map<string, string | number | null>([
      ["name", txt(r.name as string)],
      ["country", txt(r.country as string)],
      ["launch_date", dateOnly(r.launchDate)],
      ["mass_kg", num(String(r.mass ?? ""))],
      ["dry_mass_kg", num(String(r.dryMass ?? ""))],
      ["length_m", num(String(r.length ?? ""))],
      ["diameter_m", num(String(r.diameter ?? ""))],
      ["span_m", num(String(r.span ?? ""))],
      ["manufacturer", txt(r.manufacturer as string)],
      ["bus", txt(r.bus as string)],
      ["shape", txt(r.shape as string)],
    ]));
  }
  const withMfr = [...out.values()].filter((m) => m.get("manufacturer") !== null).length;
  console.log(`    KeepTrack 载入 ${out.size} 行，其中 ${withMfr} 行有制造商`);
  return { id: "keeptrack", label: "KeepTrack（keeptrack.space）", rows: out };
}

// ------------------------------------------------------------ default pick

/**
 * Our recommended source for a field, used only to pre-fill `__chosen`.
 *
 * The user may override any of these per object. The ordering is not "who is most
 * accurate" but "who has the standing to state this fact":
 * identity and catalogue orbit are Space-Track's, physical model is Spacebook's
 * (it is the only publisher of a hard-body radius), fine-grained debris provenance
 * is DISCOS'.
 */
const DEFAULT_PREFERENCE: Record<string, string[]> = {
  // Space-Track first, per the project rule that the US reference catalogue leads.
  // Spacebook's spelling is kept in its own column; the 110 objects Spacebook lacks
  // are the reason it cannot be first.
  name: ["spacetrack", "spacebook", "discos"],
  cospar_id: ["spacetrack", "discos", "spacebook"],
  // Space-Track is the US reference catalogue and the only source covering 100% of
  // records. DISCOS' 12-class vocabulary is finer and keeps its value in its own
  // column for anyone who needs the debris provenance, but it is not the default:
  // a catalogue that changes class depending on which source we picked is not a
  // reference catalogue.
  object_class: ["spacetrack", "discos", "spacebook"],
  country: ["spacetrack"],
  launch_site: ["spacetrack", "spacebook"],
  launch_date: ["spacetrack", "spacebook"],
  decay_date: ["spacetrack", "spacebook", "discos"],
  inclination_deg: ["spacetrack", "spacebook"],
  period_min: ["spacetrack"],
  apogee_km: ["spacetrack"],
  perigee_km: ["spacetrack"],
  rcs_size: ["spacetrack"],
  // Space-Track publishes no physical model at all (0 of 71 198 records), so it
  // cannot lead here. DISCOS' mass is instrumented, Spacebook's is an adopted
  // model value; they agree within 1% on all but 27 of 38 426 shared objects, so
  // taking DISCOS first means "measured where measured", and Spacebook supplies
  // the other 32 647.
  //
  // If you would rather have one model applied uniformly to all 71 074 objects
  // instead of a measured value on half of them, swap these two — the columns are
  // unchanged either way and nothing needs re-downloading.
  mass_kg: ["discos", "spacebook", "keeptrack"],
  hard_body_radius_m: ["spacebook"],
  cross_section_avg_m2: ["spacebook", "discos"],
  cross_section_max_m2: ["discos"],
  cross_section_min_m2: ["discos"],
  span_m: ["spacebook", "discos"],
  // KeepTrack first: it is the only source with diameter for most objects. Measured
  // on in-orbit objects, Spacebook supplies 12% and DISCOS 12%, while KeepTrack
  // supplies 59% and is the sole source for 17 379 objects (49%). Sourcing this
  // field from anything else leaves half the catalogue without a diameter.
  diameter_m: ["keeptrack", "spacebook", "discos"],
  ballistic_coefficient: ["spacebook"],
  shape: ["discos", "keeptrack"],
  manufacturer: ["spacebook"],
  bus: ["spacebook"],
  orbit_type: ["spacebook"],
  dry_mass_kg: ["spacebook"],
  length_m: ["spacebook"],
};

/** Every field the wide table carries, with its type. */
const FIELDS: Array<{ key: string; type: "text" | "real" }> = [
  { key: "name", type: "text" },
  { key: "cospar_id", type: "text" },
  { key: "object_class", type: "text" },
  { key: "country", type: "text" },
  { key: "launch_site", type: "text" },
  { key: "launch_date", type: "text" },
  { key: "decay_date", type: "text" },
  { key: "inclination_deg", type: "real" },
  { key: "period_min", type: "real" },
  { key: "apogee_km", type: "real" },
  { key: "perigee_km", type: "real" },
  { key: "rcs_size", type: "text" },
  { key: "mass_kg", type: "real" },
  { key: "hard_body_radius_m", type: "real" },
  { key: "cross_section_avg_m2", type: "real" },
  { key: "cross_section_max_m2", type: "real" },
  { key: "cross_section_min_m2", type: "real" },
  { key: "span_m", type: "real" },
  { key: "diameter_m", type: "real" },
  { key: "ballistic_coefficient", type: "real" },
  { key: "shape", type: "text" },
  { key: "manufacturer", type: "text" },
  { key: "bus", type: "text" },
  { key: "orbit_type", type: "text" },
  { key: "dry_mass_kg", type: "real" },
  { key: "length_m", type: "real" },
];

const SOURCES = ["spacetrack", "spacebook", "discos", "keeptrack", "sbsup"] as const;

/**
 * Spacebook columns that carry its placeholder triplet.
 *
 * Only the fields that form the triplet are cleared. `name`, `manufacturer` and the
 * launch record are not defaults and stay as they are.
 */
const PLACEHOLDER_FIELDS = new Set([
  "mass_kg",
  "dry_mass_kg",
  "hard_body_radius_m",
  "cross_section_avg_m2",
  "span_m",
  "diameter_m",
  "length_m",
  "ballistic_coefficient",
]);

/**
 * Is this a round number that stands in for "unknown"?
 *
 * Both Spacebook and KeepTrack fill physical quantities on debris with small
 * integers: measured on the KeepTrack-only values, mass is 1.0 (66 objects), 10.0,
 * 2.0, 5.0, 100.0; span is 1.0 (60), 0.1, 1.5; dry mass is 1.0 (70). No object is
 * exactly 1.0 m long and 1.0 kg heavy by measurement — these are defaults.
 *
 * A real measurement is essentially never a single significant digit, so values that
 * are 1, 2, 5, 10, 100 and similar are treated as absent **for debris only**. For a
 * payload a round mass is plausible (a 100 kg microsat), and clearing it would throw
 * away real data.
 */
function isRoundPlaceholder(v: number | null, isDebris: boolean): boolean {
  if (v === null || !isDebris) return false;
  return v === 1 || v === 2 || v === 5 || v === 10 || v === 20 || v === 100;
}

function main(): void {
  const st = loadSpaceTrack();
  const sb = loadSpacebook();
  const ds = loadDiscos();
  const kt = loadKeepTrack();
  const sbs = loadSpacebookSupplemental();
  const all = [st, sb, ds, kt, sbs];

  console.log("\n读取原始数据\n");
  for (const s of all) console.log(`  ${s.label.padEnd(30)} ${s.rows.size} 条`);

  // Every object any source knows about, not every object the first three know.
  // KeepTrack was missing from this set, which silently dropped the 1,837 objects
  // only KeepTrack had — they were loaded, counted in this script's own coverage
  // report, and then never written as a row. Those are exactly the objects a user
  // could not find in the catalogue: one source had them, the wide table did not.
  const universe = new Set<number>([
    ...st.rows.keys(),
    ...sb.rows.keys(),
    ...ds.rows.keys(),
    ...kt.rows.keys(),
    ...sbs.rows.keys(),
  ]);
  console.log(`\n  并集 ${universe.size}\n`);

  // ---------------------------------------------------------- build rows
  interface WideRow {
    norad_id: number;
    values: Record<string, Record<string, string | number | null>>;
    chosen: Record<string, string | null>;
  }

  const rows: WideRow[] = [];
  const conflictStats = new Map<string, { both: number; diff: number }>();

  for (const norad of [...universe].sort((a, b) => a - b)) {
    const values: Record<string, Record<string, string | number | null>> = {};
    const chosen: Record<string, string | null> = {};

    /**
     * Spacebook's placeholder for an object it has no physical model for.
     *
     * Measured: 31 879 debris objects share exactly mass 5 kg, hard-body radius 5 m
     * and span 10 m. A real fragment is not 5 kg and 10 m wide; 13 024 of them are
     * still in orbit. Leaving it in the mass column would put a fabricated value into
     * 32 410 rows, and any consumer computing a collision cross-section would use it
     * as if it were measured.
     *
     * The value is cleared rather than flagged in place: a cleared cell correctly
     * reads as "no value", while a flagged cell still invites a consumer to use it.
     */
    const sbValues = sb.rows.get(norad);
    const spacebookPlaceholder =
      sbValues !== undefined &&
      sbValues.get("mass_kg") === 5 &&
      sbValues.get("hard_body_radius_m") === 5;

    // KeepTrack fills debris physical quantities with round defaults too; see
    // isRoundPlaceholder. Applies only to debris so a genuinely round payload mass
    // (a 100 kg microsat) survives.
    const isDebris = st.rows.get(norad)?.get("object_class") === "DEBRIS";
    const ktValues = kt.rows.get(norad);

    for (const { key } of FIELDS) {
      values[key] = {};
      const present: string[] = [];
      for (const s of all) {
        let v = s.rows.get(norad)?.get(key) ?? null;
        if (spacebookPlaceholder && s.id === "spacebook" && PLACEHOLDER_FIELDS.has(key)) v = null;
        if (
          s.id === "keeptrack" &&
          typeof v === "number" &&
          isRoundPlaceholder(v, isDebris) &&
          (key === "mass_kg" || key === "dry_mass_kg" || key === "span_m" || key === "length_m")
        ) {
          v = null;
        }
        values[key][s.id] = v;
        if (v !== null && v !== "") present.push(s.id);
      }
      void ktValues;

      // Default choice: the first source in the preference list that actually has
      // a value. Left null when no source has one — the cell is genuinely unknown,
      // and inventing a value would be worse than showing a gap.
      const pref = DEFAULT_PREFERENCE[key] ?? SOURCES;
      chosen[key] = pref.find((id) => present.includes(id)) ?? present[0] ?? null;

      // Record where the sources disagree, for the report.
      if (present.length >= 2) {
        const vals = present.map((id) => values[key][id]);
        const distinct = new Set(vals.map((v) => (typeof v === "number" ? v.toFixed(6) : String(v))));
        const stat = conflictStats.get(key) ?? { both: 0, diff: 0 };
        stat.both += 1;
        if (distinct.size > 1) stat.diff += 1;
        conflictStats.set(key, stat);
      }
    }

    rows.push({ norad_id: norad, values, chosen });
  }

  // ---------------------------------------------------------- write sqlite
  const out = "data/catalogue-wide.sqlite";
  const db = new Database(out);
  db.pragma("journal_mode = DELETE");

  const cols: string[] = ["norad_id INTEGER PRIMARY KEY"];
  for (const f of FIELDS) {
    for (const s of SOURCES) cols.push(`${f.key}__${s} ${f.type === "real" ? "REAL" : "TEXT"}`);
    cols.push(`${f.key}__chosen TEXT`);
  }
  db.exec(`DROP TABLE IF EXISTS catalogue_wide; CREATE TABLE catalogue_wide (\n  ${cols.join(",\n  ")}\n);`);

  const allCols = FIELDS.flatMap((f) => [...SOURCES.map((s) => `${f.key}__${s}`), `${f.key}__chosen`]);
  const insert = db.prepare(
    `INSERT INTO catalogue_wide (norad_id, ${allCols.join(",")}) VALUES (${Array(allCols.length + 1).fill("?").join(",")})`,
  );

  const tx = db.transaction((batch: WideRow[]) => {
    for (const r of batch) {
      const vals: unknown[] = [r.norad_id];
      for (const f of FIELDS) {
        for (const s of SOURCES) vals.push(r.values[f.key]![s] ?? null);
        vals.push(r.chosen[f.key] ?? null);
      }
      insert.run(...vals);
    }
  });
  for (let i = 0; i < rows.length; i += 2000) tx(rows.slice(i, i + 2000));

  db.exec("CREATE INDEX IF NOT EXISTS wide_name_st ON catalogue_wide(name__spacetrack)");
  db.close();

  const size = statSync(out).size;
  console.log(`  写出 ${out}  ${(size / 1e6).toFixed(1)} MB  ${rows.length} 行`);
  console.log(`  列数 ${1 + allCols.length}\n`);

  // ------------------------------------------------------------- report
  console.log("  字段覆盖（三源 / 默认选择来源）\n");
  console.log(`  ${"字段".padEnd(24)} ${"ST".padStart(7)} ${"SB".padStart(7)} ${"DS".padStart(7)}   默认来源`);
  console.log(`  ${"─".repeat(70)}`);
  for (const { key } of FIELDS) {
    const n = (id: string) => rows.filter((r) => r.values[key]![id] !== null && r.values[key]![id] !== "").length;
    const dflt = DEFAULT_PREFERENCE[key]?.[0] ?? "—";
    console.log(
      `  ${key.padEnd(24)} ${String(n("spacetrack")).padStart(7)} ${String(n("spacebook")).padStart(7)} ${String(n("discos")).padStart(7)}   ${dflt}`,
    );
  }

  console.log("\n  三源数值不一致统计\n");
  console.log(`  ${"字段".padEnd(24)} ${"多源都有".padStart(10)} ${"不一致".padStart(9)} ${"占比".padStart(9)}`);
  console.log(`  ${"─".repeat(56)}`);
  for (const { key } of FIELDS) {
    const s = conflictStats.get(key);
    if (!s) continue;
    console.log(
      `  ${key.padEnd(24)} ${String(s.both).padStart(10)} ${String(s.diff).padStart(9)} ${((s.diff / s.both) * 100).toFixed(2).padStart(8)}%`,
    );
  }

  // A sample row, so the shape is visible without opening the file.
  const sample = rows.find((r) => r.norad_id === 44713) ?? rows[0]!;
  console.log(`\n  样例行（NORAD ${sample.norad_id}）\n`);
  console.log(`  ${"字段".padEnd(24)} ${"Space-Track".padStart(18)} ${"Spacebook".padStart(18)} ${"DISCOS".padStart(16)}   采用`);
  for (const { key } of FIELDS) {
    const v = sample.values[key]!;
    const fmt = (x: unknown) => (x === null || x === undefined || x === "" ? "—" : String(x).slice(0, 17));
    if (v.spacetrack === null && v.spacebook === null && v.discos === null) continue;
    console.log(
      `  ${key.padEnd(24)} ${fmt(v.spacetrack).padStart(18)} ${fmt(v.spacebook).padStart(18)} ${fmt(v.discos).padStart(16)}   ${sample.chosen[key] ?? "—"}`,
    );
  }

  // Percentages for the written report.
  writeFileSync(
    "data/catalogue-wide-stats.json",
    JSON.stringify(
      {
        objects: rows.length,
        fields: Object.fromEntries(
          [...conflictStats].map(([k, v]) => [k, v]),
        ),
      },
      null,
      2,
    ),
  );

  console.log("");
}

main();
