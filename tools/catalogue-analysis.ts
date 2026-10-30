/**
 * Analyse the three catalogues against each other, from the raw downloads.
 *
 * This reads the archived provider files directly and never touches the
 * application or the working database. Its only output is a report: where the
 * sources agree, where they disagree, and which fields only one source has.
 *
 * Run: npx tsx tools/catalogue-analysis.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------- loading

function newest(dir: string): string {
  const days = readdirSync(dir)
    .filter((d) => statSync(join(dir, d)).isDirectory())
    .sort();
  const day = days.at(-1)!;
  const files = readdirSync(join(dir, day)).sort();
  return join(dir, day, files.at(-1)!);
}

interface Ours {
  /** NORAD id → the best value this source gives for each field. */
  byNorad: Map<number, Record<string, unknown>>;
  label: string;
}

/** Spacebook satcat-details CSV: COMSPOC physics + GCAT launch record. */
function loadSpacebookDetails(): Ours {
  const path = newest("data/archive/spacebook-satcat-details-csv");
  const text = readFileSync(path, "utf8");
  const rows = parseCsv(text);
  const header = rows[0];
  const col = (name: string) => header.indexOf(name);
  const iNorad = col("NORAD Id");
  const iName = col("Space-Track Name");
  const iDesig = col("Intl Desig");
  const iHbr = col("COMSPOC HBR Mean (m)");
  const iMass = col("COMSPOC Adopted Mass (kg)");
  const iXsec = col("COMSPOC Cross Section Median (m^2)");
  const iSpan = col("COMSPOC Adopted Span (m)");
  const iBc = col("COMSPOC Ballistic Coefficient");
  const iMan = col("GCAT Manufacturer");
  const iBus = col("GCAT Bus");
  const iType = col("GCAT Type");
  const iOwner = col("GCAT Owner");
  const iState = col("GCAT State");
  const iLaunch = col("GCAT LaunchDate");
  const iDecay = col("GCAT DecayDate");
  const iOrbit = col("GCAT OrbitType");
  const iInc = col("GCAT Inclination (°)");

  const byNorad = new Map<number, Record<string, unknown>>();
  for (const r of rows.slice(1)) {
    const norad = Number(r[iNorad]);
    if (!Number.isFinite(norad)) continue;
    byNorad.set(norad, {
      name: r[iName] || null,
      desig: r[iDesig] || null,
      hbr: num(r[iHbr]),
      mass: num(r[iMass]),
      xsec: num(r[iXsec]),
      span: num(r[iSpan]),
      bc: num(r[iBc]),
      manufacturer: r[iMan] || null,
      bus: r[iBus] || null,
      type: normalizeGcatType(r[iType]),
      owner: r[iOwner] || null,
      state: r[iState] || null,
      launch: r[iLaunch] || null,
      decay: r[iDecay] || null,
      orbitType: r[iOrbit] || null,
      inc: num(r[iInc]),
    });
  }
  console.log(`  Spacebook satcat-details  ${path.split("/").pop()}  ${byNorad.size} 条`);
  return { byNorad, label: "spacebook-details" };
}

/** Space-Track satcat: archived as a JSON array, not CSV. */
function loadSpaceTrack(): Ours {
  const path = newest("data/archive/space-track-satcat");
  const rows = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, string | null>>;

  const byNorad = new Map<number, Record<string, unknown>>();
  for (const r of rows) {
    const norad = Number(r.NORAD_CAT_ID);
    if (!Number.isFinite(norad)) continue;
    byNorad.set(norad, {
      name: r.SATNAME || null,
      desig: r.INTLDES || null,
      type: r.OBJECT_TYPE || null,
      country: r.COUNTRY || null,
      launch: r.LAUNCH || null,
      site: r.SITE || null,
      decay: r.DECAY || null,
      period: num(String(r.PERIOD ?? "")),
      inc: num(String(r.INCLINATION ?? "")),
      apogee: num(String(r.APOGEE ?? "")),
      perigee: num(String(r.PERIGEE ?? "")),
      rcs: num(String(r.RCSVALUE ?? "")),
      rcsSize: r.RCS_SIZE || null,
    });
  }
  console.log(`  Space-Track satcat        ${path.split("/").pop()}  ${byNorad.size} 条`);
  return { byNorad, label: "space-track" };
}

