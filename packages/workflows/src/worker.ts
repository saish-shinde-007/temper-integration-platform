// Worker process entrypoint.
//
// Run via `pnpm --filter @temper/workflows dev` in the demo (tsx watch)
// or `pnpm --filter @temper/workflows start` against built JS. The worker
// connects to the Temporal server, registers the workflow + activities,
// and blocks until the process is killed.
//
// One worker can host many workflows; the integration platform only
// needs one workflow type today but we still register on a named task
// queue so additional workers can scale this out horizontally.

import { Worker, NativeConnection } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TEMPORAL_TASK_QUEUE } from "@temper/shared";
import * as activities from "./activities.js";

async function run() {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });

  // We resolve the workflow bundle path from THIS module's location so
  // the worker works whether we're running compiled JS (dist/) or tsx
  // against src/. The trailing `.js` is intentional — Temporal looks
  // for the runtime artifact, not the .ts source.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const workflowsPath = join(__dirname, "workflow.js");

  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue: TEMPORAL_TASK_QUEUE,
    workflowsPath,
    activities,
  });

  // eslint-disable-next-line no-console
  console.log(
    "Temper workflow worker starting on task queue:",
    TEMPORAL_TASK_QUEUE,
  );
  await worker.run();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
