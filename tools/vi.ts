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

import {
  ELECTRIC_ORBIT,
  contrastRatio,
  mix,
  themeSurfaces,
  withAlpha,
  type ViPalette,
} from "../src/lib/vi/palette";

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
  const dark = themeSurfaces(palette, "dark");
  const light = themeSurfaces(palette, "light");

  // The declarations only: the braces are written by the caller. An earlier
  // version emitted `${selector} {` and stripped it again with a regex, which
  // quietly stopped matching when the first line changed — leaving a stray `{`
  // after `[data-theme="light"] {` and breaking the whole stylesheet.
  const block = (surfaces: typeof dark) =>
    [
      ...Object.entries(surfaces).map(([key, value]) =>
        key === "mode" ? null : `  --${kebab(key)}: ${value};`,
      ).filter((line): line is string => line !== null),
      `  --color-primary: ${surfaces.primary};`,
      `  --color-secondary: ${palette.secondary};`,
      `  --color-accent: ${palette.accent};`,
      `  --color-success: ${palette.success};`,
      `  --color-warning: ${palette.warning};`,
      `  --color-danger: ${palette.danger};`,
      // Risk bands map onto semantic roles, never onto decorative accents: a
      // high-risk conjunction must stay red if the palette is ever re-themed.
      `  --risk-high: ${palette.danger};`,
      `  --risk-medium: ${palette.warning};`,
      `  --risk-low: ${palette.success};`,
      `  --risk-unknown: ${surfaces.textFaint};`,
      `  --color-planet: ${surfaces.mode === "dark" ? palette.planetOnDark : palette.planetOnLight};`,
      `  --glow-primary: ${withAlpha(surfaces.primary, 0.28)};`,
      `  --tint-primary: ${withAlpha(surfaces.primary, 0.08)};`,
      `  --tint-success: ${withAlpha(palette.success, 0.12)};`,
      `  --tint-danger: ${withAlpha(palette.danger, 0.12)};`,
      `  --tint-warning: ${withAlpha(palette.warning, 0.12)};`,
      // Derived surfaces the shell and the 3D canvas share, so a theme change
      // reaches the orbital view instead of leaving it on a fixed backdrop.
      // These were emitted by an earlier revision of this file and were lost when
      // it was rewritten; the stylesheet still references all three.
      `  --viewer-center: ${mix(surfaces.bg, palette.primary, surfaces.mode === "dark" ? 0.07 : 0.05)};`,
      `  --overlay: ${surfaces.mode === "dark" ? withAlpha(palette.deep, 0.72) : withAlpha("#FFFFFF", 0.82)};`,
      `  --on-primary: #FFFFFF;`,
      // -------------------------------------------------------------- aliases
      //
      // `globals.css` was written against a naming scheme this generator never
      // emitted, so eight `var()` references resolved to nothing. CSS does not
      // warn on an undefined custom property — the whole declaration is dropped —
      // so the sidebar had no width, the hover and diff-stripe backgrounds were
      // transparent, and the status colours were inherited from a parent.
      //
      // The aliases live here rather than as a rename in `globals.css` so the
      // token file stays the only place that names colours: a future palette
      // change reaches every alias at once.
      `  --bg-elev-1: ${surfaces.bgElev};`,
      `  --bg-elev-2: ${surfaces.bgElev2};`,
      `  --bg-label: ${surfaces.bgElev2};`,
      `  --ok: ${palette.success};`,
      `  --bad: ${palette.danger};`,
      // The two ephemeris-source colours. An operator-supplied ephemeris is drawn
      // in the primary, a SpaceX optical pass in the accent, so the two can be told
      // apart on the same canvas.
      `  --operator-ephemeris: ${surfaces.primary};`,
      `  --spacex-optical: ${palette.accent};`,
      // A layout constant rather than a colour, sized by the VI rather than by
      // taste: the navigation uses the *horizontal* master (810 x 180), the VI
      // gives it a recommended minimum display width of 240 px, and the mark
      // needs clear space of 25% of its canvas height on every side. At 240 px
      // wide the mark is 53.3 px tall, so the clear space is 13.3 px and the rail
      // must be at least 240 + 2 x 13.3 = 266.7 px. 272 px leaves the rounding.
      `  --sidebar-w: 272px;`,
    ].join("\n");

  const css = [
    `/* Generated by tools/vi.ts from ${palette.name} — do not edit by hand. */`,
    ``,
    `/* Dark is the product default: the orbital view reads best on a dark canvas. */`,
    `:root,\n[data-theme="dark"] {`,
    block(dark),
    `}`,
    ``,
    `[data-theme="light"] {`,
    block(light),
    `}`,
    ``,
  ].join("\n");

  const out = join(ROOT, "src", "app", "vi-tokens.css");
  writeFileSync(out, css, "utf8");
  return out;
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
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
  if (argv.includes("--audit")) {
    console.log("\ncontrast:");
    for (const row of auditContrast(palette)) {
      console.log(`  ${row.ok ? "ok  " : "FAIL"} ${row.pair}: ${row.ratio.toFixed(2)}:1`);
    }
  }
}

void main();
