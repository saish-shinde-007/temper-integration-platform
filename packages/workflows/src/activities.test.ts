// Activity-level smoke tests.
//
// We exercise the activity functions directly, with an in-memory SQLite
// DB and stub agent + sandbox. This proves the happy-path wiring works:
//   - generateCode -> creates a version row + audit entry
//   - runSandbox  -> creates a Run row, persists the result
//   - buildImage  -> returns a deterministic tag
//   - deployToRunner -> flips state to Deployed and points current_version_id
//   - markFailed -> drops back to Draft + audit
//
// We do NOT spin up a Temporal test server here. TestWorkflowEnvironment
// works but pulls in the Java/test-server binary on first run and tends
// to flake on CI machines that don't have ports open. The workflow itself
// is mostly sequencing — the risk lives in the activities, and that's
// what these tests cover.

import test from "node:test";
import assert from "node:assert/strict";

import { openDb, Repo, createTenant } from "@temper/db";

// `openDb` returns a better-sqlite3 Database, but we don't want to
// pull better-sqlite3 in as a direct dep just for the type — infer
// it from the function return type instead.
type Db = ReturnType<typeof openDb>;

import {
  generateCode,
  runSandbox,
  buildImage,
  deployToRunner,
  markFailed,
  updateIntegrationState,
  setActivityDeps,
  resetActivityDeps,
} from "./activities.js";

// We point DATABASE_PATH at an in-memory DB and hand the activity a
// single shared handle by overriding openDb. Without this override, each
// activity would call `openDb(':memory:')` and get a fresh empty database.
function setupSharedInMemoryDb(): { db: Db; tenantId: string } {
  // Force-set the env var so SecretsManager (which reads SECRETS_MASTER_KEY
  // on construction) doesn't crash. The demo key is tolerated.
  process.env.SECRETS_MASTER_KEY ??= "demo-only-32-bytes-replace-in-prod-xx";
  process.env.DATABASE_PATH = ":memory:";

  const db = openDb(":memory:");
  const tenant = createTenant(db, { name: "Test Tenant" });

  // Every activity calls openDb(DB_PATH()). We override it to hand back
  // the same in-memory handle so all activities see the same data.
  setActivityDeps({
    openDb: () => db,
  });

  return { db, tenantId: tenant.id };
}

function seedIntegration(db: Db, tenantId: string) {
  const repo = new Repo(db, tenantId);
  return repo.createIntegration({
    name: "Test integration",
    description: "Sync orders from System A to System B every fifteen minutes.",
    trigger: { type: "cron", expression: "*/15 * * * *" },
  });
}

// ============================================================
// updateIntegrationState
// ============================================================

test("updateIntegrationState flips the state and persists it", async (t) => {
  const { db, tenantId } = setupSharedInMemoryDb();
  t.after(() => {
    resetActivityDeps();
    db.close();
  });
  const integ = seedIntegration(db, tenantId);

  await updateIntegrationState(
    { integrationId: integ.id, tenantId },
    "Generating",
  );

  const repo = new Repo(db, tenantId);
  const after = repo.getIntegration(integ.id);
  assert.ok(after);
  assert.equal(after.state, "Generating");
});

// ============================================================
// generateCode
// ============================================================

test("generateCode calls the agent, creates a version, and audits it", async (t) => {
  const { db, tenantId } = setupSharedInMemoryDb();
  t.after(() => {
    resetActivityDeps();
    db.close();
  });
  const integ = seedIntegration(db, tenantId);

  // Fake agent — no Anthropic call.
  setActivityDeps({
    openDb: () => db,
    makeAgent: () =>
      ({
        generateIntegrationCode: async () => ({
          source_code: "export async function run() { return { ok: true }; }",
          sha256: "a".repeat(64),
          declared_endpoints: ["https://api.system-a.example"],
          declared_secrets: ["SYSTEM_A_TOKEN"],
          language: "typescript" as const,
        }),
      }) as never,
  });

  const out = await generateCode({ integrationId: integ.id, tenantId });

  assert.match(out.versionId, /^[0-9a-f-]{36}$/i);
  assert.equal(out.sha256.length, 64);

  // Version row exists with the right contents.
  const repo = new Repo(db, tenantId);
  const versions = repo.listVersionsForIntegration(integ.id);
  assert.equal(versions.length, 1);
  assert.deepEqual(versions[0]!.declared_endpoints, [
    "https://api.system-a.example",
  ]);
  assert.deepEqual(versions[0]!.declared_secrets, ["SYSTEM_A_TOKEN"]);

  // Audit chain has the generated event.
  const auditRows = db
    .prepare("SELECT type FROM audit_log WHERE tenant_id = ?")
    .all(tenantId) as { type: string }[];
  assert.ok(
    auditRows.some((r) => r.type === "integration.generated"),
    "expected an integration.generated audit event",
  );
});

