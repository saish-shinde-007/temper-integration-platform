// "Fire one integration" — the single function every trigger path funnels
// through. Looks up the deployed version, gathers secrets, runs the sandbox,
// persists the run row, audits, and updates the integration state.
//
// All trigger paths (cron, webhook, sftp, manual) call this. The trigger
// source is recorded on the Run so we can attribute failures later.
//
// State transitions:
//   - succeeded run            -> Running
//   - 3 consecutive non-success runs (newest 3) -> Degraded
// We leave Deployed untouched on first-ever failure; integrations can
// flap between Running and Degraded based on the most recent window.

import { Repo, SecretsManager, AuditLogger } from "@temper/db";
import type { SandboxAPI, SandboxResult } from "@temper/shared";
import type pg from "pg";

export interface FireContext {
  pool: pg.Pool;
  sandbox: SandboxAPI;
}

export type TriggerSource = "cron" | "webhook" | "sftp" | "manual";

export async function fireIntegration(
  ctx: FireContext,
  integrationId: string,
  tenantId: string,
  triggerSource: TriggerSource,
  triggerPayload?: unknown,
): Promise<SandboxResult> {
  const repo = new Repo(ctx.pool, tenantId);
  const integration = await repo.getIntegration(integrationId);
  if (!integration) {
    throw new Error(
      `Integration ${integrationId} not found for tenant ${tenantId}`,
    );
  }
  if (
    integration.state !== "Deployed" &&
    integration.state !== "Running" &&
    integration.state !== "Degraded"
  ) {
    // Degraded is still firable — we want it to recover. But pre-Deployed
    // states (Draft/Generating/Tested/Approved/Building/Retired) are not.
    throw new Error(
      `Integration ${integrationId} not firable (state: ${integration.state})`,
    );
  }
  if (!integration.current_version_id) {
    throw new Error(
      `Integration ${integrationId} has no current version`,
    );
  }

  const version = await repo.getIntegrationVersion(integration.current_version_id);
  if (!version) {
    throw new Error(
      `Version ${integration.current_version_id} not found`,
    );
  }

  // SecretsManager takes an AuditLoggerFactory so it can audit reads under
  // the secret owner's tenant — we just hand back a fresh AuditLogger.
  const secrets = new SecretsManager(
    ctx.pool,
    (tid: string) => new AuditLogger(ctx.pool, tid),
  );

  const secretMap: Record<string, string> = {};
  for (const name of version.declared_secrets) {
    const value = await secrets.getSecret(tenantId, name);
    if (value !== null) secretMap[name] = value;
  }

  // Insert a pending run row up front so the run is visible in the UI even
  // if the sandbox hangs. We update it once we have a result.
  const run = await repo.createRun({
    integration_id: integrationId,
    version_id: version.id,
    status: "running",
    trigger_source: triggerSource,
  });

  let sandboxResult: SandboxResult;
  try {
    sandboxResult = await ctx.sandbox.run({
      source_code: version.source_code,
      declared_endpoints: version.declared_endpoints,
      secrets: secretMap,
      timeout_ms: 30_000,
      memory_mb: 256,
      trigger_payload: triggerPayload,
    });
  } catch (err) {
    // Sandbox infra failure (Docker down, image missing, etc.). Mark the
    // run failed with the error in stderr so it's still inspectable.
    const message = err instanceof Error ? err.message : String(err);
    await repo.updateRun(run.id, {
      status: "failed",
      completed_at: new Date().toISOString(),
      duration_ms: null,
      exit_code: null,
      stdout: "",
      stderr: `[runner] sandbox.run threw: ${message}`,
      output_payload: null,
      egress_calls: [],
    });

    // Audit and re-evaluate state, then rethrow so callers see the failure.
    const audit = new AuditLogger(ctx.pool, tenantId);
    await audit.record("integration.run", null, {
      integrationId,
      runId: run.id,
      status: "failed",
      error: message,
    });
    await maybeDegrade(repo, integrationId);
    throw err;
  }

  await repo.updateRun(run.id, {
    status: sandboxResult.status,
    completed_at: new Date().toISOString(),
    duration_ms: sandboxResult.duration_ms,
    exit_code: sandboxResult.exit_code,
    stdout: sandboxResult.stdout,
    stderr: sandboxResult.stderr,
    output_payload: sandboxResult.output_payload,
    egress_calls: sandboxResult.egress_calls,
  });

  const audit = new AuditLogger(ctx.pool, tenantId);
  await audit.record("integration.run", null, {
    integrationId,
    runId: run.id,
    status: sandboxResult.status,
  });

  if (sandboxResult.status === "succeeded") {
    // Always promote to Running on a clean run, even from Degraded — that's
    // how an integration recovers.
    if (integration.state !== "Running") {
      await repo.updateIntegrationState(integrationId, "Running");
    }
  } else {
    await maybeDegrade(repo, integrationId);
  }

  return sandboxResult;
}

/**
 * Mark integration Degraded if the most recent 3 runs are all non-success.
 * No-op if fewer than 3 runs exist (we don't want one failure right after
 * deployment to flip the state).
 */
async function maybeDegrade(repo: Repo, integrationId: string): Promise<void> {
  const recent = (await repo.listRunsForIntegration(integrationId)).slice(0, 3);
  if (recent.length >= 3 && recent.every((r) => r.status !== "succeeded")) {
    const current = await repo.getIntegration(integrationId);
    if (current && current.state !== "Degraded") {
      await repo.updateIntegrationState(integrationId, "Degraded");
    }
  }
}
