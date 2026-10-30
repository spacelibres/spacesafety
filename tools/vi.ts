/**
 * Generate the VI-derived assets from the palette.
 *
 * Two outputs, both derived rather than hand-edited:
 *
 *   - `src/app/vi-tokens.css` — the 16 palette roles plus per-theme surface
 *     variables, emitted as `:root` (dark, the product default) and
 *     `[data-theme="light"]`.
 *   - `public/vi/*.svg` and `src/app/icon.svg` — the logo masters with the
 *     full-colour roles bound to the palette.
 *
 * ## Why monochrome masters are copied verbatim
 *
 * The VI is explicit: monochrome artwork keeps exactly one ink and must not
 * receive auxiliary roles. So `*-black`, `*-white` and `*-navy` are copied
 * byte-for-byte from the VI repository, and only `*-primary` is recoloured —
 * there the planet takes `planetOn*` and the orbit `primary`.
 *
 * The masters themselves are read from the spacelibre-vi skill's `assets/`
 * directory when present, and from `design/vi-source/` otherwise, so a fresh
 * clone of this repository can regenerate every asset without the skill.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ELECTRIC_ORBIT, contrastRatio, themeSurfaces, type ViPalette } from "../src/lib/vi/palette";
import { tokenCss } from "../src/lib/vi/tokens";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const MASTER_DIRS = [
  join(ROOT, "design", "vi-source"),
  "/home/stone/.agents/skills/spacelibre-vi/assets",
];

/** Where the logo masters live; throws with a usable message when absent. */
export function masterDir(): string {
  for (const dir of MASTER_DIRS) {
    if (existsSync(join(dir, "icon-primary.svg"))) return dir;
  }
  throw new Error(
    `logo masters not found. Copy them from https://github.com/spacelibres/vi into ${MASTER_DIRS[0]}/`,
  );
}

/** Write `src/app/vi-tokens.css` from the palette. */
export function emitTokens(palette: ViPalette): string {
  const out = join(ROOT, "src", "app", "vi-tokens.css");
  writeFileSync(out, tokenCss(palette), "utf8");
  return out;
}

/**
 * Recolour a full-colour master.
 *
 * The masters carry `data-stroke-role="planet"` on the circle and a literal fill
 * on the orbit path. The planet is rebound to the palette's planet role, and the
 * orbit fill (the original `#007bff`) to the contextual primary. Everything
 * else — masks, transforms, path geometry — is preserved exactly, because the
 * VI prohibits reconstructing the mark.
 */
export function recolourMaster(svg: string, palette: ViPalette, surface: "dark" | "light"): string {
  const planet = surface === "dark" ? palette.planetOnDark : palette.planetOnLight;
  const primary = surface === "dark" ? palette.primaryOnDark : palette.primaryOnLight;
  return svg
    .replace(/(<circle[^>]*data-stroke-role="planet")/g, `$1 data-color-role="planet"`)
    // The masters carry the planet stroke as `#002044` — the VI's deep navy, not
    // the primary. Matching only `#007bff` therefore left every logo with a navy
    // planet while the token file said the planet was red, so the mark and the
    // 3D view disagreed about what colour the planet is. Both values are accepted
    // because the source SVGs have shipped as each of them at different times.
    .replace(/(<circle[^>]*stroke=")#002044(")/gi, `$1${planet}$2`)
    .replace(/(<circle[^>]*stroke=")#007bff(")/gi, `$1${planet}$2`)
    .replace(/(<path[^>]*fill=")#002044(")/gi, `$1${primary}$2`)
    .replace(/(<path[^>]*fill=")#007bff(")/gi, `$1${primary}$2`);
}

/**
 * Bind a full-colour master's two colour roles to the token variables.
 *
 * The static files in `public/vi` bake one palette, which was fine while there
 * was exactly one scheme. Now that the explorer can derive any scheme from any
 * primary, a baked logo would be the one element left on the old colours — the VI
 * requires "SVG 标志与辅助图形" to move with the rest. Presentation attributes
 * cannot take `var()`, but a `style` declaration can, so the roles become
 * `style="stroke:var(--color-planet)"` and `style="fill:var(--color-primary)"`.
 *
 * The masks keep their literal black/white: the VI states that the structural
 * colours never participate in theming.
 */
export function themedMark(svg: string): string {
  return svg
    .replace(/(<circle[^>]*data-stroke-role="planet")/g, `$1 data-color-role="planet"`)
    .replace(/<circle([^>]*?)stroke="#002044"/gi, `<circle$1style="stroke:var(--color-planet)"`)
    .replace(/<circle([^>]*?)stroke="#007bff"/gi, `<circle$1style="stroke:var(--color-planet)"`)
    .replace(/<path([^>]*?)fill="#002044"/gi, `<path$1style="fill:var(--color-primary)"`)
    .replace(/<path([^>]*?)fill="#007bff"/gi, `<path$1style="fill:var(--color-primary)"`);
}

