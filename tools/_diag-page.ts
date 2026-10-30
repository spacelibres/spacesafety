import { loadEnvLocal } from "../scripts/env";
import { fetchPage } from "../src/lib/sources/web-fetch";

loadEnvLocal();

async function main() {
  const url = "https://space.skyrocket.de/doc_sdat/hjs.htm";
  try {
    const p = await fetchPage(url);
    console.log("URL:", p.finalUrl, "长度:", p.length, "类型:", p.type);
    console.log("\n--- 前 1500 字符 ---");
    console.log(p.text.slice(0, 1500));
  } catch (e) {
    console.log("失败:", (e as Error).message);
  }
}

void main();
