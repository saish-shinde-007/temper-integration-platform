// Public surface of @temper/workflows.
//
// The worker (worker.ts) and the workflow runtime (workflow.ts) are
// deliberately NOT re-exported from here. Importing the workflow
// module from a normal Node process triggers Temporal's deterministic-
// import sandbox and explodes; only the worker bundler should resolve
// workflow.js, via Worker.create({ workflowsPath }).
//
// API callers want the client; that's it.

export { TemporalClient, workflowIdFor } from "./client.js";
export type { IntegrationWorkflowInput } from "./workflow.js";
// Re-export activities specifically for the all-in-one platform entrypoint
// that runs the worker in the same process as the API. Normal API code does
// NOT need this export.
export * as activities from "./activities.js";
