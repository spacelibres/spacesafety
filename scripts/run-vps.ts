/**
 * VPS process: Next.js HTTP API + the gRPC compute channel.
 *
 * In production these usually run as separate units (Next.js behind a TLS
 * terminator, the gRPC server as its own service). For local operation one
 * process is enough and keeps the demo simple.
 *
 *   npm run vps            # gRPC on :50051, API served by `next start`
 */
import { getComputeChannel } from "../src/lib/grpc/server";

async function main() {
  const channel = getComputeChannel();
  const port = await channel.start();
  console.log(`[vps] compute channel ready on :${port}`);

  const shutdown = async () => {
    console.log("\n[vps] shutting down");
    await channel.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();

// Keep this file a module: without an export every `main` here lands in the
// global scope and collides with the other scripts' `main`.
export {};
