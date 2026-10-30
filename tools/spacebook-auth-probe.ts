/**
 * What the authenticated Spacebook endpoints actually return.
 *
 * Everything the catalogue needs is anonymous. These three are behind the token:
 *
 *   /api/Scene           scene composition
 *   /api/Model           per-object 3D model
 *   /api/UserEphemeris   per-object ephemeris with covariance
 *
 * They were gated for the whole project until a token was obtained, so their shape
 * was assumed rather than known. This probe records size, item count and key set so
 * that whatever is built against them is built against what they return.
 *
 * Run: npx tsx tools/spacebook-auth-probe.ts
 */

import { readStoredToken, defaultTokenPath } from "../src/lib/sources/spacebook-auth";

const BASE = "https://www.spacebook.com";

interface Probe {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  note: string;
}

const PROBES: Probe[] = [
  { method: "GET", path: "/api/Scene", note: "场景" },
  { method: "GET", path: "/api/Model?noradId=25544", note: "ISS 模型" },
  { method: "GET", path: "/api/UserEphemeris?noradId=25544", note: "ISS 星历" },
  { method: "GET", path: "/api/UserEphemeris?noradId=44713", note: "STARLINK-1007 星历" },
  { method: "GET", path: "/api/Entity/satcat/details?id=25544", note: "对照：匿名端点是否也可用" },
];

async function main(): Promise<void> {
  const token = await readStoredToken(defaultTokenPath());
  if (!token) {
    console.error("\n  无 token，先运行 npm run spacebook:login\n");
    process.exit(1);
  }
  console.log(`\n  token 剩余 ${Math.round((token.expiresAt - Date.now()) / 60_000)} 分钟\n`);

  for (const p of PROBES) {
    const url = `${BASE}${p.path}`;
    try {
      const res = await fetch(url, {
        method: p.method,
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
        },
        body: p.body ? JSON.stringify(p.body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      const kb = (text.length / 1024).toFixed(1);

      let shape = "";
      try {
        const j = JSON.parse(text) as unknown;
        if (Array.isArray(j)) {
          shape = `数组 ${j.length} 项`;
          if (j.length && typeof j[0] === "object" && j[0] !== null) {
            const k = Object.keys(j[0] as object);
            shape += `  键: ${k.slice(0, 10).join(",")}`;
          }
        } else if (j && typeof j === "object") {
          const k = Object.keys(j as object);
          shape = `对象 ${k.length} 键: ${k.slice(0, 12).join(",")}`;
        } else {
          shape = String(j).slice(0, 50);
        }
      } catch {
        shape = text.slice(0, 90).replace(/\s+/g, " ");
      }

      console.log(`  ${res.status}  ${p.path.slice(0, 44).padEnd(46)} ${kb}KB  ${shape}`);
      console.log(`        └ ${p.note}`);
    } catch (err) {
      console.log(`  ERR ${p.path}  ${(err as Error).message.slice(0, 70)}`);
    }
  }
  console.log("");
}

void main();
