// All cross-package contracts live here. Every other package imports
// types and schemas from @temper/shared. Changes here are breaking
// for every consumer; coordinate before editing.

import { z } from "zod";

// ============================================================
// Tenant / user / role
// ============================================================

export const Role = z.enum(["viewer", "builder", "approver", "admin"]);
export type Role = z.infer<typeof Role>;

export const TenantSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
});
export type Tenant = z.infer<typeof TenantSchema>;

export const UserSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  email: z.string().email(),
  role: Role,
  created_at: z.string(),
});
export type User = z.infer<typeof UserSchema>;

// ============================================================
// Integration state machine
// ============================================================

export const IntegrationState = z.enum([
  "Draft",
  "Generating",
  "Tested",
  "Approved",
  "Building",
  "Deployed",
  "Running",
  "Degraded",
  "Retired",
]);
export type IntegrationState = z.infer<typeof IntegrationState>;

// ============================================================
// Trigger config
// ============================================================

export const CronTriggerSchema = z.object({
  type: z.literal("cron"),
  expression: z.string(),
});
export type CronTrigger = z.infer<typeof CronTriggerSchema>;

export const WebhookTriggerSchema = z.object({
  type: z.literal("webhook"),
  path: z.string(),
});
export type WebhookTrigger = z.infer<typeof WebhookTriggerSchema>;

export const SftpTriggerSchema = z.object({
  type: z.literal("sftp"),
  host: z.string(),
  port: z.number().default(22),
  path: z.string(),
  pattern: z.string(),
});
export type SftpTrigger = z.infer<typeof SftpTriggerSchema>;

export const TriggerSchema = z.discriminatedUnion("type", [
  CronTriggerSchema,
  WebhookTriggerSchema,
  SftpTriggerSchema,
]);
export type Trigger = z.infer<typeof TriggerSchema>;

// ============================================================
// Integration + version
// ============================================================

export const IntegrationSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  name: z.string(),
  description: z.string(),
  state: IntegrationState,
  current_version_id: z.string().nullable(),
  trigger: TriggerSchema,
  created_at: z.string(),
  updated_at: z.string(),
});
export type Integration = z.infer<typeof IntegrationSchema>;

export const IntegrationVersionSchema = z.object({
  id: z.string(),
  integration_id: z.string(),
  sha256: z.string().length(64),
  source_code: z.string(),
  declared_endpoints: z.array(z.string()),
  declared_secrets: z.array(z.string()),
  created_at: z.string(),
});
export type IntegrationVersion = z.infer<typeof IntegrationVersionSchema>;

// ============================================================
// Agent contract
// ============================================================

export const AgentOutputSchema = z.object({
  source_code: z.string(),
  sha256: z.string().length(64),
  declared_endpoints: z.array(z.string()),
  declared_secrets: z.array(z.string()),
  language: z.literal("typescript"),
});
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

