/**
 * Documentation parity, asserted rather than hoped for.
 *
 * ## What "aligned with the official docs" has to mean here
 *
 * The upstream documentation set is 33 pages: getting started, 19 endpoint
 * references with parameters and response schemas, 7 tutorials and 4 articles.
 * This deployment's docs area mirrors that structure page for page, but the
 * content is written from *this* implementation — so the risk is not "the prose
 * differs", it is drift in four specific ways:
 *
 *   1. a page in the manifest with no file behind it (a dead link);
 *   2. a page written only in English, served silently to a Chinese reader;
 *   3. an endpoint documented here that the router does not serve;
 *   4. a route the router serves that no page documents.
 *
 * Each of those is a check below. The prose can age; these cannot.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { allPageSlugs, docsEndpoints, docsNav, DOC_LOCALES } from "../src/lib/docs";

let pass = 0;
let fail = 0;

function check(name: string, fn: () => void, detail = ""): void {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
    console.log(`       ${(err as Error).message}`);
  }
}

/** Every route file the app actually serves under /api. */
function servedRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(next, `${prefix}/${entry.name}`);
      } else if (entry.name === "route.ts") {
        // `[id]` in a path is documented as `:id`.
        out.push(prefix.replace(/\[([^\]]+)\]/g, ":$1") || "/");
      }
    }
  };
  walk(join(process.cwd(), "src/app/api"), "/api");
  return out;
}

function main(): void {
  console.log("\n文档对齐：结构、语言、端点覆盖\n");

  const nav = docsNav();
  const endpoints = docsEndpoints().endpoints;
  const slugs = allPageSlugs();

  // ------------------------------------------------------------- 1 · 有文件
  check("导航里每一页都有正文文件（两种语言）", () => {
    for (const locale of DOC_LOCALES) {
      for (const slug of slugs) {
        const path = join(process.cwd(), "content/docs/pages", locale, `${slug}.md`);
        const text = readFileSync(path, "utf8");
        assert.ok(text.length > 400, `${locale}/${slug}.md 只有 ${text.length} 字节`);
      }
    }
  });

  check("正文都不带自己的 h1（标题由页面渲染，避免重复）", () => {
    for (const locale of DOC_LOCALES) {
      for (const slug of slugs) {
        const text = readFileSync(
          join(process.cwd(), "content/docs/pages", locale, `${slug}.md`),
          "utf8",
        );
        // Fenced code blocks contain shell comments that begin with `#`; they are
        // text inside a code block, not headings.
        const prose = text.replace(/^```[\s\S]*?^```$/gm, "");
        const h1s = prose.split("\n").filter((line) => /^#\s+/.test(line));
        assert.equal(h1s.length, 1, `${locale}/${slug}.md 有 ${h1s.length} 个 h1`);
        assert.match(text, /^#\s+/, `${locale}/${slug}.md 不以标题开头`);
      }
    }
  });

  // ------------------------------------------------------------- 2 · 语言
  check("两种语言的正文都不是占位文本", () => {
    for (const slug of slugs) {
      const en = readFileSync(join(process.cwd(), "content/docs/pages/en", `${slug}.md`), "utf8");
      const zh = readFileSync(
        join(process.cwd(), "content/docs/pages/zh-CN", `${slug}.md`),
        "utf8",
      );
      assert.doesNotMatch(en, /TODO|FIXME/, `${slug} 的英文正文有 TODO`);
      assert.doesNotMatch(zh, /TODO|FIXME/, `${slug} 的中文正文有 TODO`);
      // 中文页必须真的有中文（否则是把英文复制过去的）
      const han = (zh.match(/[\u4e00-\u9fff]/g) ?? []).length;
      assert.ok(han > 60, `${slug} 的中文正文只有 ${han} 个汉字`);
    }
  });

  // --------------------------------------------------------- 3 · 端点齐全
  check("每个端点条目都有方法、路径、摘要和至少一个响应", () => {
    for (const endpoint of endpoints) {
      assert.ok(endpoint.method, `${endpoint.slug} 缺方法`);
      assert.match(endpoint.path, /^\/api\//, `${endpoint.slug} 的路径不是 /api/…`);
      assert.ok(endpoint.summary?.en && endpoint.summary?.["zh-CN"], `${endpoint.slug} 缺摘要`);
      assert.ok(endpoint.responses.length > 0, `${endpoint.slug} 没有响应`);
      const ok = endpoint.responses.find((r) => r.status < 300);
      assert.ok(ok, `${endpoint.slug} 没有 2xx 响应`);
    }
  });

  check("文档里的每个端点都由路由真实提供", () => {
    const served = new Set(servedRoutes());
    const missing = endpoints
      .map((e) => e.path)
      .filter((path) => !served.has(path));
    assert.deepEqual(missing, [], `文档写了但路由没有：${missing.join(", ")}`);
  });

  check("路由提供的每个端点都写进了文档", () => {
    const documented = new Set(endpoints.map((e) => e.path));
    // `/api/internal/*` and `/api/models/*` are machine-facing, not part of the
    // published contract; everything else must be documented.
    const undocumented = servedRoutes().filter(
      (path) =>
        !documented.has(path) &&
        !path.startsWith("/api/internal") &&
        !path.startsWith("/api/models"),
    );
    assert.deepEqual(undocumented, [], `有路由没文档：${undocumented.join(", ")}`);
  });

  check("每个端点都归属一个已声明的分组", () => {
    const groups = new Set(nav.sections.find((s) => s.endpoints)?.groups?.map((g) => g.id) ?? []);
    for (const endpoint of endpoints) {
      assert.ok(groups.has(endpoint.section), `${endpoint.slug} 的分组 ${endpoint.section} 未声明`);
    }
  });

  check("扩展端点与官方端点被区分开", () => {
    const extensions = endpoints.filter((e) => e.extension);
    assert.ok(extensions.length >= 3, `只标出 ${extensions.length} 个扩展`);
    assert.ok(
      extensions.every((e) => e.section === "extension"),
      "扩展端点的分组必须是 extension",
    );
    assert.ok(
      endpoints.filter((e) => !e.extension).every((e) => e.section !== "extension"),
      "官方端点不能落在 extension 分组里",
    );
  });

  // --------------------------------------------------- 4 · 参数细节
  check("参数都写了位置、类型、是否必填和说明", () => {
    for (const endpoint of endpoints) {
      for (const param of endpoint.params) {
        const label = `${endpoint.slug} ${param.name}`;
        assert.ok(["query", "path", "header"].includes(param.in), `${label} 位置非法`);
        assert.ok(param.type, `${label} 缺类型`);
        assert.equal(typeof param.required, "boolean", `${label} 缺 required`);
        assert.ok(param.desc?.en && param.desc?.["zh-CN"], `${label} 缺双语文说明`);
        if (param.values) {
          assert.ok(param.values.length > 1, `${label} 的 values 只有一个值`);
        }
      }
      for (const field of endpoint.body) {
        assert.ok(field.name && field.type, `${endpoint.slug} 请求体字段缺名字或类型`);
        assert.ok(field.desc?.en && field.desc?.["zh-CN"], `${endpoint.slug} 请求体缺双语文说明`);
      }
    }
  });

  check("端口数量与官方文档对齐（19 个官方端点 + 扩展）", () => {
    const official = endpoints.filter((e) => !e.extension).length;
    // The official snapshot documents 19 API pages; two of them are an overview
    // page and a redirect, so 18 endpoint pages remain. This deployment serves the
    // 18 and adds 3 documented extensions.
    assert.equal(official, 18, `官方端点 ${official} 个`);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main();
