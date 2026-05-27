// Workflow activities — every side effect lives here.
//
// Activities can import from anywhere (db, agent, sandbox, anthropic,
// dockerode). Workflows cannot. Splitting them this way is what lets
// the workflow run deterministically while still talking to a SQLite
// file, the Anthropic API, and the Docker daemon.
//
// Each activity opens its own DB handle, does its work, and lets the
// handle fall out of scope on return. better-sqlite3 connections are
// cheap (microseconds) so we don't bother sharing one — and a shared
// long-lived handle across many concurrent activities would be a
// liability for tests that swap the DATABASE_PATH at runtime.

import Docker from "dockerode";
import { createHash } from "node:crypto";
import {
  openDb,
  Repo,
  SecretsManager,
  AuditLogger,
} from "@temper/db";
import { ClaudeAgent, createAgent } from "@temper/agent";
import type { AgentAPI } from "@temper/shared";
import { SandboxExecutor, createSandboxExecutor } from "@temper/sandbox";
import type { SandboxAPI } from "@temper/shared";
import type { IntegrationState, SandboxResult } from "@temper/shared";
import type { IntegrationWorkflowInput } from "./workflow.js";

// ---------- Configuration knobs ----------
//
// Each one falls back to a sensible default so the worker can start
// against a vanilla `docker compose up` stack with no extra env vars.

const DB_PATH = () => process.env.DATABASE_PATH ?? "./data/temper.db";
const SANDBOX_BASE_IMAGE = () =>
  process.env.SANDBOX_IMAGE ?? "temper-sandbox-base:latest";
const SANDBOX_NETWORK = () =>
  process.env.SANDBOX_NETWORK ?? "temper-net";
const SANDBOX_TIMEOUT_MS = () =>
  Number(process.env.SANDBOX_TIMEOUT_SECONDS ?? "30") * 1000;
const SANDBOX_MEMORY_MB = () =>
  Number(process.env.SANDBOX_MEMORY_MB ?? "256");
const SANDBOX_CPU = () => Number(process.env.SANDBOX_CPU ?? "0.5");
const EGRESS_PROXY_URL = () =>
  process.env.EGRESS_PROXY_URL ?? "http://egress-proxy:5080";
const EGRESS_PROXY_LOG_URL = () =>
  process.env.EGRESS_PROXY_LOG_URL ?? "http://localhost:5080/log";

// ---------- Small DI / testing seams ----------
//
// Activities accept their dependencies from these factories. Tests
// override them to inject in-memory DBs, fake agents, and stub
// sandbox executors. Production callers (the worker) leave them alone
// and get the real wiring.

export interface ActivityDeps {
  openDb: typeof openDb;
  makeAgent: () => AgentAPI;
  makeSandbox: () => SandboxAPI;
  makeDocker: () => Docker;
  now: () => string;
  hash: (s: string) => string;
}

const defaultDeps: ActivityDeps = {
  openDb,
  // createAgent() picks the right harness from AGENT_PROVIDER:
  //   agentic → multi-turn Claude Agent SDK with in-loop sandbox validation (the real shape)
  //   cli     → single-shot claude CLI
  //   api     → single-shot Anthropic SDK
  //   auto    → falls back to api if ANTHROPIC_API_KEY set, else cli
  // The agentic generator needs a sandbox so it can validate its own drafts.
  makeAgent: () => createAgent({ sandbox: defaultDeps.makeSandbox() }),
  // Factory picks E2B (Firecracker via E2B) if E2B_API_KEY is set, otherwise
  // hardened Docker for local dev. Same SandboxAPI contract either way.
  makeSandbox: () =>
    createSandboxExecutor({
      docker: {
        baseImage: SANDBOX_BASE_IMAGE(),
        egressProxyUrl: EGRESS_PROXY_URL(),
        egressProxyLogUrl: EGRESS_PROXY_LOG_URL(),
        memoryMb: SANDBOX_MEMORY_MB(),
        cpu: SANDBOX_CPU(),
        networkName: SANDBOX_NETWORK(),
        failClosedOnProxy: process.env.SANDBOX_FAIL_CLOSED === "1",
      },
    }),
  makeDocker: () => new Docker(),
  now: () => new Date().toISOString(),
  hash: (s) => createHash("sha256").update(s).digest("hex"),
};

let deps: ActivityDeps = defaultDeps;

/**
 * Override the activity dependencies. Tests call this to inject fakes;
 * call `resetActivityDeps()` to restore defaults. Untouched in the
 * worker process.
 */
