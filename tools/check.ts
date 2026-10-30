/**
 * Project rule checker — run before every commit.
 *
 * Each check in this file exists because the corresponding mistake actually
 * happened here and was only caught by hand afterwards:
 *
 *   - `core` in `.gitignore` ignored `src/lib/core/`, so the repository could
 *     not compile while `git status` looked clean.
 *   - `PROXY` was read instead of `SPACE_SAFETY_PROXY`, so the documented
 *     setting was silently ignored.
 *   - Python tools were left behind and cannot be deployed the way the TS
 *     toolchain can.
 *   - A locale missing keys ships a half-translated screen with no error.
 *
 * Usage:  npm run check
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";

import { LOCALES, type Locale, validateMessages } from "../src/lib/i18n";
import { allTables } from "../src/lib/i18n/registry";

const ROOT = process.cwd();

interface Problem {
  check: string;
  detail: string;
}

const problems: Problem[] = [];
const notes: string[] = [];

function fail(check: string, detail: string): void {
  problems.push({ check, detail });
}

// --- 1. no Python anywhere ----------------------------------------------------
function checkNoPython(): void {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name === ".git" || name === "data") {
        continue;
      }
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(py|pyc|pyo)$/.test(name) || name === "__pycache__") {
        offenders.push(relative(ROOT, full));
      }
    }
  };
  for (const dir of ["src", "tools", "scripts", "tests", "proto"]) {
    const full = join(ROOT, dir);
    if (existsSync(full)) walk(full);
  }
  if (offenders.length) {
    fail("no-python", `${offenders.length} Python file(s) remain:\n    ${offenders.join("\n    ")}`);
  }

  // Checking for `.py` files is not enough: the rule is that no tool is written in
  // Python, and a one-liner (`python3 -c ...`, `python3 - <<EOF`) leaves no file
  // behind while being exactly the thing the rule forbids. Several patches were
  // applied that way during the v0.1.38–v0.1.42 range, which is why this scan
  // exists — it looks at what the tooling *invokes*, not only at what is checked in.
  const SCRIPTS = /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|sh)$/;
  // An *invocation*, not a mention: an argument must follow the name. That is what
  // separates a real call from a sentence naming the interpreter.
  const PY_CALL = /python[0-9.]*\s+(-c|-m|-<<|\S+\.py\b)/;
  const invokers: string[] = [];
  const scanInvocations = (dir: string) => {
    const full = join(ROOT, dir);
    if (!existsSync(full)) return;
    for (const name of readdirSync(full)) {
      const p = join(full, name);
      if (statSync(p).isDirectory()) {
        if (name !== "node_modules") scanInvocations(join(dir, name));
        continue;
      }
      if (!SCRIPTS.test(name)) continue;
      const text = readFileSync(p, "utf8");
      for (const [n, line] of text.split("\n").entries()) {
        // The rule's own description mentions the command name, so skip the line
        // that documents it rather than special-casing the file.
        const t = line.trimStart();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        if (PY_CALL.test(line)) {
          invokers.push(`${join(dir, name)}:${n + 1}  ${line.trim().slice(0, 90)}`);
          break;
        }
      }
    }
  };
  for (const dir of ["src", "tools", "scripts", "tests"]) scanInvocations(dir);
  if (invokers.length) {
    fail(
      "no-python",
      `${invokers.length} file(s) invoke python. Every tool in this project is TypeScript:\n    ${invokers.join("\n    ")}`,
    );
  }
}

// --- 2. .gitignore has no unanchored dangerous rule ---------------------------
function checkGitignore(): void {
  const path = join(ROOT, ".gitignore");
  if (!existsSync(path)) {
    fail("gitignore", "missing .gitignore");
    return;
  }
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  // A bare directory name matches at any depth. These are the ones that would
  // swallow source directories.
  const dangerous = ["core", "lib", "src", "app", "api", "db", "data", "tools", "scripts", "tests"];
  for (const line of lines) {
    const bare = line.replace(/^\//, "").replace(/\/$/, "");
    const isAnchored = line.startsWith("/") || line.includes("/");
    if (!isAnchored && dangerous.includes(bare)) {
      fail(
        "gitignore",
        `unanchored rule "${line}" also matches nested directories such as src/lib/${bare}/`,
      );
    }
  }
}

// --- 3. every kernel file is actually tracked ---------------------------------
function checkTracked(): void {
  let tracked: string[];
  try {
    tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    fail("tracked", "not a git working tree; cannot verify tracked files");
    return;
  }
  const kernel = tracked.filter((f) => f.startsWith("src/lib/core/"));
  if (kernel.length < 8) {
    fail(
      "tracked",
      `only ${kernel.length} kernel file(s) tracked under src/lib/core/ — expected at least 8`,
    );
  }
  for (const required of [
    "src/lib/core/screening.ts",
    "src/lib/core/alfano.ts",
    "src/lib/core/propagator.ts",
    "src/lib/core/linalg.ts",
  ]) {
    if (!tracked.includes(required)) fail("tracked", `${required} is not committed`);
  }
}

// --- 4. no secrets or data staged ---------------------------------------------
function checkNoSecrets(): void {
  let staged: string[];
  try {
    staged = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return;
  }
  const patterns: Array<[RegExp, string]> = [
    [/^\.env\.local$/, "credentials"],
    [/^certs\/.*\.key$/, "private key"],
    [/\.sqlite(-wal|-shm)?$/, "database"],
    [/^data\/ephemeris-cache\//, "ephemeris cache"],
  ];
  for (const file of staged) {
    for (const [pattern, what] of patterns) {
      if (pattern.test(file)) fail("no-secrets", `${file} (${what}) is tracked`);
    }
  }

  // Checking the *filenames* is not enough: a token pasted into a source file or
  // a README is tracked and ships with the repository just the same. A Cesium ion
  // access token and a JWT share the `header.payload.signature` shape, so one
  // pattern covers both.
  const token = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
  for (const file of staged) {
    if (!SOURCE_FILE.test(file)) continue;
    const text = safeRead(join(ROOT, file));
    if (text && token.test(text)) {
      fail("no-secrets", `${file} contains what looks like a JWT / ion token`);
    }
  }
}

/** Text files worth scanning for credentials; binaries and assets are skipped. */
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|sql|proto|yml|yaml|txt)$/;

