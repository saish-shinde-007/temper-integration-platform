-- Temper integration platform schema (PostgreSQL).
-- Every tenant-scoped table carries tenant_id and is indexed on it.
-- Hash-chained audit log lives in audit_log.
--
-- Postgres notes vs. the previous SQLite version:
--   * No PRAGMA lines (Postgres journals + enforces FKs by default).
--   * BLOB columns are now BYTEA.
--   * audit_log gains a `seq BIGSERIAL` column for stable ordering. SQLite
--     had an implicit `rowid`; Postgres has nothing equivalent so we make
--     the order explicit.

-- ============================================================
-- Tenants
-- ============================================================
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ============================================================
-- Users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer','builder','approver','admin')),
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);

-- ============================================================
-- Integrations
-- ============================================================
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  state TEXT NOT NULL,
  current_version_id TEXT,
  trigger_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_integrations_tenant_id ON integrations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_integrations_state ON integrations(tenant_id, state);

-- ============================================================
-- Integration versions
-- ============================================================
CREATE TABLE IF NOT EXISTS integration_versions (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  source_code TEXT NOT NULL,
  declared_endpoints_json TEXT NOT NULL,
  declared_secrets_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_iv_integration_id ON integration_versions(integration_id);

-- ============================================================
-- Runs
-- ============================================================
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  exit_code INTEGER,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  output_payload TEXT,
  egress_calls_json TEXT NOT NULL DEFAULT '[]',
  trigger_source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_tenant_id ON runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_runs_integration_id ON runs(integration_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(tenant_id, status);

-- ============================================================
-- Secrets (encrypted at rest)
-- ============================================================
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  encrypted_value BYTEA NOT NULL,
  nonce BYTEA NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_secrets_tenant_id ON secrets(tenant_id);

-- ============================================================
-- Audit log (hash-chained)
-- ============================================================
-- `seq BIGSERIAL` replaces SQLite's implicit rowid for stable ordering.
-- The hash chain is computed over the other fields; `seq` is purely an
-- ordering tiebreaker for events that share a created_at millisecond.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  seq BIGSERIAL NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_id ON audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_created ON audit_log(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_seq ON audit_log(tenant_id, seq);
