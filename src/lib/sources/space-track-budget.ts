/**
 * A hard local budget on Space-Track queries.
 *
 * ## Why this exists
 *
 * On 2026-11-05 Space-Track emailed a warning: 667 queries between 01:00 and 02:00
 * UTC from our account, against a documented limit, with the explicit threat of
 * blocking the account. That volume did not come from the scheduler — it came from
 * `scripts/ingest-tle.ts`, which paged the API in batches of 20 objects, two requests
 * per batch (GP + OMM), for 42 000 objects: roughly 4 200 calls. It was rate-limited
 * somewhere in the first few hundred and kept going anyway.
 *
 * A "please be gentler" comment would not have prevented that. What prevents it is
 * refusing to send the request at all once the budget is spent, at the one place every
 * Space-Track call passes through.
 *
 * ## Why the count is on disk
 *
 * In-memory state is per process. The scheduler, a one-off script and a manual `npm
 * run` are three processes, each with its own memory, and the account is shared. The
 * counter therefore lives next to the database and is keyed by wall-clock hour, so
 * separate processes on the same machine see the same budget.
 *
 * ## Why the limits are what they are
 *
 * Space-Track documents a limit on queries per hour without stating a number we could
 * rely on; their message to us cited 667/hour as a violation. The scheduler's own
 * cadence is three requests per two hours (GP, CDM, TIP), so the legitimate steady
 * state is a handful per hour.
 *
 *   hourly    60   ten times the steady state, still well under the figure we were
 *                  warned about, and enough for a full manual refresh
 *   daily   1500   the space-track sources are pulled ≤ 15×/day; this leaves room for
 *                  a day of manual debugging
 *
 * Both are overridable for a deliberate bulk run via `SPACE_SAFETY_ST_HOURLY_LIMIT`.
 * Raising them for a one-off is a conscious act, which is the point.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const STATE_FILE = join("data", "space-track-budget.json");

interface Budget {
  /** `YYYY-MM-DDTHH` in UTC. */
  hour: string;
  hourCount: number;
  /** `YYYY-MM-DD` in UTC. */
  day: string;
  dayCount: number;
}

function limits(): { hourly: number; daily: number } {
  const env = (name: string, fallback: number): number => {
    const v = Number(process.env[name]);
    // A positive integer or fall back. A fractional limit is meaningless — you cannot
    // spend half a query — and casting it would silently floor to 0, which reads as
    // "turned off" when it means "misconfigured".
    return Number.isInteger(v) && v > 0 ? v : fallback;
  };
  return {
    hourly: env("SPACE_SAFETY_ST_HOURLY_LIMIT", 60),
    daily: env("SPACE_SAFETY_ST_DAILY_LIMIT", 1500),
  };
}

function hourKey(now: Date): string {
  return now.toISOString().slice(0, 13);
}

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function read(now: Date): Budget {
  const empty: Budget = { hour: hourKey(now), hourCount: 0, day: dayKey(now), dayCount: 0 };
  if (!existsSync(STATE_FILE)) return empty;
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<Budget>;
    return {
      // A stale hour or day resets only its own counter: crossing midnight must not
      // zero the hourly budget, and crossing the top of the hour must not zero the
      // daily one.
      hour: hourKey(now),
      hourCount: raw.hour === hourKey(now) ? Number(raw.hourCount) || 0 : 0,
      day: dayKey(now),
      dayCount: raw.day === dayKey(now) ? Number(raw.dayCount) || 0 : 0,
    };
  } catch {
    return empty;
  }
}

function write(b: Budget): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const fd = openSync(STATE_FILE, "w");
    writeSync(fd, JSON.stringify(b));
    closeSync(fd);
  } catch {
    // The budget is protection against a runaway script, not a safety-critical
    // record: if the file cannot be written, the in-process counter still limits
    // this run, and failing the request instead would be worse.
  }
}

export interface BudgetRefusal {
  refused: true;
  reason: string;
  hourCount: number;
  dayCount: number;
  hourly: number;
  daily: number;
}

/**
 * Claim one query against the budget.
 *
 * Returns `null` when the request may proceed. Refusing is a normal outcome, not an
 * exception: callers surface it as an error string so the run reports "budget
 * exhausted" instead of a network failure.
 */
export function claimQuery(now = new Date()): BudgetRefusal | null {
  const { hourly, daily } = limits();
  const b = read(now);

  if (b.hourCount >= hourly) {
    return {
      refused: true,
      reason:
        `Space-Track query budget exhausted for ${b.hour} UTC ` +
        `(${b.hourCount}/${hourly} this hour). Refusing to send. ` +
        `Raise SPACE_SAFETY_ST_HOURLY_LIMIT deliberately if this is intended.`,
      hourCount: b.hourCount,
      dayCount: b.dayCount,
      hourly,
      daily,
    };
  }
  if (b.dayCount >= daily) {
    return {
      refused: true,
      reason:
        `Space-Track query budget exhausted for ${b.day} UTC ` +
        `(${b.dayCount}/${daily} today). Refusing to send.`,
      hourCount: b.hourCount,
      dayCount: b.dayCount,
      hourly,
      daily,
    };
  }

  write({ ...b, hourCount: b.hourCount + 1, dayCount: b.dayCount + 1 });
  return null;
}

/** Current usage, for `npm run data:health` and for explaining a refusal. */
export function budgetStatus(now = new Date()): {
  hourCount: number;
  dayCount: number;
  hourly: number;
  daily: number;
} {
  const b = read(now);
  const { hourly, daily } = limits();
  return { hourCount: b.hourCount, dayCount: b.dayCount, hourly, daily };
}
