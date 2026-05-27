// Temporal client interface + a self-contained stub.
//
// The architecture's source of truth for state transitions is a Temporal
// workflow (see @temper/workflows). The HTTP control plane never decides
// state on its own — it sends signals and reads back. But Temporal is a
// separate process that may not be running during local UI work or in
// tests, so we ship a stub that fakes the workflow by mutating DB rows
// directly.
//
// When @temper/workflows is wired in for real, the entrypoint will swap
// StubTemporalClient for the real TemporalClient. The signal API and
// return shapes are identical.
//
// Import @temper/workflows is wrapped in a try/catch at the call site
// (src/index.ts) so the API still boots when the workflows package
// hasn't been built yet — the stub is the safe default.

import type pg from "pg";
import { Repo, AuditLogger } from "@temper/db";
import type { IntegrationState } from "@temper/shared";

// ---------- Public contract ----------

export interface TemporalClient {
  startIntegrationWorkflow(
    integrationId: string,
    tenantId: string,
  ): Promise<{ workflowId: string }>;
  signalApprove(workflowId: string, versionId: string): Promise<void>;
  signalReject(workflowId: string, reason?: string): Promise<void>;
  signalDeploy(workflowId: string): Promise<void>;
}

// ---------- Stub implementation ----------
//
// The stub simulates the workflow by walking the state machine in the DB:
//   Draft → Generating → Tested        (on start)
//   Tested → Approved                  (on signalApprove)
//   Approved → Draft                   (on signalReject)
//   Approved → Building → Deployed → Running (on signalDeploy)
//
// It also creates a fake IntegrationVersion + a fake Run so the UI has
// something to render. The real workflow does the same work via Temporal
// activities; this just collapses it to inline DB writes.

interface WorkflowHandle {
  integrationId: string;
  tenantId: string;
  currentVersionId: string | null;
}

export class StubTemporalClient implements TemporalClient {
  private readonly handles = new Map<string, WorkflowHandle>();

  constructor(private readonly pool: pg.Pool) {}

  async startIntegrationWorkflow(
    integrationId: string,
    tenantId: string,
  ): Promise<{ workflowId: string }> {
    const workflowId = `wf-${integrationId}`;
    // eslint-disable-next-line no-console
    console.log("[temporal-stub] startIntegrationWorkflow", {
      integrationId,
      tenantId,
      workflowId,
    });

    const repo = new Repo(this.pool, tenantId);
    const audit = new AuditLogger(this.pool, tenantId);

    // Verify the integration exists in this tenant.
    const integration = await repo.getIntegration(integrationId);
    if (!integration) {
      throw new Error(
        `Integration ${integrationId} not found in tenant ${tenantId}`,
      );
    }

    // Move Draft → Generating → Tested with a fake version + run attached.
    await this.setState(repo, integrationId, "Generating");

    // Synthesize a placeholder version. The real workflow asks the agent;
    // the stub just fabricates valid-looking code so the UI has something.
    const sha256 =
      "stub" + "0".repeat(64 - "stub".length); // 64 chars, validates against shared schema
    const version = await repo.createIntegrationVersion(integrationId, {
      sha256,
      source_code:
        "// [stub] generated integration code placeholder\n" +
        "export default async function run() {\n" +
        "  console.log('hello from stub');\n" +
        "}\n",
      declared_endpoints: [],
      declared_secrets: [],
    });
    await repo.setCurrentVersion(integrationId, version.id);

    // Record a synthetic successful test run.
    const run = await repo.createRun({
      integration_id: integrationId,
      version_id: version.id,
      trigger_source: "manual",
    });
    await repo.updateRun(run.id, {
      status: "succeeded",
      completed_at: new Date().toISOString(),
      duration_ms: 42,
      exit_code: 0,
      stdout: "[stub] test run produced no output\n",
      stderr: "",
      output_payload: null,
      egress_calls: [],
    });

    await this.setState(repo, integrationId, "Tested");

    await audit.record("integration.generated", null, {
      integration_id: integrationId,
      version_id: version.id,
      workflow_id: workflowId,
      stub: true,
    });
    await audit.record("integration.tested", null, {
      integration_id: integrationId,
      version_id: version.id,
      run_id: run.id,
      workflow_id: workflowId,
      stub: true,
    });

    this.handles.set(workflowId, {
      integrationId,
      tenantId,
      currentVersionId: version.id,
    });

    return { workflowId };
  }

