/**
 * API error model.
 *
 * The vendor returns a stable 4-field envelope on every non-2xx response
 * (`docs/SPEC-BEHAVIOR.md` §7). Clients key off `error_type`, so it must stay
 * machine-readable and stable.
 */

export interface ApiErrorBody {
  correlation_id: string;
  error: string;
  error_type: string;
  metadata: Record<string, unknown>;
}

/** Error types the vendor documents explicitly. */
export const ERROR_TYPES = {
  BAD_REQUEST: "bad_request",
  NOT_FOUND: "not_found",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  /** A pagination token has aged out; the client must drop it. */
  PAGINATION_TOO_OLD: "pagination_too_old",
  /** Rate limit exceeded (the vendor uses HTTP 503 for this). */
  RATE_LIMITED: "rate_limited",
  /**
   * A dependency this replica needs is unavailable — here, the Space-Track
   * catalogue. Distinct from `rate_limited` so a client can tell "come back
   * later" from "this deployment is misconfigured".
   */
  UPSTREAM_UNAVAILABLE: "upstream_unavailable",
  /** An upstream service answered, but with an error. */
  UPSTREAM_ERROR: "upstream_error",
  INTERNAL: "internal_error",
} as const;

export type ErrorType = (typeof ERROR_TYPES)[keyof typeof ERROR_TYPES];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: ErrorType | string,
    message: string,
    readonly metadata: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  static badRequest(message: string, metadata: Record<string, unknown> = {}) {
    return new ApiError(400, ERROR_TYPES.BAD_REQUEST, message, metadata);
  }

  static notFound(message: string, metadata: Record<string, unknown> = {}) {
    return new ApiError(404, ERROR_TYPES.NOT_FOUND, message, metadata);
  }

  static unauthorized(message = "RBAC: access denied") {
    return new ApiError(401, ERROR_TYPES.UNAUTHORIZED, message);
  }

  static forbidden(message: string, metadata: Record<string, unknown> = {}) {
    return new ApiError(403, ERROR_TYPES.FORBIDDEN, message, metadata);
  }

  static paginationTooOld() {
    return new ApiError(
      400,
      ERROR_TYPES.PAGINATION_TOO_OLD,
      "pagination token is too old; discard it and restart the stream",
    );
  }

  static rateLimited(retryAfterSeconds = 60) {
    return new ApiError(503, ERROR_TYPES.RATE_LIMITED, "rate limit exceeded", {
      retry_after_seconds: retryAfterSeconds,
    });
  }

  /**
   * A required upstream service is not configured or not reachable.
   *
   * 503 rather than 500: the request is well-formed and would succeed once the
   * dependency is available, which is exactly what 503 tells a client.
   */
  static serviceUnavailable(message: string, metadata: Record<string, unknown> = {}) {
    return new ApiError(503, ERROR_TYPES.UPSTREAM_UNAVAILABLE, message, metadata);
  }

  /** An upstream service responded with an error (bad gateway semantics). */
  static badGateway(message: string, metadata: Record<string, unknown> = {}) {
    return new ApiError(502, ERROR_TYPES.UPSTREAM_ERROR, message, metadata);
  }

  static internal(message = "internal server error") {
    return new ApiError(500, ERROR_TYPES.INTERNAL, message);
  }
}

/** Build the response envelope for an error. */
export function errorBody(err: ApiError, correlationId: string): ApiErrorBody {
  return {
    correlation_id: correlationId,
    error: err.message,
    error_type: err.errorType,
    metadata: err.metadata,
  };
}

/**
 * Field-level validation failure, matching the vendor's 400 shape.
 *
 * `metadata.fields` lists every violated constraint at once, which is far more
 * useful to an operator debugging an ephemeris upload than failing on the first
 * problem.
 */
export function validationError(
  message: string,
  fields: { field: string; reason: string }[],
): ApiError {
  return ApiError.badRequest(message, { fields });
}
