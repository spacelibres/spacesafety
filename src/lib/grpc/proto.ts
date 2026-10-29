/**
 * gRPC plumbing shared by the VPS (server) and the compute worker (client).
 *
 * The proto is loaded dynamically with `proto-loader`, so there is no codegen
 * step to keep in sync. Message shapes are declared by hand below and mirror
 * `proto/worker.proto` exactly.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Resolved relative to this file so it works from any working directory. */
export const PROTO_PATH =
  process.env.SPACE_EYES_PROTO ?? join(HERE, "../../../proto/worker.proto");

export const PROTOCOL_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Message shapes (mirror proto/worker.proto)
// ---------------------------------------------------------------------------

export interface StateVectorMsg {
  epochMs: string;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  /** Row-major 6x6, empty when no covariance was provided. */
  covariance: number[];
}

export interface TrajectorySampleMsg {
  trajectoryId: string;
  objectId: string;
  objectName: string;
  hardBodyRadiusKm: number;
  states: StateVectorMsg[];
  stateSource: string;
}

export interface ScreeningJobMsg {
  jobId: string;
  primary: TrajectorySampleMsg;
  secondary: TrajectorySampleMsg;
  maxSamplePoints: number;
  /**
   * Length of the spatial-pruning window, ms.
   *
   * Optional so existing callers keep working; omitted means the kernel default
   * (`DEFAULT_WINDOW_MS`, one twelfth of a typical LEO revolution). Shorter
   * windows prune harder but cost more window construction.
   */
  windowMs?: number;
}

export interface CloseApproachMsg {
  tcaEpochMs: string;
  missDistanceKm: number;
  totalMissDistanceKm: number;
  relativeSpeedKmS: number;
  /** Absent means NULL Pc in the resulting CDM. */
  probabilityOfCollision?: number;
  pcFailureReason: string;
  rtnR: number;
  rtnT: number;
  rtnN: number;
  covXx: number;
  covXy: number;
  covYy: number;
  lowRelativeSpeed: boolean;
}

export type JobStatusCode =
  | "JOB_STATUS_UNSPECIFIED"
  | "JOB_STATUS_COMPLETED"
  | "JOB_STATUS_FAILED"
  | "JOB_STATUS_TIMEOUT";

export interface ScreeningResultMsg {
  jobId: string;
  status: JobStatusCode;
  approaches: CloseApproachMsg[];
  error: string;
  computeMs: number;
}

export interface WorkerHelloMsg {
  workerId: string;
  version: string;
  concurrency: number;
  hostLabel: string;
}

export interface WorkerHeartbeatMsg {
  jobsInFlight: number;
  avgComputeMs: number;
}

export interface WorkerMessageMsg {
  hello?: WorkerHelloMsg;
  result?: ScreeningResultMsg;
  heartbeat?: WorkerHeartbeatMsg;
  draining?: boolean;
}

export interface DispatchJobMsg {
  job: ScreeningJobMsg;
}

export interface ServerMessageMsg {
  dispatch?: DispatchJobMsg;
  cancel?: { jobId: string };
  shutdown?: boolean;
}

export interface HealthResponseMsg {
  ok: boolean;
  version: string;
  connectedWorkers: number;
  jobsQueued: number;
  jobsInFlight: number;
}

export interface QueuedJobMsg {
  jobId: string;
  object1Name: string;
  object2Name: string;
  queuedAtMs: string;
}

export interface QueueResponseMsg {
  jobs: QueuedJobMsg[];
}

// ---------------------------------------------------------------------------
// Service definitions returned by proto-loader
// ---------------------------------------------------------------------------

export interface WorkerControlService extends grpc.UntypedServiceImplementation {
  Connect: (
    call: grpc.ServerDuplexStream<WorkerMessageMsg, ServerMessageMsg>,
  ) => void;
}

export interface CoordinatorService extends grpc.UntypedServiceImplementation {
  Health: (
    call: grpc.ServerUnaryCall<unknown, HealthResponseMsg>,
    cb: grpc.sendUnaryData<HealthResponseMsg>,
  ) => void;
  Queue: (
    call: grpc.ServerUnaryCall<{ limit: number }, QueueResponseMsg>,
    cb: grpc.sendUnaryData<QueueResponseMsg>,
  ) => void;
}

export interface WorkerControlClient extends grpc.Client {
  connect(): grpc.ClientDuplexStream<WorkerMessageMsg, ServerMessageMsg>;
}

export interface CoordinatorClient extends grpc.Client {
  health(
    req: Record<string, never>,
    cb: (err: grpc.ServiceError | null, res: HealthResponseMsg) => void,
  ): grpc.ClientUnaryCall;
  queue(
    req: { limit: number },
    cb: (err: grpc.ServiceError | null, res: QueueResponseMsg) => void,
  ): grpc.ClientUnaryCall;
}

export interface LoadedProto {
  /** Service definition, spread into `server.addService`. */
  WorkerControlServiceDefinition: grpc.ServiceDefinition;
  CoordinatorServiceDefinition: grpc.ServiceDefinition;
  WorkerControlClient: new (
    address: string,
    credentials: grpc.ChannelCredentials,
    options?: grpc.ClientOptions,
  ) => WorkerControlClient;
  CoordinatorClient: new (
    address: string,
    credentials: grpc.ChannelCredentials,
    options?: grpc.ClientOptions,
  ) => CoordinatorClient;
}

let loaded: LoadedProto | undefined;

export function loadProto(): LoadedProto {
  if (loaded) return loaded;

  const definition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const pkg = grpc.loadPackageDefinition(definition) as unknown as {
    spaceeyes: { worker: { v1: Record<string, unknown> } };
  };
  const v1 = pkg.spaceeyes.worker.v1;

  loaded = {
    WorkerControlServiceDefinition: (
      v1.WorkerControl as unknown as { service: grpc.ServiceDefinition }
    ).service,
    CoordinatorServiceDefinition: (
      v1.Coordinator as unknown as { service: grpc.ServiceDefinition }
    ).service,
    WorkerControlClient: v1.WorkerControl as unknown as LoadedProto["WorkerControlClient"],
    CoordinatorClient: v1.Coordinator as unknown as LoadedProto["CoordinatorClient"],
  };
  return loaded;
}

/**
 * Credentials for the compute channel.
 *
 * Ephemerides are sensitive (they reveal maneuver intent), so plaintext is
 * refused in production. Local development may opt in explicitly.
 */
export function clientCredentials(): grpc.ChannelCredentials {
  if (process.env.SPACE_EYES_GRPC_INSECURE === "1") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SPACE_EYES_GRPC_INSECURE is refused in production: the compute channel carries ephemerides",
      );
    }
    return grpc.credentials.createInsecure();
  }

  const caPath = process.env.SPACE_EYES_GRPC_CA;
  if (caPath) {
    return grpc.credentials.createSsl(
      readFileSync(caPath),
      readFileSync(process.env.SPACE_EYES_GRPC_KEY ?? ""),
      readFileSync(process.env.SPACE_EYES_GRPC_CERT ?? ""),
    );
  }

  // System trust store: used when the VPS presents a publicly trusted cert.
  return grpc.credentials.createSsl();
}

export { grpc };
