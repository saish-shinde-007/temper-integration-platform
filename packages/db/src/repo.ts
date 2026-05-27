// Tenant-scoped repository layer.
//
// Every method on `Repo` carries an implicit tenantId set at construction
// time, and every SQL statement filters on `tenant_id = $1`. There is no
// constructor overload that lets you bypass it; there is no method that
// returns rows without filtering. This is the foundation of multi-tenant
// isolation in Temper — the test in repo.test.ts pins it down.
//
// `openDb(connectionString)` is the single entrypoint that creates a Pool
// and applies the schema. `closeDb(pool)` is the inverse, used by tests.

import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  CreateIntegrationRequestSchema,
  IntegrationSchema,
  IntegrationVersionSchema,
  IntegrationState,
  RunStatus,
  RunSchema,
  TriggerSchema,
  EgressCallSchema,
  type Integration,
  type IntegrationVersion,
  type IntegrationState as IntegrationStateType,
  type Run,
  type RunStatus as RunStatusType,
  type Trigger,
  type EgressCall,
  type Tenant,
  type User,
  type Role,
} from "@temper/shared";
import { applySchema } from "./migrate.js";
import type { AuditLogger } from "./audit.js";

const { Pool } = pg;

// ---------- Type helpers exported for cross-module DI ----------

export type AuditLoggerFactory = (tenantId: string) => AuditLogger;

// ---------- Connection bootstrap ----------

/**
 * Open a Postgres connection pool, apply the schema if needed, and return
 * the pool. The connection string follows libpq conventions, e.g.:
 *   postgres://user:pass@host:5432/dbname
 *   postgres://temper:PASSWORD@/temper?host=/cloudsql/<connection-name>
 *
 * Falls back to process.env.DATABASE_URL when no argument is provided.
 */
export async function openDb(connectionString?: string): Promise<pg.Pool> {
  const url = connectionString ?? process.env.DATABASE_URL;
  // If no URL, fall back to standard PG* env vars (PGHOST, PGUSER, etc.)
  // — useful for Cloud SQL Unix socket where the connection string format
  // is awkward and explicit env vars are more reliable.
  let pool: pg.Pool;
  if (url && url.startsWith("postgres")) {
    pool = new Pool({ connectionString: url });
  } else if (process.env.PGHOST) {
    // Use env-var driven config (pg auto-discovers PGHOST/PGUSER/PGDATABASE/PGPASSWORD)
    pool = new Pool();
  } else if (!url) {
    throw new Error(
      "openDb: no connection string or PGHOST env var available",
    );
  } else {
    pool = new Pool({ connectionString: url });
  }
  // Apply the schema on a borrowed connection so all CREATE statements
  // run on the same backend. Release on success and on failure — pg pools
  // leak the connection silently otherwise.
  const client = await pool.connect();
  try {
    await applySchema(client);
  } finally {
    client.release();
  }
  return pool;
}

/**
 * Close the pool cleanly. Calling this from a Cloud Run shutdown handler
 * is optional — pg disconnects gracefully on process exit — but tests
 * need it to release event-loop handles between cases.
 */
export async function closeDb(pool: pg.Pool): Promise<void> {
  await pool.end();
}

// ---------- Internal row shapes ----------

interface IntegrationRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  state: string;
  current_version_id: string | null;
  trigger_json: string;
  created_at: string;
  updated_at: string;
}

interface IntegrationVersionRow {
  id: string;
  integration_id: string;
  sha256: string;
  source_code: string;
  declared_endpoints_json: string;
  declared_secrets_json: string;
  created_at: string;
}

interface RunRow {
  id: string;
  integration_id: string;
  version_id: string;
  tenant_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  output_payload: string | null;
  egress_calls_json: string;
  trigger_source: string;
}

// ---------- Row -> domain mappers ----------

