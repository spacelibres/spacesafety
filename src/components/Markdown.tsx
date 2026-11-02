import Link from "next/link";

import { docLocale, DOC_FALLBACK, type Localised } from "@/lib/docs";
import { parseBlocks, parseInline } from "@/lib/docs/markdown";

/**
 * Render the documentation subset.
 *
 * The parser lives in `lib/docs/markdown.ts` precisely so it can be tested without
 * React or Next; this file only turns its blocks and inline tokens into elements.
 * Nothing here ever sets HTML: every character that reaches the DOM arrives as a
 * text node, so content cannot inject markup.
 */

/** Pick the right language out of a localised string. */
export function localised(value: Localised | undefined, locale: string): string {
  if (!value) return "";
  const wanted = docLocale(locale);
  const text = value[wanted as keyof Localised] ?? value[DOC_FALLBACK];
  return text ?? "";
}

function inline(text: string, keyPrefix: string): React.ReactNode[] {
  return parseInline(text).map((token, i) => {
    const key = `${keyPrefix}-i${i}`;
    switch (token.kind) {
      case "code":
        return (
          <code className="mono" key={key}>
            {token.text}
          </code>
        );
      case "bold":
        return <strong key={key}>{token.text}</strong>;
      case "link":
        return token.href.startsWith("/") ? (
          <Link href={token.href} key={key}>
            {token.text}
          </Link>
        ) : (
          <a href={token.href} target="_blank" rel="noreferrer noopener" key={key}>
            {token.text}
          </a>
        );
      default:
        return <span key={key}>{token.text}</span>;
    }
  });
}

export function Markdown({ markdown }: { markdown: string }) {
  const blocks = parseBlocks(markdown);

  return (
    <div className="doc-body">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case "heading": {
            const level = block.level ?? 2;
            const text = block.text ?? "";
            if (level <= 1) return <h1 key={key}>{inline(text, key)}</h1>;
            if (level === 2) return <h2 key={key}>{inline(text, key)}</h2>;
            if (level === 3) return <h3 key={key}>{inline(text, key)}</h3>;
            return <h4 key={key}>{inline(text, key)}</h4>;
          }
          case "code":
            return (
              <pre key={key} className="doc-pre">
                <code className="mono-sm">{block.text}</code>
              </pre>
            );
          case "list":
            return (
              <ul key={key}>
                {(block.items ?? []).map((item, i) => (
                  <li key={`${key}-${i}`}>{inline(item, `${key}-${i}`)}</li>
                ))}
              </ul>
            );
          case "ordered":
            return (
              <ol key={key}>
                {(block.items ?? []).map((item, i) => (
                  <li key={`${key}-${i}`}>{inline(item, `${key}-${i}`)}</li>
                ))}
              </ol>
            );
          case "table":
            return (
              <div className="table-wrap" key={key}>
                <table className="data">
                  <thead>
                    <tr>
                      {(block.header ?? []).map((cell, i) => (
                        <th key={`${key}-h${i}`}>{inline(cell, `${key}-h${i}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(block.rows ?? []).map((row, r) => (
                      <tr key={`${key}-r${r}`}>
                        {row.map((cell, c) => (
                          <td key={`${key}-r${r}c${c}`}>{inline(cell, `${key}-r${r}c${c}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "quote":
            return (
              <blockquote className="doc-quote" key={key}>
                {inline(block.text ?? "", key)}
              </blockquote>
            );
          case "hr":
            return <hr className="doc-hr" key={key} />;
          default:
            return <p key={key}>{inline(block.text ?? "", key)}</p>;
        }
      })}
    </div>
  );
}
