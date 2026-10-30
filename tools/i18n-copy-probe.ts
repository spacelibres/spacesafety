/**
 * Render the "no data" panels in every locale and report what came out.
 *
 * ## Why a probe rather than a plain test
 *
 * `npm test` runs each suite with `--conditions=react-server`, and under that
 * condition `react-dom/server` resolves to React's RSC stub, which throws on
 * import. Dropping the condition narrows something else instead, so the render
 * happens here, in a child process, exactly as `tools/chart-probe.ts` does for the
 * Pc chart.
 *
 * Prints one JSON line: `{ "<locale>": { accuracy: string, elements: string } }`.
 * `tests/i18n-copy.test.ts` asserts on it.
 *
 *   node --import tsx tools/i18n-copy-probe.ts
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const LOCALES = ["zh-CN", "en", "es", "fr", "de", "ja"] as const;

/** Visible text of an HTML fragment: tags and scripts removed, whitespace folded. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class CopyProbe {
  private readonly React = require("react") as typeof import("react");

  async run(): Promise<Record<string, { accuracy: string; elements: string }>> {
    // tsx transpiles the .tsx sources with the classic runtime, which wants a
    // global `React`. The Next build uses the automatic runtime.
    (globalThis as { React?: unknown }).React = this.React;
    const { renderToStaticMarkup } = require("react-dom/server") as {
      renderToStaticMarkup: (el: unknown) => string;
    };

    const { AccuracyPanels } = (await import("../src/components/AccuracyPanels")) as {
      AccuracyPanels: import("react").ComponentType<{ report: never }>;
    };
    const { ElementsChart } = (await import("../src/components/Charts2")) as {
      ElementsChart: import("react").ComponentType<{ series: never[] }>;
    };
    const { I18nProvider } = (await import("../src/lib/i18n/client")) as {
      I18nProvider: import("react").ComponentType<{ locale: string; children?: unknown }>;
    };

    // A report with no samples takes the branch that renders the short message.
    const emptyReport = { axis: "R", horizonHours: 24, samples: [] };

    const out: Record<string, { accuracy: string; elements: string }> = {};
    for (const locale of LOCALES) {
      const wrap = (node: unknown): string =>
        renderToStaticMarkup(
          this.React.createElement(I18nProvider, { locale }, node as never),
        );
      out[locale] = {
        accuracy: textOf(wrap(this.React.createElement(AccuracyPanels, { report: emptyReport } as never))),
        elements: textOf(wrap(this.React.createElement(ElementsChart, { series: [] }))),
      };
    }
    return out;
  }
}

async function main(): Promise<void> {
  console.log(JSON.stringify(await new CopyProbe().run()));
}

void main();
