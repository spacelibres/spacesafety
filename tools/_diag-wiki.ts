/**
 * What does the Wikipedia Starlink article actually say about manufacturer?
 *
 * Before loosening the prompt further, check the source text. If the article does
 * not state who builds the satellites, no prompt will extract it, and the run is
 * working correctly.
 *
 * Run: npx tsx tools/_diag-wiki.ts
 */

import { loadEnvLocal } from "../scripts/env";
import { fetchPage } from "../src/lib/sources/web-fetch";

loadEnvLocal();

async function main(): Promise<void> {
  const url = "https://en.wikipedia.org/wiki/Starlink";
  const page = await fetchPage(url);
  console.log(`页面 ${page.length} 字符\n`);

  const patterns = ["manufactur", "built by", "SpaceX", "contractor", "mass", "kg", "bus"];
  for (const p of patterns) {
    const idx = page.text.toLowerCase().indexOf(p.toLowerCase());
    if (idx === -1) {
      console.log(`  "${p}"  未出现`);
      continue;
    }
    const ctx = page.text.slice(Math.max(0, idx - 120), idx + 200).replace(/\n/g, " / ");
    console.log(`  "${p}"  命中 → …${ctx}…\n`);
  }
}

void main();
