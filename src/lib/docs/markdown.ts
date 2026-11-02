/**
 * The Markdown subset parser for the documentation corpus.
 *
 * ## Why a hand-written parser
 *
 * The corpus uses headings, paragraphs, fenced code, tables, lists, blockquotes,
 * inline code, bold and links — nothing else. A general Markdown library would add
 * a dependency plus a sanitiser for features the content never uses, and its output
 * would arrive as an HTML string, which this project renders nowhere.
 *
 * Parsing here and rendering in `components/Markdown.tsx` also keeps this module
 * dependency-free: it imports nothing, so it can be tested without React or the
 * Next runtime, and the block boundaries — the part that silently merges or drops
 * content when it is wrong — are pinned by `tests/markdown-render.test.ts`.
 *
 * Unsupported constructs degrade to text rather than disappearing: a docs page that
 * silently drops a paragraph is worse than one that shows the syntax.
 */

export interface Block {
  kind: "heading" | "paragraph" | "code" | "list" | "ordered" | "table" | "quote" | "hr";
  level?: number;
  lang?: string;
  text?: string;
  items?: string[];
  rows?: string[][];
  header?: string[];
}

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "link"; text: string; href: string };

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isTableSeparator = (line: string) => /^\|[\s:|-]+\|$/.test(line.trim());
const isHeading = (line: string) => /^#{1,4}\s/.test(line);
const isFence = (line: string) => line.trimStart().startsWith("```");
const isQuote = (line: string) => line.trimStart().startsWith(">");
const isBullet = (line: string) => /^\s*[-*]\s+/.test(line);
const isOrdered = (line: string) => /^\s*\d+\.\s+/.test(line);
const isHr = (line: string) => /^---+$/.test(line.trim());
const isTableRow = (line: string) => line.trim().startsWith("|");

/** Parse the corpus subset into blocks. */
export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Fenced code — everything until the closing fence, verbatim.
    if (isFence(line)) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }

    if (isHr(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    // Table: a header row followed by a separator row.
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    if (isQuote(line)) {
      const body: string[] = [];
      while (i < lines.length && isQuote(lines[i])) {
        body.push(lines[i].trimStart().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", text: body.join(" ") });
      continue;
    }

    if (isBullet(line)) {
      const items: string[] = [];
      while (i < lines.length && isBullet(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }

    if (isOrdered(line)) {
      const items: string[] = [];
      while (i < lines.length && isOrdered(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "ordered", items });
      continue;
    }

    // Paragraph: consecutive lines that are not the start of something else.
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !isFence(lines[i]) &&
      !isHeading(lines[i]) &&
      !isTableRow(lines[i]) &&
      !isQuote(lines[i]) &&
      !isBullet(lines[i]) &&
      !isOrdered(lines[i]) &&
      !isHr(lines[i])
    ) {
      body.push(lines[i].trim());
      i += 1;
    }
    if (body.length) blocks.push({ kind: "paragraph", text: body.join(" ") });
  }

  return blocks;
}

/**
 * Split inline formatting into tokens: `code`, **bold**, [text](href).
 *
 * Tokenising rather than string-replacing keeps the renderer from ever passing
 * text through HTML: each token becomes a React node or a text node.
 */
export function parseInline(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push({ kind: "text", text: text.slice(last, match.index) });
    const token = match[0];
    if (token.startsWith("`")) {
      out.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      out.push({ kind: "bold", text: token.slice(2, -2) });
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      out.push({ kind: "link", text: link[1], href: link[2] });
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
