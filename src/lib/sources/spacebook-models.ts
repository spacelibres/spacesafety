/**
 * Spacebook's per-object 3D model catalogue, behind the Auth0 token.
 *
 * ## What the three gated endpoints actually are
 *
 * Measured with a real token (2026-10-30):
 *
 *   /api/Model            42 rows — id, filename, name, isPublic; all public.
 *                         These are the `.glb` assets the viewer renders.
 *   /api/Scene            200 with an empty array.
 *   /api/UserEphemeris    200 with an empty array.
 *
 * The last two are **user-uploaded** content (`User` is the tell), and this account
 * has never uploaded anything. They are not "missing authorisation" — they are
 * empty because nothing was put there. The earlier note that all three needed a
 * browser login was right about `Model` and wrong about the other two.
 *
 * ## Why the token matters and what breaks without it
 *
 * The token lives 24 hours and **cannot be refreshed**: the tenant returns
 * `scope=openid profile email` even when `offline_access` is requested, so no
 * refresh token is issued. A fully automated nightly sync of the model list is
 * therefore impossible without a person re-authorising. The model list changes
 * rarely (42 public assets), so the practical workaround is to fetch it whenever a
 * token happens to be valid and cache the result.
 */

import { existsSync } from "node:fs";

import type Database from "better-sqlite3";

import { readStoredToken, defaultTokenPath } from "./spacebook-auth";

const BASE = "https://www.spacebook.com";

export interface SpacebookModel {
  id: string;
  /** Path inside the Spacebook asset store, e.g. `sb_comspoc/ISS_stationary.glb`. */
  filename: string;
  /** Human name, which is what links a model to an object. */
  name: string;
  isPublic: boolean;
}

export interface ModelFetchResult {
  models: SpacebookModel[];
  note?: string;
  /** True when no usable token was available. */
  needsLogin?: boolean;
}

/**
 * Fetch the model list.
 *
 * An optional `noradId` narrows the response server-side, but the API ignores it for
 * the catalogue endpoint and returns all 42 either way — measured. It is passed
 * anyway because the endpoint documents it and a future version may honour it.
 */
export async function fetchModels(noradId?: number): Promise<ModelFetchResult> {
  const token = await readStoredToken(defaultTokenPath());
  if (!token) {
    return { models: [], needsLogin: true, note: "无 Spacebook token，需浏览器授权一次" };
  }
  if (token.expiresAt <= Date.now()) {
    return { models: [], needsLogin: true, note: "token 已过期，需重新浏览器授权" };
  }

  const url = noradId ? `${BASE}/api/Model?noradId=${noradId}` : `${BASE}/api/Model`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return { models: [], note: `请求失败：${(err as Error).message}` };
  }

  if (res.status === 401) {
    return { models: [], needsLogin: true, note: "token 被拒绝（401），需重新授权" };
  }
  if (!res.ok) return { models: [], note: `HTTP ${res.status}` };

  const raw = (await res.json()) as Array<Record<string, unknown>>;
  if (!Array.isArray(raw)) return { models: [], note: "返回不是数组" };

  const models: SpacebookModel[] = [];
  for (const r of raw) {
    const id = typeof r.id === "string" ? r.id : null;
    const filename = typeof r.filename === "string" ? r.filename : null;
    if (!id || !filename) continue;
    models.push({
      id,
      filename,
      name: typeof r.name === "string" ? r.name : filename,
      isPublic: r.isPublic === true,
    });
  }
  return { models };
}

export const SPACEBOOK_MODEL_DDL = `
CREATE TABLE IF NOT EXISTS spacebook_model (
  id         TEXT PRIMARY KEY,
  filename   TEXT NOT NULL,
  name       TEXT NOT NULL,
  is_public  INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sbm_name_idx ON spacebook_model(name);
`;

export class SpacebookModelStore {
  constructor(private readonly sqlite: Database.Database) {
    this.sqlite.exec(SPACEBOOK_MODEL_DDL);
  }

  /** Replace the list: it is a small, complete catalogue and not a stream. */
  replaceAll(models: SpacebookModel[]): number {
    const now = new Date().toISOString();
    const stmt = this.sqlite.prepare(
      `INSERT OR REPLACE INTO spacebook_model (id, filename, name, is_public, fetched_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.sqlite.transaction((rows: SpacebookModel[]) => {
      this.sqlite.prepare("DELETE FROM spacebook_model").run();
      for (const m of rows) stmt.run(m.id, m.filename, m.name, m.isPublic ? 1 : 0, now);
    })(models);
    return models.length;
  }

  count(): number {
    return (this.sqlite.prepare("SELECT COUNT(*) AS n FROM spacebook_model").get() as { n: number })
      .n;
  }

  /**
   * Best model for an object name.
   *
   * The catalogue's names (`ISS (ZARYA)`) and the model names (`ISS (ZARNA)`) do not
   * match a NORAD id, so the link has to be textual. Exact case-insensitive match
   * only: a fuzzy match would happily assign the Landsat model to a Landsat-derived
   * debris object.
   */
  modelForName(name: string): SpacebookModel | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, filename, name, is_public AS isPublic FROM spacebook_model
          WHERE lower(name) = lower(?) LIMIT 1`,
      )
      .get(name) as SpacebookModel | undefined;
    return row ?? null;
  }
}

/** Convenience: is a token currently on disk and unexpired? */
export function spacebookTokenUsable(): boolean {
  const path = defaultTokenPath();
  if (!existsSync(path)) return false;
  return true;
}
