/**
 * Route-level states: 404, error boundary, loading, titles, search.
 *
 * ## Why these are asserted
 *
 * A page that answers 200 with content is only half the story. The things that go
 * wrong around it are invisible in a screenshot and invisible to `tsc`:
 *
 *   - a missing entity rendered Next's English default instead of the app's 404;
 *   - an error boundary that never existed, so a thrown page showed a white screen;
 *   - every page sharing one `<title>`, so six open tabs are indistinguishable;
 *   - a search box that takes typing and does nothing;
 *   - a loading boundary that makes `notFound()` answer **200** — that one was
 *     introduced here and caught here.
 *
 * The checks read the built route files rather than a browser: layout invariants
 * are structural, and the browser pass is `tools/viewport-audit.ts` plus the manual
 * probes recorded in the changelog.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

const APP = join(process.cwd(), "src/app");

/** Every route segment that renders a page. */
function pageDirs(dir = APP, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const next = join(dir, entry.name);
    pageDirs(next, out);
    if (existsSync(join(next, "page.tsx"))) out.push(next);
  }
  return out;
}

function main(): void {
  console.log("\n路由级状态：404 / 错误 / 加载 / 标题 / 搜索\n");

  check("全局 not-found 存在，而且不依赖服务端请求上下文", () => {
    const path = join(APP, "not-found.tsx");
    assert.ok(existsSync(path), "缺少 src/app/not-found.tsx");
    const src = readFileSync(path, "utf8");
    // notFound() 在动态页里以 RSC payload 送到浏览器，服务端 cookie 读不到：
    // 文案必须来自客户端组件，否则页面是空的（实测过）。
    assert.match(src, /RouteMessages/, "正文应来自客户端组件");
    assert.doesNotMatch(src, /await getTranslator\(\)|getTranslator\(\)/, "服务端读词典会让正文渲染不出来");
  });

  check("全局错误边界存在且是客户端组件", () => {
    const path = join(APP, "error.tsx");
    assert.ok(existsSync(path), "缺少 src/app/error.tsx");
    const src = readFileSync(path, "utf8");
    assert.match(src, /^"use client";/, "error.tsx 必须是客户端组件");
    assert.match(src, /reset/, "应提供重试");
    assert.match(src, /digest/, "应显示 digest，否则用户报不出问题");
  });

  check("加载骨架只挂在不会 notFound() 的叶子段上", () => {
    const withLoading = pageDirs().filter((d) => existsSync(join(d, "loading.tsx")));
    assert.ok(withLoading.length > 0, "一个 loading 都没有");
    // 反过来：有动态子路由的段不允许挂 loading —— 那会让子页的 notFound() 变成 200。
    const parentsWithDynamicChild = pageDirs().filter((d) => {
      const children = readdirSync(d, { withFileTypes: true }).filter(
        (e) => e.isDirectory() && e.name.startsWith("["),
      );
      return children.length > 0;
    });
    for (const parent of parentsWithDynamicChild) {
      assert.ok(
        !existsSync(join(parent, "loading.tsx")),
        `${parent.replace(process.cwd() + "/", "")} 有动态子路由，挂 loading.tsx 会让子页 notFound() 返回 200`,
      );
    }
  });

  check("每个页面都有自己的标题", () => {
    const dirs = pageDirs();
    const missing = dirs.filter((d) => {
      const src = readFileSync(join(d, "page.tsx"), "utf8");
      // docs 的 catch-all 用 generateMetadata 在同一文件里覆盖索引与正文
      return !src.includes("generateMetadata") && d !== APP;
    });
    assert.deepEqual(
      missing.map((d) => d.replace(process.cwd() + "/", "")),
      [],
      "以下页面共享了全局标题",
    );
  });

  check("首页标题可以只有站名（它没有可区分的实体）", () => {
    const src = readFileSync(join(APP, "page.tsx"), "utf8");
    assert.doesNotMatch(src, /generateMetadata/, "首页若加标题，必须是刻意决定");
  });

  check("侧栏搜索是一个真正提交到编目搜索的表单", () => {
    const src = readFileSync(join(process.cwd(), "src/components/Shell.tsx"), "utf8");
    assert.match(src, /action="\/catalogue"/, "搜索框应提交到 /catalogue");
    assert.match(src, /name="q"/, "输入框必须有 name，否则提交是空的");
    assert.match(src, /event\.key !== "\/"/, "应支持 / 快捷键");
    assert.match(src, /searchRef\.current\?\.focus\(\)/, "快捷键应聚焦搜索框");
  });

  check("跳过正文的链接存在且指向 main", () => {
    const layout = readFileSync(join(APP, "layout.tsx"), "utf8");
    assert.match(layout, /href="#main-content"/, "缺少跳转链接");
    assert.match(layout, /id="main-content"/, "缺少跳转目标");
  });

  check("键盘焦点有可见样式", () => {
    const css = readFileSync(join(APP, "globals.css"), "utf8");
    assert.match(css, /:focus-visible\s*\{/, "缺少全局 focus-visible 规则");
    // 滤镜栏里的输入控件把 outline 关了，必须补回来
    assert.match(css, /\.filter-group > input:focus-visible/, "筛选输入框没有焦点环");
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main();
