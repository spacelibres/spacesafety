/**
 * Compute node.
 *
 * Standalone process that dials the API host's gRPC channel, receives screening
 * jobs, runs the numerical kernel locally, and streams results back.
 *
 * All heavy work lives here: propagation, close-approach search, and the Alfano
 * probability integral. The API host never computes.
 *
 *   SPACE_SAFETY_GRPC_HOST=vps.example.com:50051 \
 *   SPACE_SAFETY_GRPC_CA=./certs/grpc-ca.pem \
 *   SPACE_SAFETY_GRPC_CERT=./certs/worker.pem \
 *   SPACE_SAFETY_GRPC_KEY=./certs/worker-key.pem \
 *   npm run worker
 *
 * ## Compute threads
 *
 * Compute runs on `worker_threads`, one per core minus one, so a single worker
 * process uses the whole machine. `SPACE_SAFETY_WORKER_THREADS=1` (or `0`) keeps
 * everything on the main thread, which is what the tests and the demo use. See
 * `pool.ts` for why each thread parses nothing and the main thread parses once.
 *
 * Dispatch messages carry trajectory ids rather than megabytes of ephemeris, so
 * the worker resolves raw files from a local cache (`SPACE_SAFETY_TRAJECTORY_DIR`,
 * files named `<trajectory-id>.<ext>`). Anything it cannot resolve is reported as
 * a structured failure and the API requeues it.
 */

import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { normaliseTrajectory } from "../lib/api/validate-trajectory";
import { loadTrajectory, runInline } from "./screening-thread";
import { createPool, resolveThreadCount, type ScreeningPool } from "./pool";
import {
  clientCredentials,
  grpc,
  loadProto,
  PROTOCOL_VERSION,
  type ServerMessageMsg,
  type ScreeningJobMsg,
  type ScreeningResultMsg,
  type TrajectorySampleMsg,
  type WorkerMessageMsg,
} from "../lib/grpc/proto";

export interface WorkerOptions {
  /** `host:port` of the API host. */
  address: string;
  concurrency: number;
  workerId?: string;
  trajectoryDir?: string;
  /** Injected resolver, primarily for tests. */
  resolveTrajectory?: (id: string) => string | null;
  onLog?: (message: string) => void;
  /**
   * HTTP origin used to fetch trajectory files the worker does not hold
   * locally, e.g. `http://vps:3000`. Requires `workerToken`.
   */
  apiOrigin?: string;
  workerToken?: string;
  /**
   * Compute threads. Omitted means `resolveThreadCount()`: one per core minus
   * one. `0` or `1` computes inline on the main thread.
   */
  threads?: number;
}

export interface RunningWorker {
  stop: () => void;
  done: Promise<void>;
}

/** Start a worker and keep its stream alive, reconnecting with backoff. */
export function startWorker(opts: WorkerOptions): RunningWorker {
  const log = opts.onLog ?? ((m: string) => console.log(m));
  const proto = loadProto();

  let stopped = false;
  let attempt = 0;
  let currentStream:
    | grpc.ClientDuplexStream<WorkerMessageMsg, ServerMessageMsg>
    | null = null;
  let reconnectTimer: NodeJS.Timeout | undefined;

  const pool = createPool({ threads: opts.threads, onLog: log });
  // Advertise pooled capacity, not thread count: the server dispatches up to
  // `concurrency` in flight, and the pool queues anything beyond its slots.
  const capacity = Math.max(1, opts.concurrency || 1, pool.threads);

  const workerId = opts.workerId ?? `${hostname()}-${process.pid}`;
  const localResolve = opts.resolveTrajectory ?? defaultResolver(opts.trajectoryDir);

  // Trajectory files are fetched on demand from the API host when not cached
  // locally. Keeping them out of the gRPC stream avoids shipping megabytes per
  // job while still letting a stateless worker run anywhere.
  const remoteCache = new Map<string, string>();
  /**
   * Second feed per trajectory id (a Starlink object's OCM and ITC are linked).
   *
   * The batch endpoint hands back the companion in the same response as the file,
   * so this costs no extra round trip. Only the link is kept here: when a job needs
   * the companion's *text* it goes through the same resolver as any other id.
   */
  const companionCache = new Map<string, string>();
  const fetcher =
    opts.apiOrigin && opts.workerToken
      ? createRemoteFetcher(opts.apiOrigin, opts.workerToken, remoteCache, companionCache, log)
      : null;

  const resolve = async (id: string): Promise<string | null> => {
    const local = localResolve(id);
    if (local) return local;
    const cached = remoteCache.get(id);
    if (cached) return cached;
    if (!fetcher) return null;
    return fetcher(id);
  };

  let inFlight = 0;
  let totalComputeMs = 0;
  let completed = 0;

  const client = new proto.WorkerControlClient(opts.address, clientCredentials(), {
    "grpc.keepalive_time_ms": 30_000,
  });

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const connect = () => {
    if (stopped) return;

    const stream = client.connect();
    currentStream = stream;

    stream.on("data", (msg: ServerMessageMsg) => {
      if (msg.dispatch) {
        inFlight += 1;
        void handleJob(msg.dispatch.job, resolve, log, pool, companionCache).then((result) => {
          inFlight = Math.max(0, inFlight - 1);
          totalComputeMs += result.computeMs;
          completed += 1;
          try {
            stream.write({ result });
          } catch {
            // Stream died mid-flight; the API requeues the job.
          }
        });
      }
      if (msg.cancel) {
        log(`[worker] cancel ${msg.cancel.jobId}`);
      }
      if (msg.shutdown) {
        log("[worker] server requested shutdown");
        stream.end();
      }
    });

    stream.on("error", (err: Error) => {
      if (stopped) return;
      log(`[worker] stream error: ${err.message}`);
    });

    stream.on("end", () => {
      if (stopped) return;
      attempt += 1;
      const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
      log(`[worker] stream closed, reconnecting in ${delay} ms`);
      reconnectTimer = setTimeout(connect, delay);
    });

    stream.write({
      hello: {
        workerId,
        version: PROTOCOL_VERSION,
        concurrency: capacity,
        hostLabel: hostname(),
      },
    });
    attempt = 0;
    log(
      `[worker] connected to ${opts.address} as ${workerId} ` +
        `(${pool.threads > 0 ? `${pool.threads} compute thread(s)` : "inline compute"}, capacity ${capacity})`,
    );
  };

  const heartbeat = setInterval(() => {
    if (!currentStream || stopped) return;
    try {
      currentStream.write({
        heartbeat: {
          jobsInFlight: inFlight,
          avgComputeMs: completed ? Math.round(totalComputeMs / completed) : 0,
        },
      });
    } catch {
      // reconnect logic owns recovery
    }
  }, 10_000);

  connect();

  return {
    stop: () => {
      stopped = true;
      clearInterval(heartbeat);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        currentStream?.write({ draining: true });
        currentStream?.end();
      } catch {
        // ignore
      }
      client.close();
      void pool.shutdown();
      resolveDone();
    },
    done,
  };
}