export function setActivityDeps(overrides: Partial<ActivityDeps>): void {
  deps = { ...defaultDeps, ...deps, ...overrides };
}

export function resetActivityDeps(): void {
  deps = defaultDeps;
}

// ---------- Helper: scoped repo + audit ----------

// Module-level lazy pool so we don't open a connection per activity call.
let _pool: import("pg").Pool | null = null;
async function getPool(): Promise<import("pg").Pool> {
  if (!_pool) {
    _pool = await deps.openDb(DB_PATH());
  }
  return _pool;
}

async function withTenantScope(tenantId: string) {
  const db = await getPool();
  const repo = new Repo(db, tenantId);
  const auditFor = (tid: string) => new AuditLogger(db, tid);
  const audit = auditFor(tenantId);
  let secrets: SecretsManager | null = null;
  const getSecrets = () => {
    if (!secrets) secrets = new SecretsManager(db, auditFor);
    return secrets;
  };
  return { db, repo, audit, getSecrets };
}

// ============================================================
// Activities
// ============================================================

/**
 * Move the integration to a new state. Idempotent at the row level —
 * setting the same state twice is a no-op write but still safe under
 * Temporal's at-least-once delivery.
 */
export async function updateIntegrationState(
  input: IntegrationWorkflowInput,
  state: string,
): Promise<void> {
  const { repo } = await withTenantScope(input.tenantId);
  await repo.updateIntegrationState(input.integrationId, state as IntegrationState);
}

/**
 * Call the agent to produce a new IntegrationVersion. Persists the
 * version row and audits the event. Does NOT flip the integration's
 * current_version_id — that happens at deploy time.
 */
export async function generateCode(
  input: IntegrationWorkflowInput,
): Promise<{ versionId: string; sha256: string }> {
  const { repo, audit } = await withTenantScope(input.tenantId);
  const integration = await repo.getIntegration(input.integrationId);
  if (!integration) {
    throw new Error(
      `Integration ${input.integrationId} not found in tenant ${input.tenantId}`,
    );
  }

  const agent = deps.makeAgent();
  const out = await agent.generateIntegrationCode({
    description: integration.description,
    trigger: integration.trigger,
  });

  const version = await repo.createIntegrationVersion(input.integrationId, {
    sha256: out.sha256,
    source_code: out.source_code,
    declared_endpoints: out.declared_endpoints,
    declared_secrets: out.declared_secrets,
  });

  await audit.record("integration.generated", null, {
    integration_id: input.integrationId,
    version_id: version.id,
    sha256: out.sha256,
    declared_endpoints: out.declared_endpoints,
    declared_secrets: out.declared_secrets,
  });

  return { versionId: version.id, sha256: out.sha256 };
}

/**
 * Execute the generated code in the hardened sandbox.
 *
 * Persists a Run row for the sandbox execution so the UI can show the
 * test result alongside subsequent production runs. The Run is marked
 * with trigger_source='manual' since this isn't a production cron firing.
 */
export async function runSandbox(
  input: IntegrationWorkflowInput & { versionId: string },
): Promise<{ status: string; runId: string }> {
  const { repo, audit, getSecrets } = await withTenantScope(input.tenantId);
  const version = await repo.getIntegrationVersion(input.versionId);
  if (!version) {
    throw new Error(
      `Version ${input.versionId} not found in tenant ${input.tenantId}`,
    );
  }

  // Resolve declared secrets at sandbox time. A missing secret is NOT a
  // hard error here — the generated code may declare a secret but tolerate
  // its absence (read from process.env, fall back to a default). We pass
  // through whatever is set and let the code fail naturally if it really
  // needs a value.
  const resolvedSecrets: Record<string, string> = {};
  const secrets = getSecrets();
  for (const name of version.declared_secrets) {
    const value = await secrets.getSecret(input.tenantId, name);
    if (value !== null) {
      resolvedSecrets[name] = value;
    }
  }

  // Create the Run row first so it's visible in the UI as soon as the
  // sandbox starts, then update it when we're done.
  const run = await repo.createRun({
    integration_id: input.integrationId,
    version_id: input.versionId,
    trigger_source: "manual",
    status: "running",
  });

  let result: SandboxResult;
  try {
    const sandbox = deps.makeSandbox();
    result = await sandbox.run({
      source_code: version.source_code,
      declared_endpoints: version.declared_endpoints,
      secrets: resolvedSecrets,
      timeout_ms: SANDBOX_TIMEOUT_MS(),
      memory_mb: SANDBOX_MEMORY_MB(),
    });
  } catch (err) {
    // Sandbox infrastructure failure (docker daemon down, image missing,
    // etc.). Record it on the run row so the UI sees something useful and
    // rethrow so Temporal can decide whether to retry the activity.
    await repo.updateRun(run.id, {
      status: "failed",
      completed_at: deps.now(),
      stderr: `sandbox infrastructure error: ${String(err)}`,
    });
    throw err;
  }

  await repo.updateRun(run.id, {
    status: result.status === "succeeded" ? "succeeded" : result.status,
    completed_at: deps.now(),
    duration_ms: result.duration_ms,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    output_payload: result.output_payload,
    egress_calls: result.egress_calls,
  });

  await audit.record("integration.tested", null, {
    integration_id: input.integrationId,
    version_id: input.versionId,
    run_id: run.id,
    status: result.status,
    duration_ms: result.duration_ms,
    egress_count: result.egress_calls.length,
  });

  return { status: result.status, runId: run.id };
}

