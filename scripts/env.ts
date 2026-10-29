/**
 * Minimal `.env.local` loader for standalone scripts.
 *
 * Next.js loads `.env.local` for the app, but a script run through tsx does not go
 * through that loader, so a backfill or a demo seed would behave differently from
 * the server it is preparing data for — silently, because the missing variable
 * only surfaces as "not configured" deep inside a data source.
 *
 * Only `.env.local` is read: it is the file that holds secrets, it is already in
 * `.gitignore`, and reading a broader set (`.env`, `.env.development`, ...) would
 * reproduce Next's precedence rules badly. Existing `process.env` values always
 * win, so an explicit export still overrides the file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadEnvLocal(cwd = process.cwd()): string[] {
  const path = join(cwd, ".env.local");
  if (!existsSync(path)) return [];

  const loaded: string[] = [];
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip one layer of surrounding quotes, matching how Next treats them.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}