/** Read a file, returning null when it is unreadable. */
function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// --- 5. i18n tables -----------------------------------------------------------
function checkI18n(): void {
  const tables = allTables();
  const missingLocale = LOCALES.filter((l) => !(l in tables));
  if (missingLocale.length) fail("i18n", `missing table(s): ${missingLocale.join(", ")}`);

  // `allTables()` is already `Record<Locale, Messages>`; the cast is only to
  // strip the narrower literal types the table modules carry.
  const audit = validateMessages(tables as unknown as Record<Locale, Record<string, string>>);
  for (const entry of audit.missing) {
    fail("i18n", `${entry.locale} is missing ${entry.keys.length} key(s): ${entry.keys.join(", ")}`);
  }
  for (const entry of audit.extra) {
    fail("i18n", `${entry.locale} has ${entry.keys.length} key(s) absent from en: ${entry.keys.join(", ")}`);
  }
  for (const entry of audit.empty) {
    fail("i18n", `${entry.locale} has ${entry.keys.length} empty value(s): ${entry.keys.join(", ")}`);
  }
  if (audit.ok) notes.push(`i18n: ${LOCALES.length} locales x ${Object.keys(tables.en).length} keys`);
}


// --- 5b. every key a page references exists -----------------------------------
/**
 * Catch a key that a page uses but no table defines.
 *
 * `checkI18n` only compares locales with each other, so a key deleted from
 * *every* locale at once keeps the tables consistent while the page renders its
 * key name verbatim (visible once as `conjunctionsPage.title` in an <h1>). This
 * closes that gap.
 */