/**
 * "Build" an image tag for the version.
 *
 * We deliberately do NOT build a separate Docker image per integration
 * in the demo — that would mean a layer per integration, a registry
 * push, and a pull on every run. The base sandbox image already has
 * everything generated code needs at runtime; the runner mounts the
 * integration source into it. So "building" is really just computing
 * a deterministic tag from the version's sha256 and recording it.
 *
 * In production this activity would do the real `docker build` against
 * a per-integration Dockerfile (or kaniko in-cluster) and push to the
 * registry. The contract — return a tag the runner can resolve — stays
 * the same. That's the point of having it as an activity boundary.
 */
export async function buildImage(
  input: IntegrationWorkflowInput & { versionId: string },
): Promise<{ imageTag: string }> {
  const { repo, audit } = await withTenantScope(input.tenantId);
  const version = await repo.getIntegrationVersion(input.versionId);
  if (!version) {
    throw new Error(
      `Version ${input.versionId} not found in tenant ${input.tenantId}`,
    );
  }

  // Short-hash tag: `temper-int-<integration_id>-<sha256[0..12]>`. Stable
  // across reruns (idempotent) and informative on docker ps output.
  const shaShort = version.sha256.slice(0, 12);
  const imageTag = `temper-int-${input.integrationId}-${shaShort}`;

  await audit.record("integration.deployed", null, {
    integration_id: input.integrationId,
    version_id: input.versionId,
    sha256: version.sha256,
    image_tag: imageTag,
    phase: "build",
  });

  return { imageTag };
}

/**
 * Wire the version up so the runner can pick it up.
 *
 * Concretely: flip `integrations.current_version_id` to the approved
 * version and set state='Deployed'. The runner polls the integrations
 * table for newly Deployed rows and starts triggering them per their
 * cron / webhook / sftp config.
 *
 * State is intentionally set inside this activity (not only via the
 * workflow's updateIntegrationState call) so that the version-pointer
 * flip and the state flip happen under the same DB connection — a
 * crash between them would leak a half-deployed integration.
 */
export async function deployToRunner(
  input: IntegrationWorkflowInput & { versionId: string; imageTag: string },
): Promise<void> {
  const { repo, audit } = await withTenantScope(input.tenantId);
  // setCurrentVersion + updateIntegrationState both run synchronously
  // against the same db handle, which in better-sqlite3 means they
  // serialize naturally. There's no explicit BEGIN/COMMIT here because
  // each statement is one transaction by default and the second only
  // runs if the first succeeded.
  await repo.setCurrentVersion(input.integrationId, input.versionId);
  await repo.updateIntegrationState(input.integrationId, "Deployed");

  await audit.record("integration.deployed", null, {
    integration_id: input.integrationId,
    version_id: input.versionId,
    image_tag: input.imageTag,
    phase: "deployed",
  });
}

/**
 * Workflow caught an unrecoverable error. Mark the integration as
 * back to Draft (the only safe terminal-failure state in the current
 * state machine — we don't have a 'Failed' state) and record the cause
 * in the audit chain.
 */
export async function markFailed(
  input: IntegrationWorkflowInput,
  err: string,
): Promise<void> {
  const { repo, audit } = await withTenantScope(input.tenantId);
  // updateIntegrationState may itself throw if the integration was
  // already deleted. Don't let that swallow the original error — log
  // it and continue.
  try {
    await repo.updateIntegrationState(input.integrationId, "Draft");
  } catch {
    // best-effort
  }
  await audit.record("integration.rejected", null, {
    integration_id: input.integrationId,
    reason: "workflow_failure",
    error: err,
  });
}
