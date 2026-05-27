// Runner entrypoint. Wires up:
//   - Postgres pool (shared with the API, opened via DATABASE_URL)
//   - Docker client + SandboxExecutor for the sandboxed run
//   - Three trigger sources: cron, webhook (Fastify), SFTP (poller)
//   - A sync loop that reconciles trigger registrations against the DB
//
// Env:
//   DATABASE_URL        Postgres connection string (required)
//   SANDBOX_IMAGE       Docker image for the sandbox (default temper-sandbox-base:latest)
//   EGRESS_PROXY_URL    Proxy URL the sandbox routes egress through
//                       (default http://egress-proxy:5080)
//   SANDBOX_MEMORY_MB   Container memory limit (default 256)
//   RUNNER_PORT         Webhook listener port (default 5003)
//   DEMO_TENANT_ID      Tenant used by webhook fallback + SFTP watcher
//
// Shutdown: SIGTERM stops the sync loop, scheduler, and SFTP poller, closes
// the webhook server, then closes the Postgres pool.

import { openDb, closeDb } from "@temper/db";
import { createSandboxExecutor } from "@temper/sandbox";
import { startScheduler } from "./scheduler.js";
import { startWebhookListener } from "./webhook-listener.js";
import { startSftpWatcher } from "./sftp-watcher.js";
import { startSyncLoop } from "./sync.js";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = await openDb(connectionString);
  // Factory picks E2B if E2B_API_KEY is set (prod / cloud), Docker otherwise (local dev).
  const sandbox = createSandboxExecutor({
    docker: {
      baseImage: process.env.SANDBOX_IMAGE ?? "temper-sandbox-base:latest",
      egressProxyUrl: process.env.EGRESS_PROXY_URL ?? "http://egress-proxy:5080",
      egressProxyLogUrl: process.env.EGRESS_PROXY_LOG_URL ?? "http://localhost:5080/log",
      networkName: process.env.SANDBOX_NETWORK_NAME ?? "temper_temper-net",
      memoryMb: Number(process.env.SANDBOX_MEMORY_MB ?? 256),
    },
  });

  const ctx = { pool, sandbox };

  const scheduler = startScheduler(ctx);
  const port = Number(process.env.RUNNER_PORT ?? 5003);
  const webhookServer = await startWebhookListener(ctx, port);
  const sftpWatcher = startSftpWatcher(ctx);
  const sync = startSyncLoop({ ...ctx, scheduler, sftpWatcher });

  const shutdown = async (signal: string) => {
    console.log(`[runner] ${signal} received, shutting down`);
    sync.stop();
    scheduler.stopAll();
    sftpWatcher.stop();
    try {
      await webhookServer.close();
    } catch (err) {
      console.error("[runner] webhook close failed:", err);
    }
    try {
      await closeDb(pool);
    } catch (err) {
      console.error("[runner] pool close failed:", err);
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  console.log(
    `[runner] started — webhook on :${port}, sync + scheduler + sftp watcher active`,
  );
}

main().catch((err) => {
  console.error("[runner] fatal:", err);
  process.exit(1);
});
