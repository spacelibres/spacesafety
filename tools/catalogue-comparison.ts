/**
 * Field-by-field comparison of the four catalogue sources.
 *
 * ## Why this exists
 *
 * The wide table shows four sources side by side, but "who is best for this field"
 * was decided from spot checks. This measures it: for every catalogued object, does
 * each source have a value, is it in orbit, and do the ones with values agree.
 *
 * ## What "agree" is measured on
 *
 * Only objects all sources describe, and only where the comparison is meaningful:
 *
 *   text    case-insensitive, punctuation-insensitive equality
 *   number  within a tolerance that depends on the field — an inclination to 0.5°,
 *           a mass within 1% (below that, both are rounding)
 *   date    same calendar day
 *
 * A field where sources disagree is not an error to be fixed; it is the reason the
 * wide table keeps all four.
 *
 * Run: npx tsx tools/catalogue-comparison.ts
 */

import Database from "better-sqlite3";

const DB = process.env.SPACE_SAFETY_DB ?? "data/catalogue.sqlite";

interface SourceField {
  /** Column name per source; missing means the source cannot supply it. */
  spacetrack?: string;
  spacebook?: string;
  spacebookPhysics?: string;
  spacebookLaunch?: string;
  discos?: string;
  keeptrack?: string;
}

/** Every catalogue field, and the column each source exposes it under. */
const FIELDS: Array<{ name: string; kind: "text" | "num" | "date"; tol?: number } & SourceField> = [
  { name: "名称", kind: "text", spacetrack: "sat_name", spacebook: "name", discos: "name", keeptrack: "name" },
  { name: "COSPAR", kind: "text", spacetrack: "intl_des", spacebook: "intl_id", discos: "cospar_id", keeptrack: "cospar_id" },
  { name: "目标分类", kind: "text", spacetrack: "object_type", spacebook: "object_type", discos: "object_class" },
  { name: "发射国", kind: "text", spacetrack: "country", keeptrack: "country" },
  { name: "发射场", kind: "text", spacetrack: "site", spacebook: "launch_site", keeptrack: "launch_site" },
  { name: "发射日期", kind: "date", spacetrack: "launch", spacebook: "launch_date", spacebookLaunch: "launch_date", keeptrack: "launch_date" },
  { name: "再入日期", kind: "date", spacetrack: "decay", spacebook: "decay_date", spacebookLaunch: "decay_date", discos: "pred_decay_date" },
  { name: "倾角", kind: "num", tol: 0.5, spacetrack: "inclination_deg", spacebook: "inclination", spacebookLaunch: "inclination_deg" },
  { name: "周期", kind: "num", tol: 0.5, spacetrack: "period_min", spacebook: "period" },
  { name: "远地点", kind: "num", tol: 20, spacetrack: "apogee_km", spacebook: "apogee", spacebookLaunch: "apogee_km" },
  { name: "近地点", kind: "num", tol: 20, spacetrack: "perigee_km", spacebook: "perigee", spacebookLaunch: "perigee_km" },
  { name: "RCS", kind: "text", spacetrack: "rcs_size", spacebook: "rcs_size" },
  { name: "质量", kind: "num", tol: 0.01, spacebookPhysics: "adopted_mass_kg", spacebookLaunch: "mass_kg", discos: "mass", keeptrack: "launch_mass_kg" },
  { name: "干重", kind: "num", tol: 0.01, spacebookLaunch: "dry_mass_kg", keeptrack: "dry_mass_kg" },
  { name: "硬体半径", kind: "num", tol: 0.01, spacebookPhysics: "hbr_mean_m" },
  { name: "横截面积", kind: "num", tol: 0.05, spacebookPhysics: "cross_section_median_m2", discos: "x_sect_avg" },
  { name: "翼展", kind: "num", tol: 0.05, spacebookPhysics: "adopted_span_m", spacebookLaunch: "span_m", discos: "span", keeptrack: "span_m" },
  { name: "直径", kind: "num", tol: 0.05, spacebookPhysics: "adopted_diameter_m", spacebookLaunch: "diameter_m", discos: "diameter", keeptrack: "diameter_m" },
  { name: "长度", kind: "num", tol: 0.05, spacebookLaunch: "length_m", keeptrack: "length_m" },
  { name: "弹道系数", kind: "num", tol: 0.05, spacebookPhysics: "ballistic_coefficient" },
  { name: "形状", kind: "text", spacebookLaunch: "shape", discos: "shape", keeptrack: "shape" },
  { name: "制造商", kind: "text", spacebookLaunch: "manufacturer", keeptrack: "manufacturer" },
  { name: "平台型号", kind: "text", spacebookLaunch: "bus", keeptrack: "bus" },
  { name: "轨道类型", kind: "text", spacebookLaunch: "orbit_type" },
  { name: "发动机", kind: "text", spacebookLaunch: "motor", keeptrack: "motor" },
  // `owner` is deliberately absent: Spacebook's value is a state (`US`) and GCAT's
  // is an operating agency (`SPXS`, `CASC`). They measure different things, so a low
  // agreement rate here is expected and says nothing about data quality.
  { name: "所有者", kind: "text", spacebook: "owner", spacebookLaunch: "owner", keeptrack: "owner" },
];

