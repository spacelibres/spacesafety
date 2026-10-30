/**
 * Crawl the allowlist for catalogue gaps and store the results as supplement claims.
 *
 * ## The pipeline, and where each guard sits
 *
 *   candidate     from `supplement-candidates.ts` — in orbit, field missing
 *      ↓          allowlist check: an untrusted domain is never downloaded
 *   fetch         page reduced to text, redirects re-checked
 *      ↓          DeepSeek sees only this text, never the open internet
 *   extract       value + verbatim quote, or null
 *      ↓          quote compared against the page text; a paraphrase is discarded
 *   validate      URL, quote length, locatable object — else dropped
 *      ↓
 *   supplement_claim   verified = 0, awaiting a human
 *
 * ## Why a page can produce several fields
 *
 * One fetch costs one network round trip but several model calls. Re-fetching the
 * same page per field would be slower and would hammer sites that are doing us a
 * favour. The fields are extracted from the same focused text.
 *
 * Run:
 *   npx tsx tools/supplement-crawl.ts --limit 5 --dry-run
 *   npx tsx tools/supplement-crawl.ts --limit 20
 *   npx tsx tools/supplement-crawl.ts --field manufacturer --limit 50
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import Database from "better-sqlite3";

import { loadEnvLocal } from "../scripts/env";
import { extractField } from "../src/lib/sources/deepseek";
import { fetchPage, focusOn, type FetchedPage } from "../src/lib/sources/web-fetch";
import { SupplementStore, type SupplementClaim, type SourceType } from "../src/lib/sources/supplement";

loadEnvLocal();

interface Args {
  limit: number;
  field: string | null;
  dryRun: boolean;
  delayMs: number;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    limit: Number(flag("--limit") ?? "10"),
    field: flag("--field") ?? null,
    dryRun: argv.includes("--dry-run"),
    delayMs: Number(flag("--delay") ?? "800"),
    out: flag("--out") ?? null,
  };
}

interface Candidate {
  noradId: number;
  name: string | null;
  cosparId: string | null;
  objectClass: string | null;
  country: string | null;
  launchDate: string | null;
  missing: string[];
}

/** What each field means, so the model does not confuse neighbouring concepts. */
const FIELD_HINTS: Record<string, string> = {
  manufacturer: "卫星的制造商 / 承制单位。注意：运载火箭承包商、发射服务商不算制造商。",
  bus: "卫星平台（bus）型号，例如 Starlink v2 Mini、Arrow、LM-400。不是整星名称。",
  shape: "卫星外形类别，例如 Box、Cylinder、Sphere、Box + 1 Panel。",
  mass_kg: "卫星发射质量，单位 kg。不得取干重、载荷质量或运载能力。",
};

/**
 * Sites likely to describe an object.
 *
 * Two strategies, because the sources differ in kind. Wikipedia has a search API,
 * so its page for an object is found rather than guessed. Gunter's uses a
 * predictable per-series path, so a guess costs one 404 and needs no API. The
 * remaining domains are only reachable once a specific article URL is known, which
 * is what the Wikipedia result usually supplies in its reference list.
 */
async function candidateUrls(c: Candidate): Promise<string[]> {
  const urls: string[] = [];
  const name = c.name ?? "";
  if (!name) return urls;

  // Wikipedia: search by the object's own name, which is how its article would be
  // titled. `srsearch` with `srlimit=1` returns the best match.
  try {
    const q = encodeURIComponent(`${name} satellite`);
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&srlimit=1&format=json`,
      { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "spacesafety/0.1 (catalogue research)" } },
    );
    if (res.ok) {
      const j = (await res.json()) as { query?: { search?: Array<{ title: string }> } };
      const title = j.query?.search?.[0]?.title;
      if (title) {
        urls.push(`https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`);
      }
    }
  } catch {
    // Search is best-effort: a failure falls through to the URL guesses below.
  }

  // Gunter's Space Page: `/doc_sdat/<slug>.htm`, tried for the exact object and for
  // its series (`hawk-15a` → `hawk`), since the page covers the family.
  const slug = name.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (slug) {
    urls.push(`https://space.skyrocket.de/doc_sdat/${slug}.htm`);
    const series = slug.replace(/-\d+[a-z]?$/, "");
    if (series && series !== slug) {
      urls.push(`https://space.skyrocket.de/doc_sdat/${series}.htm`);
    }
  }

  return urls;
}

