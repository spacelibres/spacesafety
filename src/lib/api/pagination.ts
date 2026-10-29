/**
 * Opaque, server-issued pagination tokens.
 *
 * The vendor's streaming endpoints (`/v1/trajectory`, `/v2/cdm`,
 * `/v2/trajectory/:id/cdms`) share a specific contract
 * (`docs/SPEC-BEHAVIOR.md` §6):
 *
 *   - the token is opaque to clients and must be reused to get *new* rows,
 *   - reusing it when nothing changed returns zero rows but keeps working,
 *   - it eventually ages out, and then the server must answer
 *     `400 pagination_too_old`,
 *   - changing filters while reusing a token is undefined behaviour.
 *
 * We implement that with `(cursor, filterHash)` stored server-side:
 *
 *   - `cursor` is the highest `seq` already handed to this client, so
 *     inserts that happen mid-scan are never skipped (unlike a timestamp cursor).
 *   - `filterHash` lets us reject a token replayed against different filters.
 *   - `created_at` gives us ageing.
 *
 * Tokens are random and stored, which additionally means a client cannot forge
 * a cursor to enumerate rows it should not see.
 */

import { randomBytes } from "node:crypto";

import { eq, lt } from "drizzle-orm";

import { getDb } from "@/db";
import { paginationTokens } from "@/db/schema";

import { ApiError } from "./errors";

/** Tokens older than this are rejected, matching the vendor's behaviour. */
export const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface TokenState {
  cursor: number;
  filterHash: string;
}

/** Stable hash of a filter object (key-sorted, so key order does not matter). */
export function hashFilters(filters: Record<string, unknown>): string {
  const normalised = Object.keys(filters)
    .filter((k) => filters[k] !== undefined && filters[k] !== null && filters[k] !== "")
    .sort()
    .map((k) => `${k}=${JSON.stringify(filters[k])}`)
    .join("&");
  return normalised;
}

/**
 * Resolve the cursor for this request.
 *
 * Returns `0` when no token was supplied, meaning "start from the beginning".
 */
export function resolveCursor(
  stream: string,
  token: string | undefined,
  filterHash: string,
): number {
  if (!token) return 0;

  const { db } = getDb();
  const row = db
    .select()
    .from(paginationTokens)
    .where(eq(paginationTokens.token, token))
    .get();

  if (!row) {
    // Unknown token: it was never issued by us, or the DB was reset.
    throw ApiError.paginationTooOld();
  }
  if (row.stream !== stream) {
    throw ApiError.badRequest(
      `pagination token belongs to a different stream (${row.stream})`,
    );
  }
  if (row.filterHash !== filterHash) {
    // Documented as undefined behaviour upstream; we choose to be explicit.
    throw ApiError.badRequest(
      "pagination token cannot be reused with different filter parameters",
    );
  }

  const age = Date.now() - Date.parse(row.lastUsedAt);
  if (!Number.isFinite(age) || age > TOKEN_MAX_AGE_MS) {
    db.delete(paginationTokens).where(eq(paginationTokens.token, token)).run();
    throw ApiError.paginationTooOld();
  }

  db.update(paginationTokens)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(paginationTokens.token, token))
    .run();

  return row.cursor;
}

/**
 * Issue the token for the next page.
 *
 * Even when a page came back empty we mint a fresh token at the unchanged
 * cursor, because the vendor explicitly supports "call again later with the
 * same token to get anything new".
 */
export function issueToken(
  stream: string,
  cursor: number,
  filterHash: string,
): string {
  const { db } = getDb();
  const token = randomBytes(24).toString("base64url");
  const now = new Date().toISOString();

  db.insert(paginationTokens)
    .values({ token, stream, cursor, filterHash, createdAt: now, lastUsedAt: now })
    .run();

  // Opportunistic cleanup so the table cannot grow without bound.
  const cutoff = new Date(Date.now() - TOKEN_MAX_AGE_MS).toISOString();
  try {
    db.delete(paginationTokens).where(lt(paginationTokens.lastUsedAt, cutoff)).run();
  } catch {
    // ignore
  }

  return token;
}

/** Page size cap, matching the vendor's documented 1000-row batches. */
export const MAX_PAGE_SIZE = 1000;