/** Source ids in display order. */
const SOURCES = ["spacetrack", "spacebook", "spacebookPhysics", "spacebookLaunch", "discos", "keeptrack"] as const;
type SourceKey = (typeof SOURCES)[number];

const LABEL: Record<SourceKey, string> = {
  spacetrack: "Space-Track",
  spacebook: "Spacebook",
  spacebookPhysics: "SB-ComSpoc",
  spacebookLaunch: "SB-GCAT",
  discos: "DISCOS",
  keeptrack: "KeepTrack",
};

function normText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v)
    .toLowerCase()
    .replace(/[_\-\s]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
  return s === "" ? null : s;
}

/**
 * Date to `YYYY-MM-DD`.
 *
 * Space-Track and DISCOS write ISO; GCAT writes `1957 Oct  4` and `2024 Oct  2 1930?`
 * (a trailing `?` marks an uncertain date). Accepting only ISO made every GCAT date
 * fail to compare and reported a 0% agreement on launch date — a parser limitation
 * that looks exactly like a data conflict.
 */
function dateOnly(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "") return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const gcat = /^(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})/.exec(t);
  if (gcat) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const m = months.indexOf(gcat[2]!.toLowerCase());
    if (m >= 0) {
      return `${gcat[1]}-${String(m + 1).padStart(2, "0")}-${gcat[3]!.padStart(2, "0")}`;
    }
  }
  return null;
}

function numOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "" || t === "0" || t === "0.0") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Is this row one of Spacebook's placeholder rows?
 *
 * 31 879 debris objects carry exactly mass 5 kg, hard-body radius 5 m and span 10 m.
 * The value is the source's "no model" default, and including it makes every
 * comparison against another source report a conflict that does not exist: GCAT
 * correctly has `0` (no mass) for those objects, so the pair "disagrees" 31 373
 * times.
 */
function isPlaceholderRow(r: Record<string, unknown> | undefined): boolean {
  if (!r) return false;
  return numOf(r.adopted_mass_kg) === 5 && numOf(r.hbr_mean_m) === 5;
}

function agrees(a: unknown, b: unknown, kind: "text" | "num" | "date", tol = 0.01): boolean {
  if (kind === "text") return normText(a) === normText(b);
  if (kind === "date") return dateOnly(a) === dateOnly(b);
  const x = numOf(a);
  const y = numOf(b);
  if (x === null || y === null) return false;
  if (tol <= 0.05) return Math.abs(x - y) / Math.max(x, y) <= tol;
  return Math.abs(x - y) <= tol;
}

function pct(n: number, of: number): string {
  return of === 0 ? "—" : `${((n / of) * 100).toFixed(1)}%`;
}

