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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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

  const changelog = read("CHANGELOG.md") ?? "";
  const first = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  if (!first) {
    fail("version", "CHANGELOG.md has no versioned entry");
  } else if (first[1] !== version) {
    fail("version", `CHANGELOG.md newest entry ${first[1]} != package.json ${version}`);
  }

  try {
    const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const tagged = execFileSync("git", ["rev-list", "-n", "1", tag], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    if (tag.replace(/^v/, "") !== version) {
      fail("version", `git tag ${tag} != package.json ${version}`);
    } else if (tagged !== head) {
      // Expected while a release is being prepared; worth stating, not failing.
      notes.push(`version: HEAD is ahead of ${tag} (tag it once this commit passes)`);
    }
  } catch {
    notes.push("version: no git tag found yet");
  }

  notes.push(`version: ${version}`);
}

// --- 7. hard-coded UI text ----------------------------------------------------
/**
 * Find user-visible text that bypasses the dictionary.
 *
 * The heuristic looks for a JSX text node or a `placeholder`/`title`/`aria-label`
 * attribute with letter content. It deliberately ignores data attributes and
 * class names, and it skips the i18n module itself.
 */
function checkHardcodedText(): void {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx$/.test(name)) continue;
      if (full.includes(join("lib", "i18n"))) continue;
      const text = readFileSync(full, "utf8");
      text.split("\n").forEach((line, index) => {
        // JSX text nodes: `>Some words<`, but not `>{expr}<` or `> <`.
        const jsx = line.match(/>\s*([A-Z][A-Za-z][^<>{}]{2,})\s*</);
        if (jsx) offenders.push(`${relative(ROOT, full)}:${index + 1}  ${jsx[1].trim()}`);
        const attr = line.match(/(placeholder|title|aria-label)="([A-Za-z][^"]{2,})"/);
        if (attr) offenders.push(`${relative(ROOT, full)}:${index + 1}  ${attr[1]}="${attr[2]}"`);
      });
    }
  };
  const appDir = join(ROOT, "src", "app");
  const compDir = join(ROOT, "src", "components");
  if (existsSync(appDir)) walk(appDir);
  if (existsSync(compDir)) walk(compDir);

  if (offenders.length) {
    fail(
      "i18n-hardcoded",
      `${offenders.length} hard-coded string(s) bypass the dictionary:\n    ${offenders
        .slice(0, 20)
        .join("\n    ")}${offenders.length > 20 ? `\n    … ${offenders.length - 20} more` : ""}`,
    );
  }
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

  // 8b. Scene code must not carry its own colours.
  const viewer = join(ROOT, "src", "components", "OrbitViewer.tsx");
  if (existsSync(viewer)) {
    const text = readFileSync(viewer, "utf8");
    const hexes = text.match(/0x[0-9a-fA-F]{6}\b/g) ?? [];
    if (hexes.length) {
      fail("vi", `OrbitViewer.tsx has ${hexes.length} hard-coded 3D colour(s): ${hexes.join(", ")}`);
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

  if (!problems.some((p) => p.check === "vi")) {
    notes.push("vi: palette, tokens, scene and logo masters consistent");
  }
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
