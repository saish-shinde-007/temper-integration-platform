// All-in-one platform entrypoint for Cloud Run.
//
// Cloud Run instances don't share filesystems, so the API, workflow worker,
// and runner — which all touch the same SQLite DB — have to live in one
// process. This entrypoint starts all three.
//
// Local dev still uses the separate packages (UI, API, worker, runner started
// independently via pnpm -r --parallel dev). This file is only used in the
// Cloud Run image.

import { openDb, seedDemoTenant, SecretsManager, AuditLogger, Repo } from "@temper/db";
import { buildApp } from "@temper/api";
import { Worker, NativeConnection } from "@temporalio/worker";
import { TEMPORAL_TASK_QUEUE } from "@temper/shared";
import { activities, TemporalClient } from "@temper/workflows";

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.DATABASE_PATH ?? "/tmp/temper.db";
const PORT = Number(process.env.PORT ?? 8080);
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";

async function seedDemoSecrets(db: Awaited<ReturnType<typeof openDb>>) {
  // Seed the demo tenant's secrets so generated integrations can reach the
  // public Cloud Run mock URLs without any manual UI step. These URLs come
  // from the Cloud Run deploy and are passed as env vars to this container.
  const tenantId = process.env.DEMO_TENANT_ID ?? "tenant-demo";
  const audit = new AuditLogger(db, tenantId);
  const secrets = new SecretsManager(db, () => audit);

  const seed = [
    { name: "SYSTEM_A_URL", value: process.env.SYSTEM_A_URL },
    { name: "SYSTEM_B_URL", value: process.env.SYSTEM_B_URL },
    { name: "CURSOR", value: "1970-01-01T00:00:00.000Z" },
  ];

  for (const { name, value } of seed) {
    if (!value) continue;
    const existing = await secrets.getSecret(tenantId, name).catch(() => null);
    if (!existing) {
      await secrets.setSecret(tenantId, name, value);
      console.log(`[seed] wrote secret ${name}`);
    }
  }
}

async function main() {
  console.log("[platform] starting all-in-one Temper platform...");

  // 1. Open DB, seed tenant + demo secrets.
  const db = await openDb(DATABASE_URL);
  await seedDemoTenant(db);
  await seedDemoSecrets(db);

  // 2. Connect the real Temporal client (the workflow worker is also in this
  //    process; the client talks to it via Temporal's gRPC).
  const realTemporal = await TemporalClient.connect(TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE);
  console.log(`[platform] Temporal client connected to ${TEMPORAL_ADDRESS}`);

  // Adapter shim so the API's TemporalClient interface matches what
  // @temper/workflows exports (signal methods take integrationId not workflowId).
  const temporalShim = {
    async startIntegrationWorkflow(integrationId: string, tenantId: string) {
      const { workflowId } = await realTemporal.startIntegrationWorkflow({ integrationId, tenantId });
      return { workflowId };
    },
    async signalApprove(workflowId: string, versionId: string) {
      const id = workflowId.replace(/^(integration-|wf-)/, "");
      await realTemporal.signalApprove(id, versionId);
    },
    async signalReject(workflowId: string, reason?: string) {
      const id = workflowId.replace(/^(integration-|wf-)/, "");
      await realTemporal.signalReject(id, reason);
    },
    async signalDeploy(workflowId: string) {
      const id = workflowId.replace(/^(integration-|wf-)/, "");
      await realTemporal.signalDeploy(id);
    },
  };

  // 3. Start the Fastify API with the REAL Temporal client (not stub).
  const app = await buildApp({ db, logger: true, temporal: temporalShim });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`[platform] API listening on :${PORT} (real Temporal wired)`);

  // 4. Start the Temporal workflow worker (background, no port).
  startWorker().catch((err) => {
    console.error("[platform] workflow worker exited unexpectedly:", err);
  });

  // 4. The runner's cron scheduler and webhook listener could also live here,
  //    but for the cloud deploy we let Temporal workflows handle the post-deploy
  //    execution path directly via activities. Manual fires can be triggered
  //    via the API's /deploy or /test endpoints.

  console.log("[platform] all subsystems started");
}

async function startWorker() {
  console.log(`[platform] connecting Temporal worker to ${TEMPORAL_ADDRESS} (ns: ${TEMPORAL_NAMESPACE})`);
  const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
  const worker = await Worker.create({
    connection,
    namespace: TEMPORAL_NAMESPACE,
    taskQueue: TEMPORAL_TASK_QUEUE,
    workflowsPath: new URL("/app/packages/workflows/dist/workflow.js", import.meta.url).pathname,
    activities,
  });
  console.log("[platform] workflow worker starting on task queue:", TEMPORAL_TASK_QUEUE);
  await worker.run();
}

main().catch((err) => {
  console.error("[platform] startup failed:", err);
  process.exit(1);
});