test("generateCode throws when the integration doesn't exist", async (t) => {
  const { db, tenantId } = setupSharedInMemoryDb();
  t.after(() => {
    resetActivityDeps();
    db.close();
  });
  // No integration seeded.
  setActivityDeps({
    openDb: () => db,
    makeAgent: () =>
      ({
        generateIntegrationCode: async () => ({
          source_code: "",
          sha256: "0".repeat(64),
          declared_endpoints: [],
          declared_secrets: [],
          language: "typescript" as const,
        }),
      }) as never,
  });

  await assert.rejects(
    () =>
      generateCode({
        integrationId: "nonexistent",
        tenantId,
      }),
    /not found in tenant/,
  );
});

// ============================================================
// runSandbox
// ============================================================

test("runSandbox persists a Run row and returns succeeded on happy path", async (t) => {
  const { db, tenantId } = setupSharedInMemoryDb();
  t.after(() => {
    resetActivityDeps();
    db.close();
  });

  const integ = seedIntegration(db, tenantId);
  const repo = new Repo(db, tenantId);
  const version = repo.createIntegrationVersion(integ.id, {
    sha256: "f".repeat(64),
    source_code: "export async function run() { return { ok: true }; }",
    declared_endpoints: [],
    declared_secrets: [],
  });

  // Fake sandbox — no docker.
  setActivityDeps({
    openDb: () => db,
    makeSandbox: () =>
      ({
        run: async () => ({
          status: "succeeded" as const,
          stdout: "ok\n",
          stderr: "",
          exit_code: 0,
          duration_ms: 250,
          egress_calls: [],
          source_sha256: "f".repeat(64),
          output_payload: '{"ok":true}',
        }),
      }) as never,
  });

  const out = await runSandbox({
    integrationId: integ.id,
    tenantId,
    versionId: version.id,
  });

  assert.equal(out.status, "succeeded");
  assert.match(out.runId, /^[0-9a-f-]{36}$/i);

  // Run row was persisted with the right fields.
  const run = repo.getRun(out.runId);
  assert.ok(run);
  assert.equal(run.status, "succeeded");
  assert.equal(run.duration_ms, 250);
  assert.equal(run.exit_code, 0);
  assert.equal(run.output_payload, '{"ok":true}');
});

test("runSandbox marks failed when sandbox reports a non-success status", async (t) => {
  const { db, tenantId } = setupSharedInMemoryDb();
  t.after(() => {
    resetActivityDeps();
    db.close();
  });

  const integ = seedIntegration(db, tenantId);
  const repo = new Repo(db, tenantId);
  const version = repo.createIntegrationVersion(integ.id, {
    sha256: "e".repeat(64),
    source_code: "",
    declared_endpoints: [],
    declared_secrets: [],
  });

  setActivityDeps({
    openDb: () => db,
    makeSandbox: () =>
      ({
        run: async () => ({
          status: "failed" as const,
          stdout: "",
          stderr: "boom",
          exit_code: 1,
          duration_ms: 100,
          egress_calls: [],
          source_sha256: "e".repeat(64),
          output_payload: null,
        }),
      }) as never,
  });

  const out = await runSandbox({
    integrationId: integ.id,
    tenantId,
    versionId: version.id,
  });
  assert.equal(out.status, "failed");

  const run = repo.getRun(out.runId);
  assert.ok(run);
  assert.equal(run.status, "failed");
  assert.equal(run.stderr, "boom");
});

// ============================================================
// buildImage
// ============================================================

test("buildImage returns a deterministic tag derived from the sha256", async (t) => {
  const { db, tenantId } = setupSharedInMemoryDb();
  t.after(() => {
    resetActivityDeps();
    db.close();
  });

  const integ = seedIntegration(db, tenantId);
  const repo = new Repo(db, tenantId);
  const sha = "0123456789abcdef".repeat(4); // 64 hex chars
  const version = repo.createIntegrationVersion(integ.id, {
    sha256: sha,
    source_code: "x",
    declared_endpoints: [],
    declared_secrets: [],
  });

  const out = await buildImage({
    integrationId: integ.id,
    tenantId,
    versionId: version.id,
  });

  assert.equal(out.imageTag, `temper-int-${integ.id}-${sha.slice(0, 12)}`);

  // Calling it again returns the same tag (idempotent).
  const second = await buildImage({
    integrationId: integ.id,
    tenantId,
    versionId: version.id,
  });
  assert.equal(out.imageTag, second.imageTag);
});