  async signalApprove(workflowId: string, versionId: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.log("[temporal-stub] signalApprove", { workflowId, versionId });
    const handle = this.requireHandle(workflowId);
    const repo = new Repo(this.pool, handle.tenantId);

    // Confirm the version belongs to this integration in this tenant.
    const version = await repo.getIntegrationVersion(versionId);
    if (!version || version.integration_id !== handle.integrationId) {
      throw new Error(
        `Version ${versionId} does not belong to integration ${handle.integrationId}`,
      );
    }

    await repo.setCurrentVersion(handle.integrationId, versionId);
    await this.setState(repo, handle.integrationId, "Approved");
    handle.currentVersionId = versionId;
  }

  async signalReject(workflowId: string, reason?: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.log("[temporal-stub] signalReject", { workflowId, reason });
    const handle = this.requireHandle(workflowId);
    const repo = new Repo(this.pool, handle.tenantId);
    await this.setState(repo, handle.integrationId, "Draft");
  }

  async signalDeploy(workflowId: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.log("[temporal-stub] signalDeploy", { workflowId });
    const handle = this.requireHandle(workflowId);
    const repo = new Repo(this.pool, handle.tenantId);
    await this.setState(repo, handle.integrationId, "Building");
    await this.setState(repo, handle.integrationId, "Deployed");
    await this.setState(repo, handle.integrationId, "Running");
  }

  // ---- internal helpers ----

  private requireHandle(workflowId: string): WorkflowHandle {
    const handle = this.handles.get(workflowId);
    if (!handle) {
      throw new Error(`Unknown workflow ${workflowId}`);
    }
    return handle;
  }

  private async setState(
    repo: Repo,
    integrationId: string,
    state: IntegrationState,
  ): Promise<void> {
    await repo.updateIntegrationState(integrationId, state);
  }
}

// ---------- Factory ----------
//
// Tries to load the real TemporalClient from @temper/workflows. Falls
// back to the stub if the package isn't available or fails to construct
// (e.g. Temporal server isn't running). The factory is async because
// dynamic import is async.

export async function createTemporalClient(
  pool: pg.Pool,
): Promise<TemporalClient> {
  if (process.env.TEMPER_USE_STUB_TEMPORAL === "1") {
    return new StubTemporalClient(pool);
  }
  try {
    const workflowsModuleId = "@temper/workflows";
    const mod = (await import(/* @vite-ignore */ workflowsModuleId).catch(
      (e) => {
        console.warn("[temporal] @temper/workflows import failed:", e?.message);
        return null;
      },
    )) as
      | {
          TemporalClient?: {
            connect: (address?: string, namespace?: string) => Promise<{
              startIntegrationWorkflow: (input: { integrationId: string; tenantId: string }) => Promise<{ workflowId: string; runId: string }>;
              signalApprove: (integrationId: string, versionId: string) => Promise<void>;
              signalReject: (integrationId: string, reason?: string) => Promise<void>;
              signalDeploy: (integrationId: string) => Promise<void>;
            }>;
          };
        }
      | null;
    if (mod && mod.TemporalClient && mod.TemporalClient.connect) {
      const real = await mod.TemporalClient.connect(
        process.env.TEMPORAL_ADDRESS,
        process.env.TEMPORAL_NAMESPACE,
      );
      console.log("[temporal] connected to", process.env.TEMPORAL_ADDRESS ?? "localhost:7233");
      // Adapter: API's interface uses workflowId in signals, but the real
      // client derives workflowId from integrationId via workflowIdFor().
      // We just pass integrationId through — naming is cosmetic since the
      // API also uses `integration-<id>` as the workflow id.
      return {
        async startIntegrationWorkflow(integrationId, tenantId) {
          const { workflowId } = await real.startIntegrationWorkflow({
            integrationId,
            tenantId,
          });
          return { workflowId };
        },
        async signalApprove(workflowId, versionId) {
          const integrationId = workflowId.replace(/^integration-/, "");
          await real.signalApprove(integrationId, versionId);
        },
        async signalReject(workflowId, reason) {
          const integrationId = workflowId.replace(/^integration-/, "");
          await real.signalReject(integrationId, reason);
        },
        async signalDeploy(workflowId) {
          const integrationId = workflowId.replace(/^integration-/, "");
          await real.signalDeploy(integrationId);
        },
      };
    }
  } catch (e) {
    console.warn("[temporal] real client failed, using stub:", e instanceof Error ? e.message : String(e));
  }
  return new StubTemporalClient(pool);
}
