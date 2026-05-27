// Thin wrapper around @temporalio/client for the API package.
//
// The API doesn't speak gRPC to Temporal directly — it goes through
// this class so that (a) all workflow-ids are computed the same way
// in every caller, (b) signal payloads are typed against the same
// definitions the workflow registers, and (c) tests can mock this
// surface without mocking the Temporal SDK itself.

import { Client, Connection, WorkflowHandle } from "@temporalio/client";
import { TEMPORAL_TASK_QUEUE } from "@temper/shared";
import type { IntegrationWorkflowInput } from "./workflow.js";
import { approveSignal, rejectSignal, deploySignal } from "./workflow.js";

/**
 * The same workflow-id derivation used everywhere. Stable per
 * integration so that re-starting a workflow for the same integration
 * (after a retire+resurrect, say) will reuse-by-id rather than
 * spawning a parallel run.
 */
export function workflowIdFor(integrationId: string): string {
  return `integration-${integrationId}`;
}

export class TemporalClient {
  constructor(private readonly client: Client) {}

  /**
   * Connect to Temporal using env defaults. Wraps the connection and
   * client construction so the API package never has to import from
   * `@temporalio/client` itself.
   */
  static async connect(
    address: string = process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
    namespace: string = process.env.TEMPORAL_NAMESPACE ?? "default",
  ): Promise<TemporalClient> {
    const connection = await Connection.connect({ address });
    return new TemporalClient(new Client({ connection, namespace }));
  }

  /** Underlying client, exposed so the API can close it on shutdown. */
  raw(): Client {
    return this.client;
  }

  /**
   * Start the integration lifecycle workflow for a freshly-created
   * Draft integration. Idempotent on workflow-id: a second call with
   * the same integrationId will fail with WorkflowExecutionAlreadyStartedError
   * from Temporal, which the API converts to a 409.
   */
  async startIntegrationWorkflow(
    input: IntegrationWorkflowInput,
  ): Promise<{ workflowId: string; runId: string }> {
    const handle = await this.client.workflow.start("integrationWorkflow", {
      args: [input],
      taskQueue: TEMPORAL_TASK_QUEUE,
      workflowId: workflowIdFor(input.integrationId),
    });
    return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
  }

  /** Send the human approval signal for a specific version. */
  async signalApprove(integrationId: string, versionId: string): Promise<void> {
    const handle = this.handleFor(integrationId);
    await handle.signal(approveSignal, { versionId });
  }

  /** Reject the current Tested version and drop the integration back to Draft. */
  async signalReject(integrationId: string, reason?: string): Promise<void> {
    const handle = this.handleFor(integrationId);
    await handle.signal(rejectSignal, { reason });
  }

  /** Reserved redeploy signal — wired for future use by the UI. */
  async signalDeploy(integrationId: string): Promise<void> {
    const handle = this.handleFor(integrationId);
    await handle.signal(deploySignal);
  }

  /**
   * Best-effort describe — returns null if no workflow exists for that
   * integration yet. The API uses this to show "is the workflow alive?"
   * in the per-integration view.
   */
  async describe(integrationId: string): Promise<{
    status: string;
    runId: string;
    workflowId: string;
  } | null> {
    try {
      const handle = this.handleFor(integrationId);
      const desc = await handle.describe();
      return {
        status: desc.status.name,
        runId: desc.runId,
        workflowId: handle.workflowId,
      };
    } catch {
      return null;
    }
  }

  /** Cancel a running workflow (used when an integration is retired). */
  async cancel(integrationId: string): Promise<void> {
    const handle = this.handleFor(integrationId);
    await handle.cancel();
  }

  private handleFor(integrationId: string): WorkflowHandle {
    return this.client.workflow.getHandle(workflowIdFor(integrationId));
  }
}