/** ESA DISCOSweb object dump (JSON:API). */
function loadDiscos(): Ours {
  const path = newest("data/archive/discos-objects");
  const text = readFileSync(path, "utf8");
  const doc = JSON.parse(text) as {
    data: Array<{ attributes: Record<string, unknown> }>;
  };
  const byNorad = new Map<number, Record<string, unknown>>();
  for (const item of doc.data) {
    const a = item.attributes;
    const satno = Number(a.satno);
    if (!Number.isFinite(satno)) continue;
    byNorad.set(satno, {
      name: a.name ?? null,
      desig: a.cosparId ?? null,
      type: a.objectClass ?? null,
      mass: numOrNull(a.mass),
      xsec: numOrNull(a.xSectAvg),
      xsecMax: numOrNull(a.xSectMax),
      xsecMin: numOrNull(a.xSectMin),
      shape: a.shape ?? null,
      span: numOrNull(a.span),
      diameter: numOrNull(a.diameter),
      decay: a.predDecayDate ?? null,
    });
  }
  console.log(`  ESA DISCOSweb objects     ${path.split("/").pop()}  ${byNorad.size} 条`);
  return { byNorad, label: "discos" };
}

// ---------------------------------------------------------------- helpers

/**
 * Decode a GCAT type code to a plain object class.
 *
 * Spacebook's `GCAT Type` is GCAT's internal compact encoding, not a class: `P`
 * is a payload, `R2` a rocket body stage 2, `D` debris, `C` cargo, `Z` unknown,
 * and the column then appends flag characters (`+`, `?`, `m`, `c`, ...) for
 * attributes like "manoeuvrable" or "crew". Taking the value literally produces
 * 400+ distinct "classes" and makes the field unusable for comparison.
 */
function normalizeGcatType(raw: string | undefined): string | null {
  const t = (raw ?? "").trim();
  if (t === "") return null;
  const c = t[0]!.toUpperCase();
  switch (c) {
    case "P":
      return "Payload";
    case "R":
      return "Rocket Body";
    case "D":
      return "Debris";
    case "C":
      return "Cargo";
    default:
      return "Unknown";
  }
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === "" || t.toUpperCase() === "NULL") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Minimal CSV parser: RFC 4180 quoting, no external dependency. */
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
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function pct(n: number, of: number): string {
  return of === 0 ? "—" : `${((n / of) * 100).toFixed(2)}%`;
}

function isDecayed(decay: unknown): boolean {
  return typeof decay === "string" && decay.trim() !== "";
}

// ---------------------------------------------------------------- analysis