async function crawlOne(
  c: Candidate,
  fields: string[],
  dryRun: boolean,
  store: SupplementStore | null,
): Promise<{ stored: number; rejected: number; notes: string[]; claims: SupplementClaim[] }> {
  const notes: string[] = [];
  const claims: SupplementClaim[] = [];

  let page: FetchedPage | null = null;
  for (const url of await candidateUrls(c)) {
    try {
      page = await fetchPage(url);
      break;
    } catch (err) {
      notes.push(`${url} → ${(err as Error).message}`);
    }
  }
  if (!page) return { stored: 0, rejected: 0, notes, claims };

  // The series page describes several satellites; focus on the paragraph naming this
  // one so the model does not read its neighbour's mass.
  const text = focusOn(page.text, c.name ?? "", 12_000);

  for (const field of fields) {
    const hint = FIELD_HINTS[field];
    if (!hint) continue;

    const result = await extractField({
      objectName: c.name ?? String(c.noradId),
      cosparId: c.cosparId,
      noradId: c.noradId,
      field,
      fieldHint: hint,
      pageText: text,
      sourceUrl: page.finalUrl,
    });

    if (!result.extraction) {
      if (result.note) notes.push(`${field}: ${result.note}`);
      continue;
    }

    claims.push({
      noradId: c.noradId,
      cosparId: c.cosparId,
      objectName: c.name,
      field,
      valueNum: result.extraction.valueNum,
      valueText: result.extraction.valueText,
      unit: field === "mass_kg" ? "kg" : null,
      sourceUrl: page.finalUrl,
      sourceType: page.type as SourceType,
      attribution: page.attribution ?? null,
      quote: result.extraction.quote,
      // One page is one source. Corroboration is a separate run against a second
      // domain; claiming more than one here would fake the evidence count.
      evidenceCount: 1,
      corroboration: [],
      confidence: 0,
      note: result.extraction.strength === "implied" ? "模型判定为隐含表述" : null,
    });
  }

  if (dryRun || !store) return { stored: 0, rejected: 0, notes, claims };

  const res = store.add(claims);
  return {
    stored: res.stored,
    rejected: res.rejected.length,
    notes: [...notes, ...res.rejected.map((r) => `${r.claim.field}: ${r.reason}`)],
    claims,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const candidatesPath = "data/candidates.json";
  let candidates: Candidate[];
  try {
    candidates = JSON.parse(readFileSync(candidatesPath, "utf8")) as Candidate[];
  } catch {
    console.error(
      `\n  找不到 ${candidatesPath}\n  先运行：npm run supplement:candidates -- --limit ${args.limit} --out ${candidatesPath}\n`,
    );
    process.exit(1);
  }

  const list = candidates.slice(0, args.limit);
  const dbPath = process.env.SPACE_SAFETY_DB ?? "./data/catalogue.sqlite";
  const db = args.dryRun ? null : new Database(dbPath);
  const store = db ? new SupplementStore(db) : null;

  console.log(`\n  候选 ${list.length} 个，开始检索\n`);

  let totalStored = 0;
  let totalRejected = 0;
  const collected: SupplementClaim[] = [];

  for (const [i, c] of list.entries()) {
    const fields = args.field ? [args.field] : c.missing;
    const label = `${String(i + 1).padStart(3)}/${list.length}`;
    process.stdout.write(`  ${label}  ${String(c.name ?? c.noradId).slice(0, 26).padEnd(28)}`);

    const r = await crawlOne(c, fields, args.dryRun, store);
    totalStored += r.stored;
    totalRejected += r.rejected;
    collected.push(...r.claims);

    const found = r.claims.map((x) => x.field).join(",");
    console.log(found ? `✓ ${found}` : `— ${r.notes[0]?.slice(0, 60) ?? "无结果"}`);

    await new Promise((res) => setTimeout(res, args.delayMs));
  }

  console.log(`\n  入库 ${totalStored} 条，被规则拒 ${totalRejected} 条`);
  if (store) {
    const s = store.summary();
    console.log(`  待审 ${s.pending}  已确认 ${s.confirmed}  已否决 ${s.rejected}`);
  }

  if (args.out) {
    mkdirSync(args.out.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(args.out, JSON.stringify(collected, null, 2));
    console.log(`  明细已写出 ${args.out}`);
  }

  db?.close();
  console.log("");
}

void main();
