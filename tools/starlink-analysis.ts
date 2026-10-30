/**
 * Starlink-focused catalogue analysis.
 *
 * ## Why a separate, narrower report
 *
 * The whole-catalogue figures average Starlink in with 60 000 other objects, most
 * of them dead debris from the 1960s. Starlink is 11 163 of 35 460 objects in
 * orbit — 31.5% — and it is the entire point of this platform: it is the
 * constellation whose safety record we are trying to reproduce. A source that
 * covers 60% of the catalogue but 40% of Starlink is not good enough, and the
 * average hides that.
 *
 * Run: npx tsx tools/starlink-analysis.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

function num(v: string | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  if (t === "" || t.toUpperCase() === "NULL") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

interface Obj {
  norad: number;
  name: string;
  decayed: boolean;
  fields: Map<string, number | string | null>;
}

function pct(n: number, of: number): string {
  return of === 0 ? "—" : `${((n / of) * 100).toFixed(2)}%`;
}

// -------------------------------------------------------------- loaders

function loadSpaceTrack(): Map<number, Obj> {
  const rows = JSON.parse(readFileSync(newest("data/archive/space-track-satcat"), "utf8")) as Array<
    Record<string, string | null>
  >;
  const out = new Map<number, Obj>();
  for (const r of rows) {
    const norad = Number(r.NORAD_CAT_ID);
    if (!Number.isFinite(norad)) continue;
    out.set(norad, {
      norad,
      name: r.SATNAME ?? "",
      decayed: Boolean((r.DECAY ?? "").trim()),
      fields: new Map<string, number | string | null>([
        ["name", r.SATNAME],
        ["cospar", r.INTLDES],
        ["class", r.OBJECT_TYPE],
        ["country", r.COUNTRY],
        ["site", r.SITE],
        ["launch", r.LAUNCH],
        ["decay", r.DECAY],
        ["inclination", num(r.INCLINATION)],
        ["period", num(r.PERIOD)],
        ["apogee", num(r.APOGEE)],
        ["perigee", num(r.PERIGEE)],
        ["rcs_size", r.RCS_SIZE],
      ]),
    });
  }
  return out;
}

function loadSpacebook(): Map<number, Obj> {
  const text = readFileSync(newest("data/archive/spacebook-satcat-details-csv"), "utf8");
  const rows = parseCsv(text);
  const h = rows[0];
  const c = (name: string) => h.indexOf(name);
  const iN = c("NORAD Id");
  const iName = c("Space-Track Name");
  const iDesig = c("Intl Desig");
  const iMass = c("COMSPOC Adopted Mass (kg)");
  const iHbr = c("COMSPOC HBR Mean (m)");
  const iXsec = c("COMSPOC Cross Section Median (m^2)");
  const iSpan = c("COMSPOC Adopted Span (m)");
  const iBc = c("COMSPOC Ballistic Coefficient");
  const iMan = c("GCAT Manufacturer");
  const iBus = c("GCAT Bus");
  const iOrbit = c("GCAT OrbitType");
  const iInc = c("GCAT Inclination (°)");
  const iDecay = c("GCAT DecayDate");

  const out = new Map<number, Obj>();
  for (const r of rows.slice(1)) {
    const norad = Number(r[iN]);
    if (!Number.isFinite(norad)) continue;
    out.set(norad, {
      norad,
      name: r[iName] ?? "",
      decayed: Boolean((r[iDecay] ?? "").trim()),
      fields: new Map<string, number | string | null>([
        ["name", r[iName] || null],
        ["cospar", r[iDesig] || null],
        ["mass", num(r[iMass])],
        ["hbr", num(r[iHbr])],
        ["xsec", num(r[iXsec])],
        ["span", num(r[iSpan])],
        ["bc", num(r[iBc])],
        ["manufacturer", r[iMan] || null],
        ["bus", r[iBus] || null],
        ["orbit_type", r[iOrbit] || null],
        ["inclination", num(r[iInc])],
      ]),
    });
  }
  return out;
}

function loadDiscos(): Map<number, Obj> {
  const doc = JSON.parse(readFileSync(newest("data/archive/discos-objects"), "utf8")) as {
    data: Array<{ attributes: Record<string, unknown> }>;
  };
  const out = new Map<number, Obj>();
  for (const item of doc.data) {
    const a = item.attributes;
    const norad = Number(a.satno);
    if (!Number.isFinite(norad)) continue;
    const pos = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    out.set(norad, {
      norad,
      name: String(a.name ?? ""),
      decayed: Boolean(a.predDecayDate),
      fields: new Map<string, number | string | null>([
        ["name", (a.name as string) ?? null],
        ["cospar", (a.cosparId as string) ?? null],
        ["class", (a.objectClass as string) ?? null],
        ["mass", pos(a.mass)],
        ["xsec", pos(a.xSectAvg)],
        ["shape", (a.shape as string) ?? null],
        ["span", pos(a.span)],
        ["diameter", pos(a.diameter)],
      ]),
    });
  }
  return out;
}

// -------------------------------------------------------------- analysis

function main(): void {
  const st = loadSpaceTrack();
  const sb = loadSpacebook();
  const ds = loadDiscos();

  // Starlink is defined by the Space-Track name, which is the operator's own
  // naming (`STARLINK-1007`). DISCOS and GCAT both spell it `Starlink 1007`, so
  // matching on a lower-cased prefix catches all three.
  const isStarlink = (name: string | null): boolean =>
    /^starlink/i.test((name ?? "").replace(/^starlink[-_ ]?/i, "starlink-"));

  const slNorads = new Set<number>();
  for (const [norad, o] of st) if (isStarlink(o.name)) slNorads.add(norad);
  for (const [norad, o] of sb) if (isStarlink(o.name)) slNorads.add(norad);
  for (const [norad, o] of ds) if (isStarlink(o.name)) slNorads.add(norad);

  // "In orbit" is Space-Track's DECAY, the observed re-entry, when it has the
  // object; otherwise the source that does.
  const alive = [...slNorads].filter((n) => {
    const o = st.get(n) ?? sb.get(n) ?? ds.get(n);
    return o ? !o.decayed : true;
  });
  const decayed = slNorads.size - alive.length;

  console.log(`\n=== Starlink 编目规模 ===\n`);
  console.log(`  Starlink 对象        ${String(slNorads.size).padStart(6)}`);
  console.log(`    在轨               ${String(alive.length).padStart(6)}`);
  console.log(`    已再入             ${String(decayed).padStart(6)}`);
  console.log(`  占全部在轨对象       ${pct(alive.length, 35460)}`);

  const srcCount = (src: Map<number, Obj>) => alive.filter((n) => src.has(n)).length;
  console.log(`\n  在轨 Starlink 在三源的覆盖：`);
  console.log(`    Space-Track        ${String(srcCount(st)).padStart(6)}  ${pct(srcCount(st), alive.length)}`);
  console.log(`    Spacebook          ${String(srcCount(sb)).padStart(6)}  ${pct(srcCount(sb), alive.length)}`);
  console.log(`    ESA DISCOS         ${String(srcCount(ds)).padStart(6)}  ${pct(srcCount(ds), alive.length)}`);

  // ------------------------------------------------- field coverage
  const fields: Array<{ label: string; key: string }> = [
    { label: "名称", key: "name" },
    { label: "COSPAR", key: "cospar" },
    { label: "目标分类", key: "class" },
    { label: "发射国", key: "country" },
    { label: "发射场", key: "site" },
    { label: "发射日期", key: "launch" },
    { label: "质量", key: "mass" },
    { label: "硬体半径", key: "hbr" },
    { label: "横截面积", key: "xsec" },
    { label: "翼展", key: "span" },
    { label: "弹道系数", key: "bc" },
    { label: "形状", key: "shape" },
    { label: "制造商", key: "manufacturer" },
    { label: "轨道类型", key: "orbit_type" },
    { label: "倾角", key: "inclination" },
    { label: "RCS 分级", key: "rcs_size" },
  ];

  console.log(`\n=== 在轨 Starlink 字段覆盖（${alive.length} 个）===\n`);
  console.log(`  ${"字段".padEnd(12)} ${"Space-Track".padStart(12)} ${"Spacebook".padStart(11)} ${"DISCOS".padStart(9)}   可用`);

  const holes: Record<string, number[]> = {};
  for (const { label, key } of fields) {
    const has = (src: Map<number, Obj>) =>
      alive.filter((n) => {
        const v = src.get(n)?.fields.get(key);
        return v !== null && v !== undefined && v !== "";
      }).length;
    const a = has(st);
    const b = has(sb);
    const c = has(ds);
    const union = alive.filter((n) => {
      for (const src of [st, sb, ds]) {
        const v = src.get(n)?.fields.get(key);
        if (v !== null && v !== undefined && v !== "") return true;
      }
      return false;
    }).length;
    holes[label] = alive.filter((n) => {
      for (const src of [st, sb, ds]) {
        const v = src.get(n)?.fields.get(key);
        if (v !== null && v !== undefined && v !== "") return false;
      }
      return true;
    });
    console.log(
      `  ${label.padEnd(12)} ${pct(a, alive.length).padStart(12)} ${pct(b, alive.length).padStart(11)} ${pct(c, alive.length).padStart(9)}   ${pct(union, alive.length)}`,
    );
  }

  // ------------------------------------------------- look-alike check
  // What actually matters for screening: every in-orbit Starlink must have a mass
  // and a hard-body radius, and they must be physically consistent (a Starlink is
  // ~1.14 m radius, not 8.83 m).
  console.log(`\n=== 物理量测量（这是 Pc 计算的输入）===\n`);
  const masses: number[] = [];
  const hbrs: number[] = [];
  for (const n of alive) {
    const m = sb.get(n)?.fields.get("mass");
    const h = sb.get(n)?.fields.get("hbr");
    if (typeof m === "number") masses.push(m);
    if (typeof h === "number") hbrs.push(h);
  }
  masses.sort((x, y) => x - y);
  hbrs.sort((x, y) => x - y);
  const q = (arr: number[], p: number) => arr[Math.floor(arr.length * p)] ?? NaN;
  if (masses.length > 0) {
    console.log(
      `  质量    n=${masses.length}  中位 ${q(masses, 0.5).toFixed(0)} kg  P5 ${q(masses, 0.05).toFixed(0)}  P95 ${q(masses, 0.95).toFixed(0)}`,
    );
  }
  if (hbrs.length > 0) {
    console.log(
      `  硬体半径 n=${hbrs.length}  中位 ${q(hbrs, 0.5).toFixed(3)} m  P5 ${q(hbrs, 0.05).toFixed(3)}  P95 ${q(hbrs, 0.95).toFixed(3)}`,
    );
    const distinct = new Set(hbrs.map((x) => x.toFixed(2)));
    console.log(`           不同取值 ${distinct.size} 个：${[...distinct].slice(0, 8).join(", ")}`);
  }

  // Is every Starlink given a distinct hard-body radius, or is one value reused?
  // A single value across 11 000 objects would mean the field is a fleet constant,
  // which is defensible for one vehicle type — but it must be stated, not assumed.
  console.log(`\n=== 质量与半径的配对是否一致 ===\n`);
  const pairs = new Map<string, number>();
  for (const n of alive) {
    const m = sb.get(n)?.fields.get("mass");
    const h = sb.get(n)?.fields.get("hbr");
    if (typeof m === "number" && typeof h === "number") {
      const k = `${m.toFixed(0)}kg / ${h.toFixed(2)}m`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
  }
  for (const [k, v] of [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`  ${k.padEnd(28)} ${String(v).padStart(6)}`);
  }

  // ------------------------------------------------- questionable values
  console.log(`\n=== 需要核实的值 ===\n`);
  const badMass = alive.filter((n) => {
    const m = sb.get(n)?.fields.get("mass");
    return typeof m === "number" && (m < 100 || m > 3000);
  });
  const badHbr = alive.filter((n) => {
    const h = sb.get(n)?.fields.get("hbr");
    return typeof h === "number" && (h < 0.3 || h > 5);
  });
  console.log(`  质量异常（<100 或 >3000 kg）  ${badMass.length}`);
  for (const n of badMass.slice(0, 5)) {
    console.log(`    ${n}  ${String(st.get(n)?.name ?? sb.get(n)?.name ?? "").slice(0, 20).padEnd(22)} ${sb.get(n)?.fields.get("mass")} kg`);
  }
  console.log(`  半径异常（<0.3 或 >5 m）      ${badHbr.length}`);
  for (const n of badHbr.slice(0, 5)) {
    console.log(`    ${n}  ${String(st.get(n)?.name ?? sb.get(n)?.name ?? "").slice(0, 20).padEnd(22)} ${sb.get(n)?.fields.get("hbr")} m`);
  }

  // -------------------------------------------------- inclination split
  const incPairs: Array<{ n: number; sb: number; st: number }> = [];
  for (const n of alive) {
    const a = sb.get(n)?.fields.get("inclination");
    const b = st.get(n)?.fields.get("inclination");
    if (typeof a === "number" && typeof b === "number") incPairs.push({ n, sb: a, st: b });
  }
  const incDiff = incPairs.filter((p) => Math.abs(p.sb - p.st) > 0.5);
  console.log(`\n  倾角：两源都有 ${incPairs.length}，差 >0.5° ${incDiff.length}`);
  for (const p of incDiff.slice(0, 5)) {
    console.log(`    ${p.n}  GCAT ${p.sb.toFixed(2)}° vs ST ${p.st.toFixed(2)}°`);
  }

  // ------------------------------------------------------ mass conflict
  let mBoth = 0;
  let mDiff = 0;
  for (const n of alive) {
    const a = sb.get(n)?.fields.get("mass");
    const b = ds.get(n)?.fields.get("mass");
    if (typeof a === "number" && typeof b === "number") {
      mBoth += 1;
      if (Math.abs(a - b) / Math.max(a, b) > 0.01) mDiff += 1;
    }
  }
  console.log(`  质量：Spacebook 与 DISCOS 都有 ${mBoth}，差 >1% ${mDiff}`);

  console.log("");
}

main();