/**
 * Write `src/lib/vi/logo-marks.ts` — the layout and icon masters, bound to the
 * tokens, importable by the component that renders the mark inline.
 */
export function emitLogoMarks(): string {
  const source = masterDir();
  const marks: Record<string, string> = {};
  for (const layout of ["horizontal", "stacked", "icon"] as const) {
    const svg = readFileSync(join(source, `${layout}-primary.svg`), "utf8");
    marks[layout] = themedMark(svg).replace(/\s*\n\s*/g, " ");
  }
  const body = [
    "/**",
    " * Logo masters, generated by \`npm run vi\` — do not edit.",
    " *",
    " * Colour roles are bound to \`var(--color-planet)\` / \`var(--color-primary)\`, so one",
    " * inline mark follows every scheme the VI's explorer can derive. Structural",
    " * mask colours stay literal black/white, as the VI requires.",
    " */",
    "",
    `export const LOGO_MARKS: Record<"horizontal" | "stacked" | "icon", string> = {`,
    ...Object.entries(marks).map(([name, svg]) => `  ${name}: ${JSON.stringify(svg)},`),
    "};",
    "",
  ].join("\n");
  const out = join(ROOT, "src", "lib", "vi", "logo-marks.ts");
  writeFileSync(out, body, "utf8");
  return out;
}

/** Copy monochrome masters verbatim and recolour the full-colour ones. */
export function emitLogos(palette: ViPalette): string[] {
  const source = masterDir();
  const written: string[] = [];

  const publicDir = join(ROOT, "public", "vi");
  mkdirSync(publicDir, { recursive: true });

  for (const name of readdirSync(source)) {
    if (!name.endsWith(".svg")) continue;
    const svg = readFileSync(join(source, name), "utf8");

    if (!name.includes("primary")) {
      // Monochrome: one ink, never themed.
      writeFileSync(join(publicDir, name), svg, "utf8");
      written.push(name);
      continue;
    }

    for (const surface of ["dark", "light"] as const) {
      const themed = recolourMaster(svg, palette, surface);
      const file = name.replace("primary", `primary-${surface}`);
      writeFileSync(join(publicDir, file), themed, "utf8");
      written.push(file);

      // The favicon follows the same rule: a themed planet, not a frozen one.
      if (surface === "dark" && name === "icon-primary.svg") {
        writeFileSync(join(ROOT, "src", "app", "icon.svg"), themed, "utf8");
        written.push("src/app/icon.svg");
      }
    }
  }
  return written;
}

/** Report contrast for the pairs the VI requires to be legible. */
export function auditContrast(palette: ViPalette): Array<{
  pair: string;
  ratio: number;
  required: number;
  ok: boolean;
}> {
  const dark = themeSurfaces(palette, "dark");
  const light = themeSurfaces(palette, "light");
  const rows = [
    { pair: "dark: text on bg", a: dark.text, b: dark.bg, required: 4.5 },
    { pair: "dark: dim text on bg", a: dark.textDim, b: dark.bg, required: 4.5 },
    { pair: "dark: primary on bg", a: dark.primary, b: dark.bg, required: 4.5 },
    { pair: "dark: danger on bg", a: palette.danger, b: dark.bg, required: 4.5 },
    { pair: "dark: warning on bg", a: palette.warning, b: dark.bg, required: 4.5 },
    { pair: "dark: success on bg", a: palette.success, b: dark.bg, required: 4.5 },
    { pair: "light: text on bg", a: light.text, b: light.bg, required: 4.5 },
    { pair: "light: dim text on bg", a: light.textDim, b: light.bg, required: 4.5 },
    { pair: "light: primary on bg", a: light.primary, b: light.bg, required: 4.5 },
    { pair: "light: danger on surface", a: palette.danger, b: light.bg, required: 4.5 },
    { pair: "light: warning on surface", a: palette.warning, b: light.bg, required: 4.5 },
    { pair: "light: success on surface", a: palette.success, b: light.bg, required: 4.5 },
  ];
  return rows.map((row) => {
    const ratio = contrastRatio(row.a, row.b);
    return { ...row, ratio, ok: ratio >= row.required };
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const palette = ELECTRIC_ORBIT;
  const tokens = emitTokens(palette);
  console.log(`tokens  ${tokens}`);
  const logos = emitLogos(palette);
  console.log(`logos   ${logos.length} file(s) in public/vi`);
  console.log(`marks   ${emitLogoMarks()}`);
  if (argv.includes("--audit")) {
    console.log("\ncontrast:");
    for (const row of auditContrast(palette)) {
      console.log(`  ${row.ok ? "ok  " : "FAIL"} ${row.pair}: ${row.ratio.toFixed(2)}:1`);
    }
  }
}

void main();