function checkReferencedKeys(): void {
  const known = new Set(Object.keys(allTables().en));
  const referenced = new Map<string, string[]>();

  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(name)) continue;
      if (full.includes(join("lib", "i18n"))) continue;
      const text = readFileSync(full, "utf8");
      for (const match of text.matchAll(/t\.t\(\s*"([A-Za-z0-9_.]+)"/g)) {
        const key = match[1];
        if (known.has(key)) continue;
        const list = referenced.get(key) ?? [];
        list.push(relative(ROOT, full));
        referenced.set(key, list);
      }
    }
  };

  for (const dir of ["src/app", "src/components"]) {
    const full = join(ROOT, dir);
    if (existsSync(full)) walk(full);
  }

  for (const [key, files] of referenced) {
    fail("i18n-missing-key", `"${key}" is used in ${[...new Set(files)].join(", ")} but not defined`);
  }
}

// --- 6. version consistency ---------------------------------------------------
/**
 * Versions recorded with no tag of their own, and why.
 *
 * The rule is "one commit, one version, in four places at once". These three
 * broke it in ways that cannot be repaired honestly:
 *
 *   0.1.0   the baseline entry, written before the repository had a version
 *           history to tag; there is no commit that is "the 0.1.0 release"
 *   0.1.15  its work was committed together with 0.1.16
 *   0.1.17  its work was committed together with 0.1.18
 *
 * Retro-tagging any of them would put a tag on a commit that also carries a
 * different version's changes — a worse lie than an explained gap. They stay in
 * the CHANGELOG; deleting history to satisfy a check is not a fix either. Every
 * other version, past or future, must have both an entry and a tag.
 */
const UNTAGGED_BY_DESIGN = new Map([
  ["0.1.0", "baseline entry, no corresponding commit"],
  ["0.1.15", "committed together with 0.1.16"],
  ["0.1.17", "committed together with 0.1.18"],
]);

