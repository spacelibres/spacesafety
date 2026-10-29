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
    return json(err.status, errorBody(err, correlationId), correlationId);
  }

  if (err instanceof TrajectoryValidationError) {
    const apiErr = validationError(err.message, err.issues);
    return json(400, errorBody(apiErr, correlationId), correlationId);
  }

  const message = err instanceof Error ? err.message : String(err);
  const apiErr = ApiError.internal(message);
  // Never leak a stack trace to a client, but make it findable in server logs.
  console.error(`[space-eyes] unhandled error (${correlationId}):`, err);
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

export async function readJson<T>(request: Request): Promise<T> {
  const raw = await request.text();
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
