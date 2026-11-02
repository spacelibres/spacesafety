/**
 * Route-level plumbing: correlation ids, error envelopes, auth, and body parsing.
 *
 * Every handler returns the vendor's envelope on failure (`SPEC-BEHAVIOR.md` §7)
 * and sets `X-Correlation-Id` so an operator can report a specific request.
 */

import { randomUUID } from "node:crypto";

import { ApiError, errorBody, validationError } from "./errors";
import { TrajectoryValidationError } from "./validate-trajectory";
import { authenticateRequest, type Principal } from "./auth";
import { rateLimiter } from "./rate-limit";

export interface RouteContext {
  request: Request;
  params: Record<string, string>;
  correlationId: string;
  principal: Principal;
}

type Handler = (ctx: RouteContext) => Promise<Response> | Response;

/** Next.js route handler context. `params` is a promise in the App Router. */
export interface NextRouteContext {
  params: Promise<Record<string, string>>;
}

/** Wrap a handler so it always produces a well-formed response. */
export function route(
  handler: Handler,
  opts: { auth?: boolean } = { auth: true },
) {
  return async (request: Request, ctx: NextRouteContext): Promise<Response> => {
    const correlationId = randomUUID();
    const params = ctx?.params ? await ctx.params : {};

    try {
      const principal = opts.auth === false
        ? ({
            operatorId: "",
            operatorName: "",
            credentialId: "",
            commonName: "",
            fingerprint: "",
          } satisfies Principal)
        : authenticateRequest(request.headers);

      // Charge the request before doing any work, so a runaway client is
      // stopped by the cheapest possible code path. Reads cost one token,
      // writes ten — see `rate-limit.ts` for why the vendor's 503 is modelled
      // this way and what the defaults are.
      if (principal.operatorId) {
        rateLimiter.charge(principal.operatorId, request.method);
      }

      const res = await handler({ request, params, correlationId, principal });
      res.headers.set("x-correlation-id", correlationId);
      return res;
    } catch (err) {
      return errorResponse(err, correlationId);
    }
  };
}

export function errorResponse(err: unknown, correlationId: string): Response {
  if (err instanceof ApiError) {
    // A 503 that does not say when to retry invites a client to retry
    // immediately, which is how a rate limit turns into a self-inflicted
    // denial of service. `api-keys.md` documents the 503; the header is the
    // part of the contract that makes it actionable.
    const headers: Record<string, string> = {};
    const retry = err.metadata.retry_after_seconds;
    if (err.status === 503 && typeof retry === "number") {
      headers["retry-after"] = String(Math.max(1, Math.ceil(retry)));
    }
    return json(err.status, errorBody(err, correlationId), correlationId, headers);
  }

  if (err instanceof TrajectoryValidationError) {
    const apiErr = validationError(err.message, err.issues);
    return json(400, errorBody(apiErr, correlationId), correlationId);
  }

  const message = err instanceof Error ? err.message : String(err);
  const apiErr = ApiError.internal(message);
  // Never leak a stack trace to a client, but make it findable in server logs.
  console.error(`[space-safety] unhandled error (${correlationId}):`, err);
  return json(500, errorBody(apiErr, correlationId), correlationId);
}

export function json(
  status: number,
  body: unknown,
  correlationId?: string,
  headers: Record<string, string> = {},
): Response {
  const h = new Headers({ "content-type": "application/json" });
  if (correlationId) h.set("x-correlation-id", correlationId);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function text(
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

/**
 * Largest request body any endpoint accepts, in bytes.
 *
 * The documented ceiling is `MAX_FILE_CHARS` (30 MiB of ephemeris text) plus the
 * JSON envelope around it. Nothing on this API takes anything larger, and without
 * a cap `readJson` buffered whatever arrived: a single client POSTing gigabytes
 * was charged one rate-limit token and one multi-gigabyte allocation.
 */
export const MAX_BODY_BYTES = 34 * 1024 * 1024;

/**
 * Read a request body, refusing to buffer more than `maxBytes`.
 *
 * `content-length` is checked first so an oversized upload is rejected before a
 * single byte is read; a chunked body carries no length, so the stream itself is
 * counted and cancelled the moment it crosses the limit.
 */
async function readBoundedText(request: Request, maxBytes = MAX_BODY_BYTES): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) throw ApiError.payloadTooLarge(maxBytes, n);
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw ApiError.payloadTooLarge(maxBytes, total);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function readJson<T>(request: Request): Promise<T> {
  const raw = await readBoundedText(request);
  if (!raw.trim()) {
    throw ApiError.badRequest("request body must be JSON");
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw ApiError.badRequest("request body is not valid JSON");
  }
}

/** Parse an integer query parameter, rejecting junk. */
export function intParam(
  url: URL,
  name: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw ApiError.badRequest(`query parameter "${name}" must be an integer`, {
      parameter: name,
    });
  }
  if (opts.min !== undefined && value < opts.min) {
    throw ApiError.badRequest(`query parameter "${name}" must be >= ${opts.min}`, {
      parameter: name,
    });
  }
  if (opts.max !== undefined && value > opts.max) {
    throw ApiError.badRequest(`query parameter "${name}" must be <= ${opts.max}`, {
      parameter: name,
    });
  }
  return value;
}

/** Parse a float query parameter. */
export function floatParam(
  url: URL,
  name: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw ApiError.badRequest(`query parameter "${name}" must be a number`, {
      parameter: name,
    });
  }
  if (opts.min !== undefined && value < opts.min) {
    throw ApiError.badRequest(`query parameter "${name}" must be >= ${opts.min}`, {
      parameter: name,
    });
  }
  if (opts.max !== undefined && value > opts.max) {
    throw ApiError.badRequest(`query parameter "${name}" must be <= ${opts.max}`, {
      parameter: name,
    });
  }
  return value;
}

/** Parse a boolean query parameter (`true`/`false`). */
export function boolParam(url: URL, name: string): boolean | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw ApiError.badRequest(`query parameter "${name}" must be true or false`, {
    parameter: name,
  });
}

/** Validate a UUID-ish identifier before hitting the database. */
export function uuidParam(value: string, name = "id"): string {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(value)) {
    throw ApiError.badRequest(`invalid ${name}`, { parameter: name });
  }
  return value;
}