function checkVersion(): void {
  const read = (file: string): string | null => {
    if (!existsSync(join(ROOT, file))) return null;
    return readFileSync(join(ROOT, file), "utf8");
  };
  const pkgRaw = read("package.json");
  if (!pkgRaw) {
    fail("version", "package.json is missing");
    return;
  }
  const version = JSON.parse(pkgRaw).version as string;

  const lockRaw = read("package-lock.json");
  if (lockRaw) {
    const lockVersion = JSON.parse(lockRaw).version as string;
    if (lockVersion !== version) {
      fail("version", `package-lock.json ${lockVersion} != package.json ${version}`);
    }
  }

  // Every entry, not only the newest. Checking the first line alone let four
  // tagged releases ship without an entry and two entries exist with no tag,
  // while `npm run check` reported "version: ok" throughout.
  const changelog = read("CHANGELOG.md") ?? "";
  const documented = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
  const first = documented[0];
  if (!first) {
    fail("version", "CHANGELOG.md has no versioned entry");
  } else if (first !== version) {
    fail("version", `CHANGELOG.md newest entry ${first} != package.json ${version}`);
  }
  const duplicates = documented.filter((v, i) => documented.indexOf(v) !== i);
  if (duplicates.length) fail("version", `CHANGELOG.md repeats ${[...new Set(duplicates)].join(", ")}`);

  let tags: string[] = [];
  try {
    tags = execFileSync("git", ["tag", "--list", "v*"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .map((t) => t.trim().replace(/^v/, ""))
      .filter(Boolean);
  } catch {
    notes.push("version: not a git working tree; skipped tag comparison");
  }

  if (tags.length) {
    const tagged = new Set(tags);
    const documentedSet = new Set(documented);
    const tagWithoutEntry = tags.filter((t) => !documentedSet.has(t));
    const entryWithoutTag = documented.filter((v) => !tagged.has(v) && !UNTAGGED_BY_DESIGN.has(v));
    if (tagWithoutEntry.length) {
      fail("version", `${tagWithoutEntry.length} tag(s) have no CHANGELOG entry: ${tagWithoutEntry.join(", ")}`);
    }
    if (entryWithoutTag.length) {
      fail("version", `${entryWithoutTag.length} CHANGELOG entr(y/ies) have no tag: ${entryWithoutTag.join(", ")}`);
    }
    // The tag for the current release must also be the one on HEAD.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    if (!tagged.has(version)) {
      notes.push(`version: HEAD is not tagged v${version} yet (tag it once this commit passes)`);
    } else {
      const taggedAt = execFileSync("git", ["rev-list", "-n", "1", `v${version}`], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim();
      if (taggedAt !== head) {
        notes.push(`version: HEAD is ahead of v${version} (tag it once this commit passes)`);
      }
    }
  }

  notes.push(`version: ${version} (${documented.length} entries, ${tags.length} tags)`);
}

// --- 7. hard-coded UI text ----------------------------------------------------
/**
 * Find user-visible text that bypasses the dictionary.
 *
 * ## Why this parses instead of matching lines
 *
 * The previous version scanned `.tsx` files line by line for `>Text<` and for
 * `placeholder`/`title`/`aria-label` attributes. That misses every string that is
 * not a JSX text node: label tables, `Record<string, string>` maps, anything in a
 * `.ts` module. It reported "ok" while `/browse` rendered 载荷 PAYLOAD,
 * 空间碎片 DEBRIS and 未分类 UNKNOWN in all six languages, `/catalogue` rendered
 * its whole field-coverage table in Chinese, and `/statistics` rendered 低轨 LEO.
 * 85 lines of Chinese copy lived in `src/app` and `src/components` alone.
 *
 * So: parse each file with the TypeScript compiler and look at what is actually a
 * string — `StringLiteral`, template tokens, JSX text. Comments are not strings
 * and stay free to be written in any language the author likes, which is why
 * every module in this repository carries Chinese commentary.
 *
 * ## The one exemption
 *
 * `src/lib/sources/` is ingest tooling: it talks to upstream APIs and to a
 * language model, and its strings are prompts and diagnostics that never reach a
 * reader. Nothing there renders.
 */
function checkHardcodedText(): void {
  const offenders: string[] = [];
  const CJK = /[\u4e00-\u9fff]/;
  /** A JSX text node worth flagging: starts like a word, has letter content. */
  const WORDY = /^[A-Z][A-Za-z][^<>{}]{2,}$/;

  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name === ".next-audit") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(name)) continue;
      // The dictionary itself is where the translations live.
      if (full.includes(join("lib", "i18n"))) continue;
      const ingest = full.includes(join("src", "lib", "sources"));

      const text = readFileSync(full, "utf8");
      const sf = ts.createSourceFile(
        full,
        text,
        ts.ScriptTarget.ESNext,
        true,
        name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const where = (node: ts.Node): string => {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        return `${relative(ROOT, full)}:${line + 1}`;
      };

      const visit = (node: ts.Node): void => {
        if (!ingest && (ts.isStringLiteralLike(node) || ts.isJsxText(node))) {
          const value = ts.isJsxText(node) ? node.text.trim() : node.text;
          if (value && CJK.test(value)) {
            offenders.push(`${where(node)}  "${value.slice(0, 40)}" — 文案必须来自字典`);
          }
        }
        if (ts.isJsxText(node) && WORDY.test(node.text.trim())) {
          offenders.push(`${where(node)}  "${node.text.trim().slice(0, 40)}" — JSX 里写死了英文`);
        }
        if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
          const attr = node.name.getText(sf);
          if (/^(placeholder|title|aria-label)$/.test(attr) && /^[A-Za-z][^"]{2,}$/.test(node.initializer.text)) {
            offenders.push(`${where(node)}  ${attr}="${node.initializer.text.slice(0, 40)}"`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  };

  walk(join(ROOT, "src"));

  if (offenders.length) {
    fail(
      "i18n-hardcoded",
      `${offenders.length} hard-coded string(s) bypass the dictionary:\n    ${offenders
        .slice(0, 25)
        .join("\n    ")}${offenders.length > 25 ? `\n    … ${offenders.length - 25} more` : ""}`,
    );
    return;
  }
  notes.push("i18n-hardcoded: every string under src/ comes from the dictionary");
}

// --- 8. VI compliance ---------------------------------------------------------
/**
 * Enforce the parts of the spaceribre VI that a code change can break silently:
 *
 *   - a colour literal outside the palette module opts the page out of the
 *     theme, which the VI forbids;
 *   - a monochrome logo master must keep exactly one ink;
 *   - the full-colour masters must have a themed planet (a frozen navy planet
 *     next to a changing palette is called out in the VI as a defect).
 */
function checkVi(): void {
  const paletteFile = join(ROOT, "src", "lib", "vi", "palette.ts");
  const tokensFile = join(ROOT, "src", "app", "vi-tokens.css");

  if (!existsSync(paletteFile)) {
    fail("vi", "src/lib/vi/palette.ts is missing");
  }
  if (!existsSync(tokensFile)) {
    fail("vi", "src/app/vi-tokens.css is missing; run `npm run vi`");
  }

  // 8a. No hex literals in UI styles outside the generated tokens.
  const globals = join(ROOT, "src", "app", "globals.css");
  if (existsSync(globals)) {
    const lines = readFileSync(globals, "utf8").split("\n");
    const offenders = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /#[0-9a-fA-F]{3,8}\b/.test(line) && !line.trim().startsWith("/*"))
      .map(({ line, index }) => `globals.css:${index + 1}  ${line.trim()}`);
    if (offenders.length) {
      fail(
        "vi",
        `${offenders.length} colour literal(s) outside the palette:\n    ${offenders.slice(0, 10).join("\n    ")}`,
      );
    }
  }

  // 8b. Scene code must not carry its own colours. Every renderer takes its
  //     numbers from SceneTheme, so a literal here means one layer would survive
  //     a theme switch while the rest of the page changed.
  const sceneDir = join(ROOT, "src", "components", "cesium");
  if (existsSync(sceneDir)) {
    const offenders: string[] = [];
    for (const file of readdirSync(sceneDir)) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      const text = readFileSync(join(sceneDir, file), "utf8");
      const matches = text.match(/#[0-9a-fA-F]{6}\b|0x[0-9a-fA-F]{6}\b/g) ?? [];
      if (matches.length) offenders.push(`cesium/${file}: ${matches.join(", ")}`);
    }
    if (offenders.length) {
      fail("vi", `hard-coded 3D colour(s) outside the palette:\n    ${offenders.join("\n    ")}`);
    }
  }

  // 8c. Logo masters present, and monochrome ones single-ink.
  const logoDir = join(ROOT, "public", "vi");
  if (!existsSync(logoDir)) {
    fail("vi", "public/vi is missing; run `npm run vi`");
  } else {
    for (const variant of ["dark", "light"] as const) {
      const file = join(logoDir, `icon-primary-${variant}.svg`);
      if (!existsSync(file)) {
        fail("vi", `public/vi/icon-primary-${variant}.svg is missing`);
        continue;
      }
      const svg = readFileSync(file, "utf8");
      if (!svg.includes('data-color-role="planet"')) {
        fail("vi", `${variant} logo has no themed planet`);
      }
    }
    for (const ink of ["black", "white", "navy"]) {
      const file = join(logoDir, `icon-${ink}.svg`);
      if (!existsSync(file)) {
        fail("vi", `public/vi/icon-${ink}.svg is missing`);
        continue;
      }
      const svg = readFileSync(file, "utf8");
      // Monochrome: every painted value must be that one ink.
      const painted = new Set(
        [...svg.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{3,8})"/g)].map((m) => m[1].toLowerCase()),
      );
      if (painted.size > 1) {
        fail("vi", `icon-${ink}.svg is monochrome but uses ${painted.size} inks: ${[...painted].join(", ")}`);
      }
    }
  }

  // 8d. No component may carry its own colours.
  //
  // §9 checks the stylesheet and the 3D scene, which left the SVG charts out: they
  // held eleven hex literals of their own (#2ec27e, #4d4d4d, #6b6b6b …) and stayed
  // on dark-mode values after a switch to light. Only the two palette modules may
  // name a colour; everything else reads one.
  const colourCarriers = new Set(["palette.ts", "theme-bridge.ts"]);
  const offenders: string[] = [];
  const scanColourLiterals = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        scanColourLiterals(full);
        continue;
      }
      if (!/\.tsx?$/.test(name) || colourCarriers.has(name)) continue;
      const text = readFileSync(full, "utf8");
      const sf = ts.createSourceFile(
        full,
        text,
        ts.ScriptTarget.ESNext,
        true,
        name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && /#[0-9a-fA-F]{3,8}\b/.test(node.text)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
          offenders.push(`${relative(ROOT, full)}:${line + 1}  "${node.text.slice(0, 30)}"`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  };
  scanColourLiterals(join(ROOT, "src", "app"));
  scanColourLiterals(join(ROOT, "src", "components"));
  if (offenders.length) {
    fail(
      "vi",
      `${offenders.length} colour literal(s) outside the palette modules:\n    ${offenders
        .slice(0, 10)
        .join("\n    ")}`,
    );
  }

  if (!problems.some((p) => p.check === "vi")) {
    notes.push("vi: palette, tokens, scene, logo masters and components consistent");
  }
}

// --- 10. every emitted client chunk is valid JavaScript -----------------------
/**
 * Parse the build's client chunks.
 *
 * This check exists because of the worst bug this project has shipped: the
 * production minifier re-escaped a WebAssembly literal inside Cesium's
 * `@spz-loader/core`, turning a NUL byte followed by a digit into `\00` — an
 * illegal octal escape in a template literal. The whole chunk was a SyntaxError,
 * so `import("cesium")` never resolved and the home page's 3D view never
 * appeared. `tsc` passed, all 35 test suites passed, `npm run check` passed and
 * every page returned 200; only a browser could see it, and only in a production
 * build, because dev chunks are not minified.
 *
 * Parsing the artefacts is the one check that catches the whole class: whatever
 * future dependency ships a blob a minifier mishandles, this fails before the
 * build leaves the machine.
 */
function checkBuildArtifacts(): void {
  const dir = join(ROOT, ".next", "static", "chunks");
  if (!existsSync(dir)) {
    notes.push("build-artifacts: no build present (run `npm run build` to include this check)");
    return;
  }

  const chunks: string[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".js")) chunks.push(full);
    }
  };
  walk(dir);

  const broken: string[] = [];
  let index = 0;
  for (const chunk of chunks) {
    // `node --check` picks the module system from the extension, and a chunk with
    // `import` must be parsed as ESM, so the copy carries `.mjs`. Copying also
    // keeps the check away from files `next dev` is rewriting underneath us.
    const scratch = join(tmpdir(), `spacesafety-chunk-${process.pid}-${index++}.mjs`);
    copyFileSync(chunk, scratch);
    try {
      execFileSync(process.execPath, ["--check", scratch], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 120_000,
      });
    } catch (err) {
      const stderr = String((err as { stderr?: Buffer }).stderr ?? "");
      const reason = stderr.split("\n").find((l) => /Error/.test(l))?.trim() ?? "does not parse";
      broken.push(`${relative(ROOT, chunk)}  ${reason}`);
    } finally {
      rmSync(scratch, { force: true });
    }
  }

  if (broken.length) {
    fail(
      "build-artifacts",
      `${broken.length} of ${chunks.length} client chunk(s) are not valid JavaScript:\n    ${broken
        .slice(0, 8)
        .join("\n    ")}`,
    );
    return;
  }
  notes.push(`build-artifacts: ${chunks.length} client chunk(s) parse`);
}

// --- run ----------------------------------------------------------------------
const CHECKS: Array<[string, () => void]> = [
  ["no-python", checkNoPython],
  ["gitignore", checkGitignore],
  ["tracked", checkTracked],
  ["no-secrets", checkNoSecrets],
  ["i18n", checkI18n],
  ["i18n-missing-key", checkReferencedKeys],
  ["version", checkVersion],
  ["i18n-hardcoded", checkHardcodedText],
  ["vi", checkVi],
  ["build-artifacts", checkBuildArtifacts],
];

console.log("\nSpace Safety — project rules\n");
for (const [name, run] of CHECKS) {
  const before = problems.length;
  try {
    run();
  } catch (err) {
    fail(name, `check threw: ${(err as Error).message}`);
  }
  const added = problems.length - before;
  console.log(`  ${added === 0 ? "ok  " : "FAIL"} ${name}`);
}

if (notes.length) {
  console.log("");
  for (const note of notes) console.log(`  · ${note}`);
}

if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n`);
  for (const p of problems) console.log(`  [${p.check}] ${p.detail}\n`);
  process.exit(1);
}

console.log("\nAll checks passed.\n");
