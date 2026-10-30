/**
 * How much does KeepTrack actually add?
 *
 * ## The question this answers
 *
 * Adding a fourth source to a wide table is not free: every field gets another
 * column, the comparison view gets wider, and every reader has one more value to
 * weigh. The justification is that KeepTrack covers something the others do not —
 * but that has to be measured, not asserted.
 *
 * Three numbers per field:
 *
 *   already  every primary source has it anyway  → KeepTrack adds nothing
 *   unique   only KeepTrack has it               → the real contribution
 *   better   a primary source has it, KeepTrack also, but KeepTrack covers more
 *
 * Run: npx tsx tools/keeptrack-contribution.ts
 */

import Database from "better-sqlite3";

const DB = process.env.SPACE_SAFETY_DB ?? "data/catalogue-wide.sqlite";

/** Wide-table field → the sources that could supply it. */
const FIELDS: Array<{ field: string; primaries: string[] }> = [
  { field: "name", primaries: ["spacetrack", "spacebook", "discos"] },
  { field: "cospar_id", primaries: ["spacetrack", "spacebook", "discos"] },
  { field: "object_class", primaries: ["spacetrack", "discos"] },
  { field: "country", primaries: ["spacetrack"] },
  { field: "launch_site", primaries: ["spacetrack", "spacebook"] },
  { field: "launch_date", primaries: ["spacetrack", "spacebook"] },
  { field: "decay_date", primaries: ["spacetrack", "spacebook", "discos"] },
  { field: "inclination_deg", primaries: ["spacetrack", "spacebook"] },
  { field: "period_min", primaries: ["spacetrack", "spacebook"] },
  { field: "apogee_km", primaries: ["spacetrack", "spacebook"] },
  { field: "perigee_km", primaries: ["spacetrack", "spacebook"] },
  { field: "rcs_size", primaries: ["spacetrack", "spacebook"] },
  { field: "mass_kg", primaries: ["spacebook", "discos"] },
  { field: "hard_body_radius_m", primaries: ["spacebook"] },
  { field: "cross_section_avg_m2", primaries: ["spacebook", "discos"] },
  { field: "span_m", primaries: ["spacebook", "discos"] },
  { field: "diameter_m", primaries: ["spacebook", "discos"] },
  { field: "ballistic_coefficient", primaries: ["spacebook"] },
  { field: "shape", primaries: ["discos"] },
  { field: "manufacturer", primaries: ["spacebook"] },
  { field: "bus", primaries: ["spacebook"] },
  { field: "orbit_type", primaries: ["spacebook"] },
  { field: "dry_mass_kg", primaries: ["spacebook"] },
  { field: "length_m", primaries: ["spacebook"] },
];

function main(): void {
  const db = new Database(DB, { readonly: true });

  // In orbit only: a re-entered object's physical model has no use, so counting them
  // would inflate every coverage figure with rows nobody will look at.
  const rows = db
    .prepare(
      `SELECT * FROM catalogue_wide WHERE decay_date__spacetrack IS NULL`,
    )
    .all() as Array<Record<string, unknown>>;
  db.close();

  const n = rows.length;
  console.log(`\n  KeepTrack 对编目的实际贡献  (在轨 ${n} 个对象)\n`);

  const has = (r: Record<string, unknown>, key: string): boolean => {
    const v = r[key];
    return v !== null && v !== undefined && v !== "";
  };

  console.log(`  ${"字段".padEnd(22)} ${"主源已有".padStart(9)} ${"KT 独有".padStart(9)} ${"KT 补充".padStart(9)}  判定`);

  let totalUnique = 0;
  let usefulFields = 0;

  for (const f of FIELDS) {
    let primariesHave = 0;
    let ktOnly = 0;
    let ktAdds = 0;

    for (const r of rows) {
      const kt = has(r, `${f.field}__keeptrack`);
      const anyPrimary = f.primaries.some((p) => has(r, `${f.field}__${p}`));
      if (anyPrimary) primariesHave += 1;
      if (kt && !anyPrimary) ktOnly += 1;
      if (kt && anyPrimary) ktAdds += 1;
    }

    totalUnique += ktOnly;
    const pctU = ((ktOnly / n) * 100).toFixed(2);
    let verdict = "无贡献";
    if (ktOnly / n > 0.001) {
      verdict = `★ 独有 ${pctU}%`;
      usefulFields += 1;
    } else if (ktAdds > 0) {
      verdict = "仅交叉验证";
    }

    console.log(
      `  ${f.field.padEnd(22)} ${String(primariesHave).padStart(9)} ${String(ktOnly).padStart(9)} ${String(ktAdds).padStart(9)}  ${verdict}`,
    );
  }

  console.log(`\n  合计：${usefulFields} 个字段有独有贡献，共 ${totalUnique} 个字段值\n`);

  // Which objects does KeepTrack alone describe?
  const ktOnlyObjects = rows.filter(
    (r) => !has(r, "name__spacetrack") && !has(r, "name__spacebook") && has(r, "name__keeptrack"),
  );
  console.log(`  KeepTrack 唯一提供名称的对象：${ktOnlyObjects.length}`);
  for (const r of ktOnlyObjects.slice(0, 5)) {
    console.log(`    ${r.norad_id}  ${r.name__keeptrack}`);
  }
  console.log("");
}

main();