// ============================================================
// deployToRunner
// ============================================================

test("deployToRunner flips current_version_id and state=Deployed", async (t) => {
  const { db, tenantId } = setupSharedInMemoryDb();
  t.after(() => {
    resetActivityDeps();
    db.close();
  });

  const integ = seedIntegration(db, tenantId);
  const repo = new Repo(db, tenantId);
  const version = repo.createIntegrationVersion(integ.id, {
    sha256: "b".repeat(64),
    source_code: "",
    declared_endpoints: [],
    declared_secrets: [],
  });

  await deployToRunner({
    integrationId: integ.id,
    tenantId,
    versionId: version.id,
    imageTag: "temper-int-foo-bbbbbbbbbbbb",
  });

  const after = repo.getIntegration(integ.id);
  assert.ok(after);
  assert.equal(after.state, "Deployed");
  assert.equal(after.current_version_id, version.id);
});

// ============================================================
// markFailed
// ============================================================

test("markFailed sends the integration back to Draft and audits the cause", async (t) => {
  const { db, tenantId } = setupSharedInMemoryDb();
  t.after(() => {
    resetActivityDeps();
    db.close();
  });

  const integ = seedIntegration(db, tenantId);
  const repo = new Repo(db, tenantId);
  repo.updateIntegrationState(integ.id, "Generating");

  await markFailed(
    { integrationId: integ.id, tenantId },
    "agent gave us garbage JSON",
  );

  const after = repo.getIntegration(integ.id);
  assert.ok(after);
  assert.equal(after.state, "Draft");

  const auditRows = db
    .prepare("SELECT type, payload_json FROM audit_log WHERE tenant_id = ?")
    .all(tenantId) as { type: string; payload_json: string }[];
  const rejected = auditRows.find((r) => r.type === "integration.rejected");
  assert.ok(rejected, "expected integration.rejected audit event");
  const payload = JSON.parse(rejected.payload_json);
  assert.equal(payload.reason, "workflow_failure");
  assert.match(payload.error, /garbage JSON/);
});

// ============================================================
// End-to-end happy path
// ============================================================

test("happy path: generate -> runSandbox -> build -> deploy", async (t) => {
  const { db, tenantId } = setupSharedInMemoryDb();
  t.after(() => {
    resetActivityDeps();
    db.close();
  });

  const integ = seedIntegration(db, tenantId);

  setActivityDeps({
    openDb: () => db,
    makeAgent: () =>
      ({
        generateIntegrationCode: async () => ({
          source_code: "export async function run() { return { ok: true }; }",
          sha256: "c".repeat(64),
          declared_endpoints: ["https://api.system-a.example"],
          declared_secrets: [],
          language: "typescript" as const,
        }),
      }) as never,
    makeSandbox: () =>
      ({
        run: async () => ({
          status: "succeeded" as const,
          stdout: "ok\n",
          stderr: "",
          exit_code: 0,
          duration_ms: 100,
          egress_calls: [],
          source_sha256: "c".repeat(64),
          output_payload: '{"ok":true}',
        }),
      }) as never,
  });

  const input = { integrationId: integ.id, tenantId };

  await updateIntegrationState(input, "Generating");
  const generated = await generateCode(input);
  const sandboxResult = await runSandbox({
    ...input,
    versionId: generated.versionId,
  });
  assert.equal(sandboxResult.status, "succeeded");
  await updateIntegrationState(input, "Tested");

  // Approval happens via signal in the real workflow; simulate it here
  // by jumping straight to the post-approval activities.
  await updateIntegrationState(input, "Approved");
  await updateIntegrationState(input, "Building");
  const built = await buildImage({
    ...input,
    versionId: generated.versionId,
  });
  await deployToRunner({
    ...input,
    versionId: generated.versionId,
    imageTag: built.imageTag,
  });

  const repo = new Repo(db, tenantId);
  const final = repo.getIntegration(integ.id);
  assert.ok(final);
  assert.equal(final.state, "Deployed");
  assert.equal(final.current_version_id, generated.versionId);

  // The Run row is visible.
  const runs = repo.listRunsForIntegration(integ.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, "succeeded");
});
