import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const files = walk("src").filter((f) => /\.tsx?$/.test(f) && !f.includes(join("src", "lib", "i18n")));
const CJK = /[\u4e00-\u9fff]/;
const rows: Array<{ file: string; line: number; kind: string; text: string }> = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    let bad: string | null = null;
    if (ts.isStringLiteralLike(node)) bad = node.text;
    else if (ts.isJsxText(node)) bad = node.text;
    if (bad && CJK.test(bad)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      rows.push({ file, line: line + 1, kind: ts.SyntaxKind[node.kind], text: bad.trim().slice(0, 46) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
console.log("中文文案字面量总数:", rows.length, " 文件数:", new Set(rows.map((r) => r.file)).size);
const byFile = new Map<string, number>();
for (const r of rows) byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1);
for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(3), f);
console.log("\n=== 明细（前 60 条）===");
for (const r of rows.slice(0, 60)) console.log(`${r.file}:${r.line}  [${r.kind}]  ${r.text}`);