/**
 * Resolve a job's trajectories and screen them.
 *
 * Two ways to run the kernel:
 *
 *   - **Inline** (`pool.threads === 0`): compute on this thread. Fine for a
 *     single core, and the path the tests and demo use.
 *   - **Pooled**: gather the raw ephemeris text this thread holds, hand the job
 *     plus that text to a compute thread, and await the result. The text travels
 *     because compute threads never touch the network or the filesystem — one
 *     fetcher, one cache, one retry policy, all on this thread.
 *
 * The result type is identical either way, so callers cannot tell the difference.
 */
export async function handleJob(
  job: ScreeningJobMsg,
  resolve: (id: string) => string | null | Promise<string | null>,
  log: (m: string) => void,
  pool?: ScreeningPool,
  companions?: Map<string, string>,
): Promise<ScreeningResultMsg> {
  const started = Date.now();

  // Inline states (in-process use, tests) need no resolution.
  const inlinedPrimary =
    job.primary?.states && job.primary.states.length > 0 ? job.primary : null;
  const inlinedSecondary =
    job.secondary?.states && job.secondary.states.length > 0 ? job.secondary : null;

  // Collect raw text for whatever is not inlined.
  const sources: Record<string, string> = {};
  const needRaw = (sample: TrajectorySampleMsg | null) =>
    sample && (!sample.states || sample.states.length === 0);

  if (needRaw(job.primary)) {
    const raw = await resolve(job.primary.trajectoryId);
    if (raw) sources[job.primary.trajectoryId] = raw;
  }
  if (needRaw(job.secondary) && !sources[job.secondary.trajectoryId]) {
    const raw = await resolve(job.secondary.trajectoryId);
    if (raw) sources[job.secondary.trajectoryId] = raw;
  }

  const missingPrimary = needRaw(job.primary) && !sources[job.primary.trajectoryId];
  const missingSecondary =
    needRaw(job.secondary) && !sources[job.secondary.trajectoryId];

  if (!inlinedPrimary && missingPrimary) {
    return {
      jobId: job.jobId,
      status: "JOB_STATUS_FAILED",
      approaches: [],
      error: `trajectory not available on this worker (primary=${job.primary?.trajectoryId})`,
      computeMs: Date.now() - started,
    };
  }
  if (!inlinedSecondary && missingSecondary) {
    return {
      jobId: job.jobId,
      status: "JOB_STATUS_FAILED",
      approaches: [],
      error: `trajectory not available on this worker (secondary=${job.secondary?.trajectoryId})`,
      computeMs: Date.now() - started,
    };
  }

  const computeJob: ScreeningJobMsg = {
    jobId: job.jobId,
    primary: job.primary,
    secondary: job.secondary,
    maxSamplePoints: job.maxSamplePoints || 4000,
    windowMs: job.windowMs,
  };

  // Companion text travels with the primary: a thread cannot fetch, and without
  // it a covariance-less OCM would have nothing to borrow from.
  for (const side of [job.primary, job.secondary] as const) {
    const id = side?.trajectoryId;
    const companionId = id ? companions?.get(id) : undefined;
    if (!id || !companionId || sources[id] === undefined) continue;
    if (sources[companionId] !== undefined) continue;
    const raw = await resolve(companionId);
    if (raw) sources[companionId] = raw;
  }

  if (pool && pool.threads > 0) {
    const links: Record<string, string> = {};
    for (const side of [job.primary, job.secondary] as const) {
      const id = side?.trajectoryId;
      const companionId = id ? companions?.get(id) : undefined;
      if (id && companionId && sources[companionId] !== undefined) links[id] = companionId;
    }
    const result = await pool.run(computeJob, sources, links);
    log(
      `[worker] ${job.jobId.slice(0, 8)} ${job.primary.objectName} x ${job.secondary.objectName}: ` +
        `${result.approaches.length} approach(es) in ${result.computeMs} ms (thread)`,
    );
    return { ...result, computeMs: result.computeMs || Date.now() - started };
  }

  for (const [id, raw] of Object.entries(sources)) loadTrajectory(id, raw);
  const result = runInline(computeJob);
  log(
    `[worker] ${job.jobId.slice(0, 8)} ${job.primary.objectName} x ${job.secondary.objectName}: ` +
      `${result.approaches.length} approach(es) in ${result.computeMs} ms`,
  );
  return result;
}

