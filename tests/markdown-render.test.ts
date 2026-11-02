/**
 * The Markdown subset renderer.
 *
 * The docs corpus is authored Markdown and rendered by `src/components/Markdown.tsx`
 * — a hand-written parser rather than a library, so that no HTML can reach the DOM
 * and no dependency is added for a feature the content does not use.
 *
 * A hand-written parser needs tests for exactly the reason this project keeps
 * rediscovering: it is easy to make it work on the page you are looking at and
 * wrong on the page you are not. These cases pin the block boundaries — the part
 * that silently merges or drops content when it is wrong.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";

import { parseBlocks, parseInline } from "../src/lib/docs/markdown";

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

function main(): void {
  console.log("\nMarkdown 渲染：块边界\n");

  check("标题层级", () => {
    const blocks = parseBlocks("# One\n## Two\n### Three\n#### Four");
    assert.deepEqual(
      blocks.map((b) => [b.kind, b.level, b.text]),
      [
        ["heading", 1, "One"],
        ["heading", 2, "Two"],
        ["heading", 3, "Three"],
        ["heading", 4, "Four"],
      ],
    );
  });

  check("段落合并连续行，空行分段", () => {
    const blocks = parseBlocks("first line\nsecond line\n\nsecond paragraph");
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].text, "first line second line");
    assert.equal(blocks[1].text, "second paragraph");
  });

  check("围栏代码块原样保留（含空行与缩进）", () => {
    const blocks = parseBlocks("```bash\ncurl \\\n  --key k \\\n\n  'http://x'\n```");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, "code");
    assert.equal(blocks[0].lang, "bash");
    assert.equal(blocks[0].text, "curl \\\n  --key k \\\n\n  'http://x'");
  });

  check("代码块里的 # 不会被当成标题", () => {
    const blocks = parseBlocks("```\n# not a heading\n## also not\n```");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, "code");
  });

  check("表格识别表头与数据行", () => {
    const blocks = parseBlocks("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |");
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].header, ["a", "b"]);
    assert.deepEqual(blocks[0].rows, [
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  check("无序与有序列表分开", () => {
    const blocks = parseBlocks("- one\n- two\n\n1. first\n2. second");
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].kind, "list");
    assert.deepEqual(blocks[0].items, ["one", "two"]);
    assert.equal(blocks[1].kind, "ordered");
    assert.deepEqual(blocks[1].items, ["first", "second"]);
  });

  check("引用块合并为一个块", () => {
    const blocks = parseBlocks("> line one\n> line two");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, "quote");
    assert.equal(blocks[0].text, "line one line two");
  });

  check("分隔线与空输入", () => {
    assert.deepEqual(parseBlocks("---").map((b) => b.kind), ["hr"]);
    assert.deepEqual(parseBlocks(""), []);
    assert.deepEqual(parseBlocks("\n\n  \n"), []);
  });

  check("段落不会吞掉紧随其后的列表", () => {
    const blocks = parseBlocks("intro line\n- item");
    assert.equal(blocks.length, 2, `得到 ${blocks.length} 块：${blocks.map((b) => b.kind).join(",")}`);
    assert.equal(blocks[0].kind, "paragraph");
    assert.equal(blocks[1].kind, "list");
  });

  check("CRLF 输入与 LF 等价", () => {
    const crlf = parseBlocks("# Title\r\n\r\npara\r\n");
    const lf = parseBlocks("# Title\n\npara\n");
    assert.deepEqual(crlf, lf);
  });

  // ---------------------------------------------------------------- 内联
  check("内联：代码、粗体、内部链接、外部链接", () => {
    const tokens = parseInline("a `code` b **bold** [内部](/docs/x) [外部](https://example.test)");
    assert.deepEqual(
      tokens.map((t) => t.kind),
      ["text", "code", "text", "bold", "text", "link", "text", "link"],
    );
    assert.equal(tokens[1].text, "code");
    assert.equal(tokens[3].text, "bold");
    assert.equal((tokens[5] as { href: string }).href, "/docs/x");
    assert.equal((tokens[7] as { href: string }).href, "https://example.test");
  });

  check("内联：未闭合的标记会原样留下，而不是被吞掉", () => {
    const tokens = parseInline("dangling `tick and **bold");
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].kind, "text");
    assert.match(tokens[0].text ?? "", /dangling/);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main();
