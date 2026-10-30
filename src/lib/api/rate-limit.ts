/**
 * Per-operator rate limiting.
 *
 * ## Why this exists
 *
 * `docs/starlink-space-safety/api-keys.md` states:
 *
 * > APIs may return HTTP 503 responses if they exceed API rate limits.
 * > Our goal is that our rate limits provide no practical impediment to
 *   operators using the screening system.
 *
 * The snapshot gives no numbers, so the defaults here are chosen to match that
 * *goal* rather than to imitate an unknown constant: a well-behaved client that
 * polls every few seconds and uploads a trajectory every few minutes will never
 * see a 503, while a runaway loop is stopped before it can exhaust the box.
 *
 * ## The model
 *
 * A token bucket per operator. Reads cost one token, writes cost ten, so one
 * budget bounds both without a second configuration knob: an operator that only
 * reads gets the full read rate, and an upload stream is capped at a tenth of it,
 * which is roughly the difference between polling and publishing.
 *
 * ## Why a class
 *
 * The bucket map is mutable state, and the project requires stateful
 * cross-cutting capability to live in a class rather than a module-level
 * variable (§2). The exported instance below stands for the process, not for a
 * global of our own invention — a rate limit that is not per-process is not a
 * rate limit.
 */

import { ApiError } from "./errors";

/** Requests per minute for reads, before writes are weighted. */
const DEFAULT_PER_MINUTE = 600;

/** A write costs this many read tokens (`POST`/`PATCH`/`PUT`/`DELETE`). */
const WRITE_COST = 10;

interface Bucket {
  /** Tokens available, in read-units. */
  tokens: number;
  /** When the bucket was last refilled, ms. */
  at: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  /** Tokens added per minute. Read from the environment on every call so a test
   * (and a deployment) can change it without a restart. */
  private perMinute(): number {
    const raw = process.env.SPACE_SAFETY_RATE_LIMIT_PER_MINUTE;
    const parsed = raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PER_MINUTE;
    return parsed;
  }

  /**
   * Charge one request against `operatorId`, or throw a 503.
   *
   * `method` decides the cost; anything that is not a read is treated as a write,
   * so a new mutating verb cannot silently escape the smaller budget.
   */
  charge(operatorId: string, method: string): void {
    const capacity = this.perMinute();
    const now = Date.now();
    const cost = isRead(method) ? 1 : WRITE_COST;

    const bucket = this.buckets.get(operatorId) ?? { tokens: capacity, at: now };
    // Continuous refill: a full bucket over one minute.
    const elapsed = Math.max(0, now - bucket.at);
    bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed * capacity) / 60_000);
    bucket.at = now;

    if (bucket.tokens < cost) {
      this.buckets.set(operatorId, bucket);
      const deficit = cost - bucket.tokens;
      const retryAfter = Math.max(1, Math.ceil((deficit / capacity) * 60));
      throw ApiError.rateLimited(retryAfter);
    }

    bucket.tokens -= cost;
    this.buckets.set(operatorId, bucket);
    this.sweep(now, capacity);
  }

  /**
   * Drop buckets that have been idle long enough to be full again.
   *
   * Without this a long-running process accumulates one entry per operator that
   * ever called — small, but unbounded, and a leak is a leak.
   */
  private sweep(now: number, capacity: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [id, bucket] of this.buckets) {
      const idle = now - bucket.at;
      if (bucket.tokens >= capacity - 1 && idle > 60_000) this.buckets.delete(id);
    }
  }

  /** Forget every bucket. Tests use this; nothing in the app does. */
  reset(): void {
    this.buckets.clear();
    this.lastSweep = 0;
  }
}

function isRead(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

/** The process's limiter. */
export const rateLimiter = new RateLimiter();