/**
 * Turn a dispatch stub into a full trajectory sample.
 *
 * When the message already carries states (in-process use, tests) they are used
 * as-is; otherwise the raw file is normalised through the same validator the API
 * uses, so the two paths cannot diverge.
 */
export async function materialise(
  sample: TrajectorySampleMsg,
  resolve: (id: string) => string | null | Promise<string | null>,
): Promise<TrajectorySampleMsg | null> {
  if (sample.states && sample.states.length > 0) return sample;

  const raw = await resolve(sample.trajectoryId);
  if (!raw) return null;

  const normalised = normaliseTrajectory(raw);
  return {
    trajectoryId: sample.trajectoryId,
    objectId: sample.objectId || sample.trajectoryId,
    objectName: normalised.objectName ?? sample.objectName ?? sample.trajectoryId,
    hardBodyRadiusKm: sample.hardBodyRadiusKm || 0.005,
    stateSource: sample.stateSource || "operator_ephemeris",
    states: normalised.states.map((s) => ({
      epochMs: String(s.ms),
      px: s.position[0],
      py: s.position[1],
      pz: s.position[2],
      vx: s.velocity[0],
      vy: s.velocity[1],
      vz: s.velocity[2],
      covariance: s.covariance ?? [],
    })),
  };
}

/** Fetch raw trajectory files from the API host and cache them in memory. */
function createRemoteFetcher(
  apiOrigin: string,
  token: string,
  cache: Map<string, string>,
  companionCache: Map<string, string>,
  log: (m: string) => void,
) {
  return async (id: string): Promise<string | null> => {
    try {
      const res = await fetch(`${apiOrigin.replace(/\/$/, "")}/api/internal/trajectory/batch`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-token": token },
        body: JSON.stringify({ ids: [id] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        log(`[worker] fetch ${id.slice(0, 8)} failed: HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as {
        trajectories: { id: string; file: string }[];
        companions?: Record<string, { id: string; file: string } | null>;
      };
      const hit = data.trajectories?.find((t) => t.id === id);
      if (!hit) return null;
      cache.set(id, hit.file);

      // Cache the companion too. It arrives in the same response, and keeping it
      // means the pair is resolved for free once either side is fetched -- which
      // matters because a Starlink object appears in many screening pairs and the
      // same two files would otherwise be re-downloaded for each.
      const companion = data.companions?.[id];
      if (companion?.file) {
        cache.set(companion.id, companion.file);
        companionCache.set(id, companion.id);
      }

      return hit.file;
    } catch (err) {
      log(`[worker] fetch ${id.slice(0, 8)} error: ${(err as Error).message}`);
      return null;
    }
  };
}

function defaultResolver(dir: string | undefined) {
  if (!dir) return () => null;
  return (id: string): string | null => {
    for (const ext of ["txt", "oem", "ocm", "itc", "eph"]) {
      const path = join(dir, `${id}.${ext}`);
      if (existsSync(path)) return readFileSync(path, "utf8");
    }
    return null;
  };
}

async function main() {
  const address = process.env.SPACE_SAFETY_GRPC_HOST ?? "localhost:50051";
  const threads = resolveThreadCount();
  // One in-flight job per thread keeps every core busy; extra queueing would
  // only add latency without improving throughput.
  const concurrency = Number(
    process.env.SPACE_SAFETY_WORKER_CONCURRENCY ?? Math.max(2, threads),
  );

  const worker = startWorker({
    address,
    concurrency,
    threads,
    trajectoryDir: process.env.SPACE_SAFETY_TRAJECTORY_DIR,
    apiOrigin: process.env.SPACE_SAFETY_API_ORIGIN,
    workerToken: process.env.SPACE_SAFETY_WORKER_TOKEN,
  });

  const shutdown = () => {
    console.log("\n[worker] shutting down");
    worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await worker.done;
}

if (process.argv[1]?.includes("worker")) {
  void main();
}