function main(): void {
  console.log("\n读取原始下载文件\n");
  const sb = loadSpacebookDetails();
  const st = loadSpaceTrack();
  const ds = loadDiscos();

  // The universe is every NORAD any source knows about.
  const universe = new Set<number>([
    ...sb.byNorad.keys(),
    ...st.byNorad.keys(),
    ...ds.byNorad.keys(),
  ]);

  /**
   * In orbit or re-entered.
   *
   * Space-Track's `DECAY` is the observed re-entry and covers every record, so it
   * is the authority. DISCOS' value is a *prediction* and Spacebook's GCAT column
   * is a launch-record field; either can be present for an object that is still
   * up. Checking all three and letting any non-empty value mean "decayed" marked
   * 70 460 objects as gone and left 741, which is wrong by a factor of 50.
   */
  const stillInOrbit = (norad: number): boolean => {
    const t = st.byNorad.get(norad);
    if (t) return !isDecayed(t.decay);
    const s = sb.byNorad.get(norad);
    if (s) return !isDecayed(s.decay);
    const d = ds.byNorad.get(norad);
    if (d) return !isDecayed(d.decay);
    return true;
  };

  const inAll = [...universe].filter(
    (n) => sb.byNorad.has(n) && st.byNorad.has(n) && ds.byNorad.has(n),
  ).length;
  const onlySb = [...universe].filter(
    (n) => sb.byNorad.has(n) && !st.byNorad.has(n) && !ds.byNorad.has(n),
  ).length;
  const onlySt = [...universe].filter(
    (n) => st.byNorad.has(n) && !sb.byNorad.has(n) && !ds.byNorad.has(n),
  ).length;
  const onlyDs = [...universe].filter(
    (n) => ds.byNorad.has(n) && !sb.byNorad.has(n) && !st.byNorad.has(n),
  ).length;

  console.log(`\n=== 1. 对象全集 ===\n`);
  console.log(`  并集            ${String(universe.size).padStart(7)}`);
  console.log(`  Spacebook       ${String(sb.byNorad.size).padStart(7)}   ${pct(sb.byNorad.size, universe.size)}`);
  console.log(`  Space-Track     ${String(st.byNorad.size).padStart(7)}   ${pct(st.byNorad.size, universe.size)}`);
  console.log(`  DISCOSweb       ${String(ds.byNorad.size).padStart(7)}   ${pct(ds.byNorad.size, universe.size)}`);
  console.log(`  三源齐全        ${String(inAll).padStart(7)}   ${pct(inAll, universe.size)}`);
  console.log(`  只有 Spacebook  ${String(onlySb).padStart(7)}`);
  console.log(`  只有 Space-Track${String(onlySt).padStart(7)}`);
  console.log(`  只有 DISCOS     ${String(onlyDs).padStart(7)}`);

  // ------------------------------------------------------ field coverage
  console.log(`\n=== 2. 每个字段有几个源能提供（全库）===\n`);
  console.log(`  ${"字段".padEnd(16)} ${"Spacebook".padStart(10)} ${"Space-Track".padStart(12)} ${"DISCOS".padStart(9)}   最佳可用`);

  const fields: Array<{ label: string; f: (r: Record<string, unknown>) => unknown }> = [
    { label: "名称", f: (r) => r.name },
    { label: "COSPAR 编号", f: (r) => r.desig },
    { label: "目标分类", f: (r) => r.type },
    { label: "发射国", f: (r) => r.country ?? r.state },
    { label: "发射场", f: (r) => r.site },
    { label: "发射日期", f: (r) => r.launch },
    { label: "再入日期", f: (r) => r.decay },
    { label: "质量", f: (r) => r.mass },
    { label: "硬体半径", f: (r) => r.hbr },
    { label: "横截面积", f: (r) => r.xsec },
    { label: "翼展", f: (r) => r.span },
    { label: "弹道系数", f: (r) => r.bc },
    { label: "形状", f: (r) => r.shape },
    { label: "制造商", f: (r) => r.manufacturer },
    { label: "平台型号", f: (r) => r.bus },
    { label: "轨道类型", f: (r) => r.orbitType },
    { label: "倾角", f: (r) => r.inc },
  ];

  for (const { label, f } of fields) {
    const count = (src: Ours) => {
      let n = 0;
      for (const r of src.byNorad.values()) {
        const v = f(r);
        if (v !== null && v !== undefined && v !== "") n += 1;
      }
      return n;
    };
    const a = count(sb);
    const b = count(st);
    const c = count(ds);
    const union = [...universe].filter((norad) => {
      for (const src of [sb, st, ds]) {
        const r = src.byNorad.get(norad);
        if (!r) continue;
        const v = f(r);
        if (v !== null && v !== undefined && v !== "") return true;
      }
      return false;
    }).length;
    console.log(
      `  ${label.padEnd(16)} ${pct(a, universe.size).padStart(10)} ${pct(b, universe.size).padStart(12)} ${pct(c, universe.size).padStart(9)}   ${pct(union, universe.size)}  ${union}`,
    );
  }

  // ---------------------------------------------------------- conflicts
  console.log(`\n=== 3. 冲突：同名对象在两源数值不一致 ===\n`);

  // Mass: DISCOS is the instrumented value, Spacebook a derived adoption.
  const massPairs: Array<{ norad: number; a: number; b: number }> = [];
  for (const [norad, r] of sb.byNorad) {
    const d = ds.byNorad.get(norad);
    if (!d) continue;
    const a = r.mass as number | null;
    const b = d.mass as number | null;
    if (a !== null && b !== null) massPairs.push({ norad, a, b });
  }
  const massDiff = massPairs.filter((p) => Math.abs(p.a - p.b) / Math.max(p.a, p.b) > 0.01);
  const ratio = massPairs
    .map((p) => p.a / p.b)
    .sort((x, y) => x - y);
  console.log(`  质量  两源都有 ${massPairs.length}  差 >1% ${massDiff.length}  ${pct(massDiff.length, massPairs.length)}`);
  if (ratio.length > 0) {
    console.log(
      `        比值 中位 ${ratio[Math.floor(ratio.length / 2)]!.toFixed(3)}  P5 ${ratio[Math.floor(ratio.length * 0.05)]!.toFixed(3)}  P95 ${ratio[Math.floor(ratio.length * 0.95)]!.toFixed(3)}`,
    );
  }

  // Decay date: DISCOS predicts, Space-Track observes.
  let decayPairs = 0;
  let decayDiff = 0;
  let decayOneSide = 0;
  for (const [norad, stRow] of st.byNorad) {
    const d = ds.byNorad.get(norad);
    const s = sb.byNorad.get(norad);
    const a = (d?.decay ?? null) as string | null;
    const b = (stRow.decay ?? null) as string | null;
    const c = (s?.decay ?? null) as string | null;
    if (isDecayed(a) && isDecayed(b)) {
      decayPairs += 1;
      const ta = Date.parse(a!);
      const tb = Date.parse(b!);
      if (Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) > 7 * 864e5) decayDiff += 1;
    } else if (isDecayed(a) !== isDecayed(b)) {
      decayOneSide += 1;
    }
    void c;
  }
  console.log(
    `  再入  两源都有 ${decayPairs}  相差 >7 天 ${decayDiff}  只有一方声明已再入 ${decayOneSide}`,
  );

  // Inclination: a sanity check on catalogue orbit summaries.
  const incPairs: Array<{ norad: number; a: number; b: number }> = [];
  for (const [norad, s] of sb.byNorad) {
    const t = st.byNorad.get(norad);
    const a = s.inc as number | null;
    const b = (t?.inc ?? null) as number | null;
    if (a !== null && b !== null) incPairs.push({ norad, a, b });
  }
  const incDiff = incPairs.filter((p) => Math.abs(p.a - p.b) > 0.5);
  const incDiffAlive = incDiff.filter((p) => stillInOrbit(p.norad));
  console.log(
    `  倾角  两源都有 ${incPairs.length}  差 >0.5° ${incDiff.length}（其中在轨 ${incDiffAlive.length}）`,
  );
  for (const p of incDiffAlive.slice(0, 10)) {
    const s = sb.byNorad.get(p.norad);
    console.log(`        ${p.norad}  ${String(s?.name ?? "").slice(0, 22).padEnd(24)} GCAT ${p.a.toFixed(3)} vs ST ${p.b.toFixed(3)}`);
  }

  // Class vocabulary: how the three sources disagree on what a thing is.
  console.log(`\n=== 4. 分类口径不一致 ===\n`);
  const sTypes = new Set<string>();
  const tTypes = new Set<string>();
  const dTypes = new Set<string>();
  for (const r of sb.byNorad.values()) if (r.type) sTypes.add(String(r.type));
  for (const r of st.byNorad.values()) if (r.type) tTypes.add(String(r.type));
  for (const r of ds.byNorad.values()) if (r.type) dTypes.add(String(r.type));
  console.log(`  Spacebook (GCAT Type)  ${[...sTypes].sort().join(" | ")}`);
  console.log(`  Space-Track OBJECT_TYPE ${[...tTypes].sort().join(" | ")}`);
  console.log(`  DISCOS objectClass      ${[...dTypes].sort().join(" | ")}`);

  // Where GCAT and Space-Track disagree on the same object.
  let typePairs = 0;
  let typeDisagree = 0;
  for (const [norad, s] of sb.byNorad) {
    const t = st.byNorad.get(norad);
    if (!t?.type || !s.type) continue;
    typePairs += 1;
    const norm = (x: string) => x.toUpperCase().replace(/S$/, "").trim();
    if (!norm(String(s.type)).includes(norm(String(t.type))) && !norm(String(t.type)).includes(norm(String(s.type)))) {
      typeDisagree += 1;
    }
  }
  console.log(`  两者都有的对象 ${typePairs}，分类对不上 ${typeDisagree}  ${pct(typeDisagree, typePairs)}`);

  // ------------------------------------------------- only-one-source
  console.log(`\n=== 5. 独有字段：只有一家有，且不可替代 ===\n`);
  const exclusive = [
    { field: "硬体半径 hbr", src: sb, get: (r: Record<string, unknown>) => r.hbr },
    { field: "弹道系数", src: sb, get: (r: Record<string, unknown>) => r.bc },
    { field: "制造商", src: sb, get: (r: Record<string, unknown>) => r.manufacturer },
    { field: "平台型号", src: sb, get: (r: Record<string, unknown>) => r.bus },
    { field: "轨道类型", src: sb, get: (r: Record<string, unknown>) => r.orbitType },
    { field: "发射场", src: st, get: (r: Record<string, unknown>) => r.site },
    { field: "发射国", src: st, get: (r: Record<string, unknown>) => r.country },
    { field: "RCS 分级", src: st, get: (r: Record<string, unknown>) => r.rcsSize },
    { field: "形状", src: ds, get: (r: Record<string, unknown>) => r.shape },
  ];
  for (const e of exclusive) {
    let n = 0;
    for (const [norad, r] of e.src.byNorad) {
      const v = e.get(r);
      if (v === null || v === undefined || v === "") continue;
      let others = false;
      for (const other of [sb, st, ds]) {
        if (other === e.src) continue;
        const or = other.byNorad.get(norad);
        if (or && e.get(or) !== null && e.get(or) !== undefined && e.get(or) !== "") {
          others = true;
          break;
        }
      }
      if (!others) n += 1;
    }
    console.log(`  ${e.field.padEnd(14)} 仅 ${e.src.label.padEnd(18)} 有的 ${String(n).padStart(6)}`);
  }

  // ------------------------------------------------------ alive-only view
  // The percentages above are depressed by re-entered objects, which legitimately
  // have no physical model. Repeat the key ones over in-orbit objects only.
  console.log(`\n=== 6. 只看在轨对象（再入的本来就没有物理模型）===\n`);
  const alive = [...universe].filter(stillInOrbit);
  console.log(`  在轨对象   ${alive.length}`);
  for (const { label, f } of fields) {
    let n = 0;
    for (const norad of alive) {
      for (const src of [sb, st, ds]) {
        const r = src.byNorad.get(norad);
        if (!r) continue;
        const v = f(r);
        if (v !== null && v !== undefined && v !== "") {
          n += 1;
          break;
        }
      }
    }
    console.log(`  ${label.padEnd(16)} ${pct(n, alive.length).padStart(9)}   ${n}`);
  }

  console.log("");
}

main();