// Strict schema for what the LLM returns BEFORE the platform adds sha256.
// This is the contract the model must satisfy. Validation failures get the
// integration sent back to Draft with the validation error in the audit log.
export const AgentRawResponseSchema = z.object({
  source_code: z
    .string()
    .min(20, "source_code is suspiciously short")
    .refine((s) => /export\s+(?:async\s+)?function\s+run\s*\(/.test(s), {
      message:
        "source_code must export an `async function run(secrets, triggerPayload)` per the platform contract",
    })
    .refine(
      (s) =>
        !/(?:^|\n)\s*(?:interface\s+\w+|type\s+\w+\s*=|export\s+(?:interface|type)\s)/m.test(
          s,
        ),
      {
        message:
          "TypeScript type declarations (interface/type) are not allowed — sandbox runs plain Node.js",
      },
    ),
  declared_endpoints: z
    .array(
      z
        .string()
        .min(1)
        .refine((s) => !/^[A-Z][A-Z0-9_]+$/.test(s), {
          message:
            "declared_endpoints entry looks like a secret variable name (UPPER_SNAKE_CASE). Use the resolved *hostname* instead — e.g. 'api.systema.com', not 'SYSTEM_A_URL'.",
        })
        .refine((s) => !s.includes("://"), {
          message:
            "declared_endpoints entry must be a bare hostname (no scheme, no path) — strip 'http://' / 'https://'.",
        }),
    )
    .max(20),
  declared_secrets: z
    .array(
      z
        .string()
        .min(1)
        .regex(
          /^[A-Z][A-Z0-9_]*$/,
          "declared_secrets entries must be UPPER_SNAKE_CASE identifiers (matches env var convention)",
        ),
    )
    .max(20),
});
export type AgentRawResponse = z.infer<typeof AgentRawResponseSchema>;

export interface AgentRequest {
  description: string;
  trigger: Trigger;
  sample_payload?: string;
  target_schema?: string;
}

export interface AgentAPI {
  generateIntegrationCode(req: AgentRequest): Promise<AgentOutput>;
}

// ============================================================
// Sandbox contract
// ============================================================

export const EgressCallSchema = z.object({
  timestamp: z.string(),
  method: z.string(),
  url: z.string(),
  status_code: z.number().nullable(),
  blocked: z.boolean(),
  reason: z.string().optional(),
});
export type EgressCall = z.infer<typeof EgressCallSchema>;

export interface SandboxRequest {
  source_code: string;
  declared_endpoints: string[];
  secrets: Record<string, string>;
  timeout_ms: number;
  memory_mb: number;
  trigger_payload?: unknown;
}

export const SandboxResultSchema = z.object({
  status: z.enum(["succeeded", "failed", "timeout"]),
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().nullable(),
  duration_ms: z.number(),
  egress_calls: z.array(EgressCallSchema),
  source_sha256: z.string().length(64),
  output_payload: z.string().nullable(),
});
export type SandboxResult = z.infer<typeof SandboxResultSchema>;

export interface SandboxAPI {
  run(req: SandboxRequest): Promise<SandboxResult>;
}

// ============================================================
// Run
// ============================================================

export const RunStatus = z.enum(["pending", "running", "succeeded", "failed", "timeout"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunSchema = z.object({
  id: z.string(),
  integration_id: z.string(),
  version_id: z.string(),
  tenant_id: z.string(),
  status: RunStatus,
  started_at: z.string(),
  completed_at: z.string().nullable(),
  duration_ms: z.number().nullable(),
  exit_code: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  output_payload: z.string().nullable(),
  egress_calls: z.array(EgressCallSchema),
  trigger_source: z.enum(["cron", "webhook", "sftp", "manual"]),
});
export type Run = z.infer<typeof RunSchema>;

// ============================================================
// Secrets contract (Vault-shaped)
// ============================================================

export interface SecretsAPI {
  getSecret(tenantId: string, name: string): Promise<string | null>;
  setSecret(tenantId: string, name: string, value: string): Promise<void>;
  deleteSecret(tenantId: string, name: string): Promise<void>;
  listSecretNames(tenantId: string): Promise<string[]>;
}

// ============================================================
// Audit log (hash-chained, tamper-evident)
// ============================================================

export const AuditEventType = z.enum([
  "integration.created",
  "integration.generated",
  "integration.tested",
  "integration.approved",
  "integration.rejected",
  "integration.deployed",
  "integration.run",
  "integration.retired",
  "secret.read",
  "secret.written",
  "rbac.changed",
  "tenant.created",
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

export const AuditEventSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  user_id: z.string().nullable(),
  type: AuditEventType,
  payload: z.record(z.unknown()),
  hash: z.string().length(64),
  prev_hash: z.string().length(64),
  created_at: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ============================================================
// API request/response schemas (control plane)
// ============================================================

export const CreateIntegrationRequestSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(10),
  trigger: TriggerSchema,
  sample_payload: z.string().optional(),
  target_schema: z.string().optional(),
});
export type CreateIntegrationRequest = z.infer<typeof CreateIntegrationRequestSchema>;

export const ApproveIntegrationRequestSchema = z.object({
  version_id: z.string(),
});
export type ApproveIntegrationRequest = z.infer<typeof ApproveIntegrationRequestSchema>;

// ============================================================
// Constants
// ============================================================

export const TEMPORAL_TASK_QUEUE = "integration-tasks";
export const SANDBOX_BASE_IMAGE = "temper-sandbox-base:latest";

// ============================================================
// Helpers
// ============================================================

export function sha256Hex(input: string): string {
  // re-exported from crypto.subtle in browser, or node:crypto in server.
  // Consumers should use their platform's crypto. This is just a type hint.
  throw new Error("sha256Hex must be implemented per environment");
}
