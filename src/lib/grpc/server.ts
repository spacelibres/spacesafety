/**
 * VPS side of the compute channel.
 *
 * The compute node dials in and holds a bidirectional stream open. This module
 * owns the server half: it registers the gRPC services, tracks connected workers,
 * and pumps queued screening jobs down to them.
 *
 * Design notes
 * ------------
 * - **Pull by capacity.** Each worker declares `concurrency` in its hello; we push
 *   only while it has free slots, so a slow worker applies backpressure instead of
 *   being flooded.
 * - **Bounded claim.** Jobs are claimed in small batches so a disconnect cannot
 *   strand thousands of rows in `dispatched`; `requeueStale` recovers the rest.
 * - **Idempotent ingest.** A worker may replay a result after reconnecting;
 *   ingestion is keyed on `job_id` and refuses to double-apply.
 */

import "server-only";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { eq, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { screeningJobs } from "@/db/schema";
import {
  claimPendingJobs,
  ingestScreeningResult,
  markTrajectoryStatus,
  requeueStale,
  statusForFailure,
} from "@/lib/api/screening-service";

import {
  grpc,
  loadProto,
  type CoordinatorService,
  type HealthResponseMsg,
  type QueueResponseMsg,
  type ScreeningResultMsg,
  type ServerMessageMsg,
  type WorkerControlService,
  type WorkerMessageMsg,
} from "./proto";

const BATCH_SIZE = 8;
const REFILL_INTERVAL_MS = 1_000;
const REQUEUE_INTERVAL_MS = 60_000;

interface WorkerSession {
  id: string;
  label: string;
  version: string;
  concurrency: number;
  inFlight: number;
  stream: grpc.ServerDuplexStream<WorkerMessageMsg, ServerMessageMsg>;
  connectedAt: number;
  avgComputeMs: number;
}

export class ComputeChannel {
  private readonly workers = new Map<string, WorkerSession>();
  private refillTimer: NodeJS.Timeout | undefined;
  private requeueTimer: NodeJS.Timeout | undefined;
  private server: grpc.Server | undefined;
  private port = 0;

  /** Bind the gRPC server. Idempotent. */
  async start(port = Number(process.env.SPACE_SAFETY_GRPC_PORT ?? 50051)): Promise<number> {
    if (this.server) return this.port;

    const proto = loadProto();
    const server = new grpc.Server();

    const workerControl: WorkerControlService = {
      Connect: (call) => this.attachWorker(call),
    };
    const coordinator: CoordinatorService = {
      Health: (_call, cb) => cb(null, this.health()),
      Queue: (call, cb) => cb(null, this.queue(call.request?.limit ?? 50)),
    };

    server.addService(proto.WorkerControlServiceDefinition, workerControl);
    server.addService(proto.CoordinatorServiceDefinition, coordinator);

    const credentials = serverCredentials();

    const bound = await new Promise<number>((resolve, reject) => {
      server.bindAsync(`0.0.0.0:${port}`, credentials, (err, actual) => {
        if (err) reject(err);
        else resolve(actual);
      });
    });

    server.start?.();
    this.server = server;
    this.port = bound;

    this.refillTimer = setInterval(() => this.refill(), REFILL_INTERVAL_MS);
    this.requeueTimer = setInterval(() => {
      const n = requeueStale();
      if (n > 0) console.warn(`[space-safety] requeued ${n} stale screening job(s)`);
    }, REQUEUE_INTERVAL_MS);

    console.log(`[space-safety] compute channel listening on :${bound}`);
    return bound;
  }

  async stop(): Promise<void> {
    if (this.refillTimer) clearInterval(this.refillTimer);
    if (this.requeueTimer) clearInterval(this.requeueTimer);
    this.refillTimer = undefined;
    this.requeueTimer = undefined;

    for (const w of this.workers.values()) {
      try {
        w.stream.end();
      } catch {
        // ignore
      }
    }
    this.workers.clear();

    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.tryShutdown(() => resolve());
    });
    this.server = undefined;
  }

  workerCount(): number {
    return this.workers.size;
  }

  health(): HealthResponseMsg {
    const inFlight = [...this.workers.values()].reduce((n, w) => n + w.inFlight, 0);
    const { db } = getDb();
    const pending = db
      .select({ n: sql<number>`count(*)` })
      .from(screeningJobs)
      .where(eq(screeningJobs.status, "pending"))
      .get();

    return {
      ok: true,
      version: "0.1.0",
      connectedWorkers: this.workers.size,
      jobsQueued: pending?.n ?? 0,
      jobsInFlight: inFlight,
    };
  }

  /** Ops helper: peek at the pending queue without claiming it. */
  queue(limit: number): QueueResponseMsg {
    const { db } = getDb();
    const rows = db
      .select()
      .from(screeningJobs)
      .where(eq(screeningJobs.status, "pending"))
      .orderBy(screeningJobs.seq)
      .limit(limit)
      .all();

    return {
      jobs: rows.map((r) => ({
        jobId: r.id,
        object1Name: r.trajectoryId,
        object2Name: r.againstTrajectoryId ?? "",
        queuedAtMs: String(Date.parse(r.createdAt)),
      })),
    };
  }

  // -----------------------------------------------------------------------

  private attachWorker(
    call: grpc.ServerDuplexStream<WorkerMessageMsg, ServerMessageMsg>,
  ): void {
    let session: WorkerSession | undefined;

    call.on("data", (msg: WorkerMessageMsg) => {
      if (msg.hello) {
        const id = msg.hello.workerId || randomUUID();
        session = {
          id,
          label: msg.hello.hostLabel || id.slice(0, 8),
          version: msg.hello.version,
          concurrency: Math.max(1, msg.hello.concurrency || 1),
          inFlight: 0,
          stream: call,
          connectedAt: Date.now(),
          avgComputeMs: 0,
        };
        this.workers.set(id, session);
        console.log(
          `[space-safety] worker ${session.label} connected (concurrency ${session.concurrency}, v${session.version})`,
        );
        this.refill();
        return;
      }

      if (msg.heartbeat && session) {
        session.inFlight = msg.heartbeat.jobsInFlight;
        session.avgComputeMs = msg.heartbeat.avgComputeMs;
        this.refill();
        return;
      }

      if (msg.draining && session) {
        console.log(`[space-safety] worker ${session.label} is draining`);
        return;
      }

      if (msg.result && session) {
        session.inFlight = Math.max(0, session.inFlight - 1);
        try {
          handleResult(msg.result, session.id);
        } catch (err) {
          console.error(
            `[space-safety] failed to ingest result ${msg.result.jobId}:`,
            err,
          );
        }
        this.refill();
      }
    });

    const drop = () => {
      if (session) {
        this.workers.delete(session.id);
        console.log(`[space-safety] worker ${session.label} disconnected`);
      }
    };
    call.on("end", drop);
    call.on("cancelled", drop);
    call.on("error", (err: Error) => {
      console.warn(`[space-safety] worker stream error: ${err.message}`);
      drop();
    });
  }

  /** Push queued work to every worker with free capacity. */
  private refill(): void {
    for (const worker of this.workers.values()) {
      let capacity = worker.concurrency - worker.inFlight;

      while (capacity > 0) {
        const jobs = claimPendingJobs(Math.min(capacity, BATCH_SIZE), worker.id);
        if (jobs.length === 0) break;

        for (const job of jobs) {
          if (capacity <= 0) {
            // Claimed but not sent: put it back so another worker can take it.
            requeueJob(job.id);
            continue;
          }
          worker.stream.write({
            dispatch: {
              job: {
                jobId: job.id,
                primary: { trajectoryId: job.trajectoryId } as never,
                secondary: { trajectoryId: job.againstTrajectoryId ?? "" } as never,
                maxSamplePoints: 4000,
              },
            },
          });
          worker.inFlight += 1;
          capacity -= 1;
        }
      }
    }
  }
}