function rowToIntegration(row: IntegrationRow): Integration {
  return IntegrationSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    description: row.description,
    state: row.state,
    current_version_id: row.current_version_id,
    trigger: TriggerSchema.parse(JSON.parse(row.trigger_json)),
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

function rowToVersion(row: IntegrationVersionRow): IntegrationVersion {
  return IntegrationVersionSchema.parse({
    id: row.id,
    integration_id: row.integration_id,
    sha256: row.sha256,
    source_code: row.source_code,
    declared_endpoints: JSON.parse(row.declared_endpoints_json),
    declared_secrets: JSON.parse(row.declared_secrets_json),
    created_at: row.created_at,
  });
}

function rowToRun(row: RunRow): Run {
  const egress = JSON.parse(row.egress_calls_json) as unknown[];
  return RunSchema.parse({
    id: row.id,
    integration_id: row.integration_id,
    version_id: row.version_id,
    tenant_id: row.tenant_id,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at,
    duration_ms: row.duration_ms,
    exit_code: row.exit_code,
    stdout: row.stdout,
    stderr: row.stderr,
    output_payload: row.output_payload,
    egress_calls: egress.map((c) => EgressCallSchema.parse(c)),
    trigger_source: row.trigger_source,
  });
}

// ---------- Tenant + user (admin) helpers ----------

/**
 * Bootstrap helpers that operate outside the tenant scope. The Repo
 * class below assumes the tenant already exists; use these to create it.
 * Kept as free functions to make it obvious they are NOT tenant-scoped.
 */
export async function createTenant(
  pool: pg.Pool,
  input: { id?: string; name: string },
): Promise<Tenant> {
  const id = input.id ?? randomUUID();
  const created_at = new Date().toISOString();
  await pool.query(
    "INSERT INTO tenants (id, name, created_at) VALUES ($1, $2, $3)",
    [id, input.name, created_at],
  );
  return { id, name: input.name, created_at };
}

export async function getTenant(
  pool: pg.Pool,
  id: string,
): Promise<Tenant | null> {
  const res = await pool.query<{ id: string; name: string; created_at: string }>(
    "SELECT id, name, created_at FROM tenants WHERE id = $1",
    [id],
  );
  return res.rows[0] ?? null;
}

export async function createUser(
  pool: pg.Pool,
  input: { tenantId: string; email: string; role: Role },
): Promise<User> {
  const id = randomUUID();
  const created_at = new Date().toISOString();
  await pool.query(
    "INSERT INTO users (id, tenant_id, email, role, created_at) VALUES ($1, $2, $3, $4, $5)",
    [id, input.tenantId, input.email, input.role, created_at],
  );
  return {
    id,
    tenant_id: input.tenantId,
    email: input.email,
    role: input.role,
    created_at,
  };
}

// ---------- Repo class — tenant-scoped, no escape hatch ----------

export interface CreateIntegrationInput {
  name: string;
  description: string;
  trigger: Trigger;
}

export interface CreateRunInput {
  integration_id: string;
  version_id: string;
  status?: RunStatusType;
  started_at?: string;
  trigger_source: Run["trigger_source"];
}

export interface UpdateRunPatch {
  status?: RunStatusType;
  completed_at?: string | null;
  duration_ms?: number | null;
  exit_code?: number | null;
  stdout?: string;
  stderr?: string;
  output_payload?: string | null;
  egress_calls?: EgressCall[];
}

export class Repo {
  constructor(
    private readonly pool: pg.Pool,
    private readonly tenantId: string,
  ) {
    if (!tenantId) {
      throw new Error("Repo requires a non-empty tenantId");
    }
  }

  // ---- Integrations ----

  async createIntegration(input: CreateIntegrationInput): Promise<Integration> {
    // Validate against the shared schema. We reuse the API's
    // CreateIntegrationRequestSchema for name/description/trigger validation.
    // The agent-only fields (sample_payload, target_schema) on that schema
    // are optional so we just ignore them here.
    const parsed = CreateIntegrationRequestSchema.parse({
      name: input.name,
      description: input.description,
      trigger: input.trigger,
    });

    const id = randomUUID();
    const now = new Date().toISOString();
    const trigger_json = JSON.stringify(parsed.trigger);

    await this.pool.query(
      `INSERT INTO integrations
          (id, tenant_id, name, description, state, current_version_id, trigger_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        this.tenantId,
        parsed.name,
        parsed.description,
        "Draft" satisfies IntegrationStateType,
        null,
        trigger_json,
        now,
        now,
      ],
    );

    return {
      id,
      tenant_id: this.tenantId,
      name: parsed.name,
      description: parsed.description,
      state: "Draft",
      current_version_id: null,
      trigger: parsed.trigger,
      created_at: now,
      updated_at: now,
    };
  }

  async getIntegration(id: string): Promise<Integration | null> {
    const res = await this.pool.query<IntegrationRow>(
      "SELECT * FROM integrations WHERE id = $1 AND tenant_id = $2",
      [id, this.tenantId],
    );
    return res.rows[0] ? rowToIntegration(res.rows[0]) : null;
  }

  async listIntegrations(): Promise<Integration[]> {
    const res = await this.pool.query<IntegrationRow>(
      "SELECT * FROM integrations WHERE tenant_id = $1 ORDER BY created_at DESC",
      [this.tenantId],
    );
    return res.rows.map(rowToIntegration);
  }

  async updateIntegrationState(
    id: string,
    state: IntegrationStateType,
  ): Promise<void> {
    const parsed = IntegrationState.parse(state);
    const now = new Date().toISOString();
    const result = await this.pool.query(
      "UPDATE integrations SET state = $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4",
      [parsed, now, id, this.tenantId],
    );
    if (result.rowCount === 0) {
      throw new Error(
        `Integration ${id} not found in tenant ${this.tenantId}`,
      );
    }
  }

  /**
   * Update the current version pointer. Internal-ish helper used after
   * a new version is created and the caller wants to mark it active.
   */
  async setCurrentVersion(
    integrationId: string,
    versionId: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const result = await this.pool.query(
      "UPDATE integrations SET current_version_id = $1, updated_at = $2 WHERE id = $3 AND tenant_id = $4",
      [versionId, now, integrationId, this.tenantId],
    );
    if (result.rowCount === 0) {
      throw new Error(
        `Integration ${integrationId} not found in tenant ${this.tenantId}`,
      );
    }
  }

  // ---- Integration versions ----

  async createIntegrationVersion(
    integrationId: string,
    version: Omit<IntegrationVersion, "id" | "created_at" | "integration_id">,
  ): Promise<IntegrationVersion> {
    // Guard: the integration must belong to this tenant. Without this check
    // an attacker who knew an integration_id in another tenant could
    // attach a version to it.
    const parent = await this.getIntegration(integrationId);
    if (!parent) {
      throw new Error(
        `Integration ${integrationId} not found in tenant ${this.tenantId}`,
      );
    }

    const id = randomUUID();
    const created_at = new Date().toISOString();
    const row: IntegrationVersion = {
      id,
      integration_id: integrationId,
      sha256: version.sha256,
      source_code: version.source_code,
      declared_endpoints: version.declared_endpoints,
      declared_secrets: version.declared_secrets,
      created_at,
    };
    // Validate via the shared schema before we persist.
    IntegrationVersionSchema.parse(row);

    await this.pool.query(
      `INSERT INTO integration_versions
          (id, integration_id, sha256, source_code, declared_endpoints_json, declared_secrets_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        integrationId,
        row.sha256,
        row.source_code,
        JSON.stringify(row.declared_endpoints),
        JSON.stringify(row.declared_secrets),
        created_at,
      ],
    );

    return row;
  }

  async listVersionsForIntegration(
    integrationId: string,
  ): Promise<IntegrationVersion[]> {
    // Join through integrations to enforce tenant_id; we don't trust the
    // caller-supplied integration_id alone.
    const res = await this.pool.query<IntegrationVersionRow>(
      `SELECT iv.* FROM integration_versions iv
         JOIN integrations i ON i.id = iv.integration_id
         WHERE iv.integration_id = $1 AND i.tenant_id = $2
         ORDER BY iv.created_at DESC`,
      [integrationId, this.tenantId],
    );
    return res.rows.map(rowToVersion);
  }

  async getIntegrationVersion(
    versionId: string,
  ): Promise<IntegrationVersion | null> {
    const res = await this.pool.query<IntegrationVersionRow>(
      `SELECT iv.* FROM integration_versions iv
         JOIN integrations i ON i.id = iv.integration_id
         WHERE iv.id = $1 AND i.tenant_id = $2`,
      [versionId, this.tenantId],
    );
    return res.rows[0] ? rowToVersion(res.rows[0]) : null;
  }

  // ---- Runs ----

  async createRun(input: CreateRunInput): Promise<Run> {
    // Confirm the integration belongs to this tenant before recording a run.
    const parent = await this.getIntegration(input.integration_id);
    if (!parent) {
      throw new Error(
        `Integration ${input.integration_id} not found in tenant ${this.tenantId}`,
      );
    }

    const id = randomUUID();
    const started_at = input.started_at ?? new Date().toISOString();
    const status: RunStatusType = RunStatus.parse(input.status ?? "pending");

    await this.pool.query(
      `INSERT INTO runs
          (id, integration_id, version_id, tenant_id, status, started_at,
           completed_at, duration_ms, exit_code, stdout, stderr, output_payload,
           egress_calls_json, trigger_source)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, NULL, '', '', NULL, '[]', $7)`,
      [
        id,
        input.integration_id,
        input.version_id,
        this.tenantId,
        status,
        started_at,
        input.trigger_source,
      ],
    );

    return {
      id,
      integration_id: input.integration_id,
      version_id: input.version_id,
      tenant_id: this.tenantId,
      status,
      started_at,
      completed_at: null,
      duration_ms: null,
      exit_code: null,
      stdout: "",
      stderr: "",
      output_payload: null,
      egress_calls: [],
      trigger_source: input.trigger_source,
    };
  }

  async updateRun(id: string, patch: UpdateRunPatch): Promise<void> {
    // Build a dynamic SET clause but always include `tenant_id = $N` in the
    // WHERE clause. No partial-update path bypasses tenant isolation.
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    const next = () => `$${values.length + 1}`;

    if (patch.status !== undefined) {
      const parsed = RunStatus.parse(patch.status);
      sets.push(`status = ${next()}`);
      values.push(parsed);
    }
    if (patch.completed_at !== undefined) {
      sets.push(`completed_at = ${next()}`);
      values.push(patch.completed_at);
    }
    if (patch.duration_ms !== undefined) {
      sets.push(`duration_ms = ${next()}`);
      values.push(patch.duration_ms);
    }
    if (patch.exit_code !== undefined) {
      sets.push(`exit_code = ${next()}`);
      values.push(patch.exit_code);
    }
    if (patch.stdout !== undefined) {
      sets.push(`stdout = ${next()}`);
      values.push(patch.stdout);
    }
    if (patch.stderr !== undefined) {
      sets.push(`stderr = ${next()}`);
      values.push(patch.stderr);
    }
    if (patch.output_payload !== undefined) {
      sets.push(`output_payload = ${next()}`);
      values.push(patch.output_payload);
    }
    if (patch.egress_calls !== undefined) {
      // Validate each call shape before persisting.
      const valid = patch.egress_calls.map((c) => EgressCallSchema.parse(c));
      sets.push(`egress_calls_json = ${next()}`);
      values.push(JSON.stringify(valid));
    }

    if (sets.length === 0) return; // no-op

    const idPlaceholder = next();
    values.push(id);
    const tenantPlaceholder = next();
    values.push(this.tenantId);

    const sql = `UPDATE runs SET ${sets.join(", ")} WHERE id = ${idPlaceholder} AND tenant_id = ${tenantPlaceholder}`;
    const result = await this.pool.query(sql, values);
    if (result.rowCount === 0) {
      throw new Error(`Run ${id} not found in tenant ${this.tenantId}`);
    }
  }

  async getRun(id: string): Promise<Run | null> {
    const res = await this.pool.query<RunRow>(
      "SELECT * FROM runs WHERE id = $1 AND tenant_id = $2",
      [id, this.tenantId],
    );
    return res.rows[0] ? rowToRun(res.rows[0]) : null;
  }

  async listRunsForIntegration(integrationId: string): Promise<Run[]> {
    const res = await this.pool.query<RunRow>(
      `SELECT * FROM runs WHERE integration_id = $1 AND tenant_id = $2
         ORDER BY started_at DESC`,
      [integrationId, this.tenantId],
    );
    return res.rows.map(rowToRun);
  }
}