function main(): void {
  const db = new Database(DB, { readonly: true });

  const has = (t: string) =>
    (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(t) as {
      n: number;
    }).n > 0;

  const tables: Record<SourceKey, string | null> = {
    spacetrack: has("space_track_satcat") ? "space_track_satcat" : null,
    spacebook: has("satcat") ? "satcat" : null,
    spacebookPhysics: has("object_physics") ? "object_physics" : null,
    spacebookLaunch: has("object_launch_info") ? "object_launch_info" : null,
    discos: has("discos_objects") ? "discos_objects" : null,
    keeptrack: has("keeptrack_object") ? "keeptrack_object" : null,
  };

  // Load each source into memory keyed by NORAD: ~72k rows × 6 sources is small.
  const data = {} as Record<SourceKey, Map<number, Record<string, unknown>>>;
  for (const s of SOURCES) {
    const table = tables[s];
    const m = new Map<number, Record<string, unknown>>();
    if (table) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        const id = Number(r.norad_id);
        if (Number.isInteger(id) && id > 0) m.set(id, r);
      }
    }
    data[s] = m;
  }
  db.close();

  const universe = new Set<number>();
  for (const s of SOURCES) for (const id of data[s].keys()) universe.add(id);

  // In orbit = Space-Track has no decay date, or the best available source does not.
  const inOrbit = (id: number): boolean => {
    const st = data.spacetrack.get(id);
    if (st) return dateOnly(st.decay) === null;
    for (const s of ["spacebook", "discos", "keeptrack"] as SourceKey[]) {
      const r = data[s].get(id);
      if (r) return dateOnly(s === "discos" ? r.pred_decay_date : r.decay_date) === null;
    }
    return true;
  };

  const alive = [...universe].filter(inOrbit);

  console.log(`\n  四源编目对比  (${DB})\n`);
  console.log(`  对象并集        ${String(universe.size).padStart(7)}`);
  console.log(`  在轨            ${String(alive.length).padStart(7)}`);
  for (const s of SOURCES) {
    console.log(`    ${LABEL[s].padEnd(12)} ${String(data[s].size).padStart(7)}  ${pct(data[s].size, universe.size)}`);
  }

  // ------------------------------------------------------- coverage table
  console.log(`\n  ── 字段覆盖（在轨 ${alive.length} 个对象） ──\n`);
  const header = SOURCES.map((s) => LABEL[s].padStart(11)).join("");
  console.log(`  ${"字段".padEnd(12)}${header}   最佳`);

  const recommendations: Array<{ field: string; best: string; reason: string }> = [];

  for (const f of FIELDS) {
    const counts = SOURCES.map((s) => {
      const col = f[s];
      if (!col) return 0;
      let n = 0;
      for (const id of alive) {
        const r = data[s].get(id);
        if (!r) continue;
        if (s === "spacebookPhysics" && isPlaceholderRow(r)) continue;
        if (r[col] !== null && r[col] !== undefined && r[col] !== "") n += 1;
      }
      return n;
    });
    const cells = counts.map((n) => (n === 0 ? "—" : pct(n, alive.length)).padStart(11)).join("");
    const bestIdx = counts.indexOf(Math.max(...counts));
    const best = counts[bestIdx]! > 0 ? LABEL[SOURCES[bestIdx]!] : "—";
    console.log(`  ${f.name.padEnd(12)}${cells}   ${best}`);
    if (counts[bestIdx]! > 0) {
      recommendations.push({
        field: f.name,
        best,
        reason: `${pct(counts[bestIdx]!, alive.length)} 覆盖`,
      });
    }
  }

  // ------------------------------------------------------------ agreement
  console.log(`\n  ── 多源一致性（仅统计两源都有值且都能比较的对象） ──\n`);
  console.log(`  ${"字段".padEnd(12)} ${"对比".padEnd(28)} 共同   一致   一致率`);

  for (const f of FIELDS) {
    const present = SOURCES.filter((s) => f[s]);
    for (let i = 0; i < present.length; i += 1) {
      for (let j = i + 1; j < present.length; j += 1) {
        const a = present[i]!;
        const b = present[j]!;
        const ca = f[a]!;
        const cb = f[b]!;
        let common = 0;
        let same = 0;
        for (const id of alive) {
          const ra = data[a].get(id);
          const rb = data[b].get(id);
          if (!ra || !rb) continue;
          if ((a === "spacebookPhysics" && isPlaceholderRow(ra)) || (b === "spacebookPhysics" && isPlaceholderRow(rb))) {
            continue;
          }
          const va = ra[ca];
          const vb = rb[cb];
          const hasA = va !== null && va !== undefined && va !== "";
          const hasB = vb !== null && vb !== undefined && vb !== "";
          if (!hasA || !hasB) continue;
          common += 1;
          if (agrees(va, vb, f.kind, f.tol)) same += 1;
        }
        // Only report pairs with enough overlap to be meaningful.
        if (common < 100) continue;
        const rate = (same / common) * 100;
        if (rate < 95) {
          console.log(
            `  ${f.name.padEnd(12)} ${`${LABEL[a]} vs ${LABEL[b]}`.padEnd(28)} ${String(common).padStart(6)} ${String(same).padStart(6)}   ${rate.toFixed(2)}%`,
          );
        }
      }
    }
  }

  // --------------------------------------------------------- recommended
  console.log(`\n  ── 每字段覆盖率最高的源 ──\n`);
  for (const r of recommendations) {
    console.log(`  ${r.field.padEnd(12)} ${r.best.padEnd(14)} ${r.reason}`);
  }
  console.log("");
}

main();
