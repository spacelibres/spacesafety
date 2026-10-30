/**
 * End-to-end check of the DeepSeek extraction path on a page known to contain the data.
 *
 * The crawl reported "原文未写明" for every object in a run, which is a correct answer
 * when the page genuinely lacks the field — Gunter's HJS entry has an empty
 * `Contractors:` line. This script separates the two possibilities by picking pages
 * that provably state a manufacturer and a mass, then checking that the extractor
 * returns them.
 *
 * Run: npx tsx tools/_diag-extract.ts
 */

import { loadEnvLocal } from "../scripts/env";
import { extractField } from "../src/lib/sources/deepseek";
import { fetchPage, focusOn } from "../src/lib/sources/web-fetch";

loadEnvLocal();

const CASES = [
  {
    url: "https://space.skyrocket.de/doc_sdat/hawk-15a.htm",
    name: "Hawk 15A",
    fields: ["manufacturer", "mass_kg"] as const,
  },
  {
    url: "https://space.skyrocket.de/doc_sdat/yaogan-43.htm",
    name: "Yaogan 43",
    fields: ["manufacturer", "mass_kg"] as const,
  },
];

const HINTS: Record<string, string> = {
  manufacturer: "卫星的制造商 / 承制单位。注意：运载火箭承包商、发射服务商不算制造商。",
  mass_kg: "卫星发射质量，单位 kg。不得取干重、载荷质量或运载能力。",
};

async function main(): Promise<void> {
  for (const c of CASES) {
    console.log(`\n═══ ${c.name}  ${c.url} ═══`);
    let page;
    try {
      page = await fetchPage(c.url);
    } catch (err) {
      console.log(`  抓取失败：${(err as Error).message}`);
      continue;
    }
    console.log(`  正文 ${page.length} 字符，类型 ${page.type}`);
    const text = focusOn(page.text, c.name.split(" ")[0]!, 12_000);

    for (const field of c.fields) {
      const r = await extractField({
        objectName: c.name,
        cosparId: null,
        noradId: null,
        field,
        fieldHint: HINTS[field]!,
        pageText: text,
        sourceUrl: page.finalUrl,
      });
      if (r.extraction) {
        console.log(
          `  ✓ ${field.padEnd(14)} = ${JSON.stringify(r.extraction.valueText ?? r.extraction.valueNum)}`,
        );
        console.log(`       quote: ${r.extraction.quote.replace(/\n/g, " / ").slice(0, 110)}`);
      } else {
        console.log(`  ✗ ${field.padEnd(14)} ${r.note ?? "无结果"}`);
      }
    }
  }
  console.log("");
}

void main();