function handleResult(result: ScreeningResultMsg, workerId: string): void {
  const { db } = getDb();
  const job = db
    .select()
    .from(screeningJobs)
    .where(eq(screeningJobs.id, result.jobId))
    .get();

  if (!job) {
    console.warn(`[space-safety] result for unknown job ${result.jobId}`);
    return;
  }
  if (job.status === "completed") {
    // Reconnect can replay a result; ignore it.
    return;
  }

  if (result.status !== "JOB_STATUS_COMPLETED") {
    const failed = result.status !== "JOB_STATUS_TIMEOUT";
    db.update(screeningJobs)
      .set({
        status: failed ? "failed" : "pending",
        lastError: result.error || result.status,
        completedAt: new Date().toISOString(),
        workerId,
      })
      .where(eq(screeningJobs.id, job.id))
      .run();

    // A timeout is retried, so it says nothing about the trajectory. A real
    // failure does: the vendor distinguishes "we could not fetch this
    // trajectory" from "we could not sample it", and leaving both at
    // `not_screened` made a stuck trajectory look like a pending one.
    if (failed) {
      const status = statusForFailure(result.error);
      if (status) {
        for (const id of [job.trajectoryId, job.againstTrajectoryId]) {
          if (id) markTrajectoryStatus(id, status);
        }
      }
    }
    return;
  }

  if (!job.againstTrajectoryId) {
    db.update(screeningJobs)
      .set({ status: "completed", completedAt: new Date().toISOString() })
      .where(eq(screeningJobs.id, job.id))
      .run();
    return;
  }

  ingestScreeningResult({
    jobId: job.id,
    approaches: result.approaches,
    primaryTrajectoryId: job.trajectoryId,
    secondaryTrajectoryId: job.againstTrajectoryId,
  });
}

function requeueJob(jobId: string): void {
  const { db } = getDb();
  db.update(screeningJobs)
    .set({ status: "pending", workerId: null, dispatchedAt: null })
    .where(eq(screeningJobs.id, jobId))
    .run();
}

/** TLS is mandatory in production: this channel carries ephemerides. */
function serverCredentials(): grpc.ServerCredentials {
  const certPath = process.env.SPACE_SAFETY_GRPC_CERT;
  const keyPath = process.env.SPACE_SAFETY_GRPC_KEY;

  if (certPath && keyPath) {
    const caPath = process.env.SPACE_SAFETY_GRPC_CA;
    return grpc.ServerCredentials.createSsl(
      caPath ? readFileSync(caPath) : null,
      [{ private_key: readFileSync(keyPath), cert_chain: readFileSync(certPath) }],
      // Require a client certificate.
      true,
    );
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "refusing to start the compute channel without TLS in production (set SPACE_SAFETY_GRPC_CERT/KEY)",
    );
  }
  return grpc.ServerCredentials.createInsecure();
}

let channel: ComputeChannel | undefined;

export function getComputeChannel(): ComputeChannel {
  channel ??= new ComputeChannel();
  return channel;
}
