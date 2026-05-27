// Smoke tests for the runner. These don't exercise the actual sandbox
// (that would require Docker); they verify the wiring: that the scheduler
// adds/removes cron tasks based on integration state, and that the sync
// loop reconciles registrations against the DB.
//
// We construct a "stub" SandboxExecutor that fulfils the type contract
// without ever touching Docker. None of these tests fire the integration
// — the cron expressions used here would not tick within the test
// runtime even if we let them. We use register/deregister/currentIds as
// the observable surface.
//
// Skipped unless TEST_DATABASE_URL / DATABASE_URL is set to a writable
// Postgres database.

import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb, Repo, createTenant } from "@temper/db";
import type {
  SandboxRequest,
  SandboxResult,
  Integration,
} from "@temper/shared";
import { startScheduler } from "./scheduler.js";
import { startSyncLoop } from "./sync.js";
import type { SftpWatcher } from "./sftp-watcher.js";

const CONNECTION_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skipAll = !CONNECTION_URL;

// Stub sandbox — never invoked in these tests, but satisfies the type.
const stubSandbox = {
  run: async (_req: SandboxRequest): Promise<SandboxResult> => ({
    status: "succeeded",
    stdout: "",
    stderr: "",
    exit_code: 0,
    duration_ms: 0,
    egress_calls: [],
    source_sha256: "0".repeat(64),
    output_payload: null,
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const stubSftpWatcher: SftpWatcher = {
  stop() {},
  tick: async () => {},
  currentIds: () => [],
};

async function setupDb() {
  if (!CONNECTION_URL) {
    throw new Error("setupDb() called without a connection URL");
  }
  const pool = await openDb(CONNECTION_URL);
  // Random tenant id per test so parallel runs don't collide.
  const tenantId = `tenant-test-${crypto.randomUUID()}`;
  const tenant = await createTenant(pool, { id: tenantId, name: "Test" });
  return {
    pool,
    tenant,
    teardown: async () => {
      await pool.query("DELETE FROM tenants WHERE id = $1", [tenant.id]);
      await closeDb(pool);
    },
  };
}

async function seedDeployedCron(
  pool: import("pg").Pool,
  tenantId: string,
  expression = "0 2 * * *",
): Promise<Integration> {
  const repo = new Repo(pool, tenantId);
  const integ = await repo.createIntegration({
    name: "Smoke cron",
    description: "Smoke test cron integration",
    trigger: { type: "cron", expression },
  });
  const version = await repo.createIntegrationVersion(integ.id, {
    sha256: "a".repeat(64),
    source_code: "console.log('noop');",
    declared_endpoints: [],
    declared_secrets: [],
  });
  await repo.setCurrentVersion(integ.id, version.id);
  await repo.updateIntegrationState(integ.id, "Deployed");
  // Re-fetch so we have the updated state.
  const refreshed = await repo.getIntegration(integ.id);
  if (!refreshed) throw new Error("seedDeployedCron: integration disappeared");
  return refreshed;
}

test("scheduler: register adds a cron task, deregister removes it", { skip: skipAll }, async () => {
  const { pool, tenant, teardown } = await setupDb();
  try {
    const integration = await seedDeployedCron(pool, tenant.id);

    const scheduler = startScheduler({ pool, sandbox: stubSandbox });

    scheduler.register(integration);
    assert.deepEqual(scheduler.currentIds(), [integration.id]);

    // Idempotent: re-registering the same integration should not double-add.
    scheduler.register(integration);
    assert.equal(scheduler.currentIds().length, 1);

    scheduler.deregister(integration.id);
    assert.deepEqual(scheduler.currentIds(), []);

    scheduler.stopAll();
  } finally {
    await teardown();
  }
});

test("scheduler: skips non-cron triggers and invalid expressions", { skip: skipAll }, async () => {
  const { pool, tenant, teardown } = await setupDb();
  try {
    const repo = new Repo(pool, tenant.id);

    const webhook = await repo.createIntegration({
      name: "Webhook",
      description: "Webhook integration that should not be cron-registered",
      trigger: { type: "webhook", path: "/hooks/x" },
    });

    const scheduler = startScheduler({ pool, sandbox: stubSandbox });
    scheduler.register(webhook);
    assert.deepEqual(
      scheduler.currentIds(),
      [],
      "webhook trigger should not register",
    );

    // Invalid expression: cron.validate rejects it, scheduler logs + skips.
    const bad: Integration = {
      ...webhook,
      trigger: { type: "cron", expression: "this is not a cron" },
    };
    scheduler.register(bad);
    assert.deepEqual(
      scheduler.currentIds(),
      [],
      "invalid cron expression should not register",
    );

    scheduler.stopAll();
  } finally {
    await teardown();
  }
});

test("sync loop: reconciles cron registrations against the DB", { skip: skipAll }, async () => {
  const { pool, tenant, teardown } = await setupDb();
  try {
    const integration = await seedDeployedCron(pool, tenant.id);

    const scheduler = startScheduler({ pool, sandbox: stubSandbox });
    const sync = startSyncLoop({
      pool,
      sandbox: stubSandbox,
      scheduler,
      sftpWatcher: stubSftpWatcher,
    });

    // The initial reconcile in startSyncLoop is fire-and-forget; give it a
    // beat to land.
    await new Promise((r) => setTimeout(r, 50));
    await sync.reconcile();
    assert.deepEqual(scheduler.currentIds(), [integration.id]);

    // Retire the integration and reconcile — registration should drop.
    const repo = new Repo(pool, tenant.id);
    await repo.updateIntegrationState(integration.id, "Retired");
    await sync.reconcile();
    assert.deepEqual(scheduler.currentIds(), []);

    // Re-deploy and reconcile — registration should reappear.
    await repo.updateIntegrationState(integration.id, "Deployed");
    await sync.reconcile();
    assert.deepEqual(scheduler.currentIds(), [integration.id]);

    sync.stop();
    scheduler.stopAll();
  } finally {
    await teardown();
  }
});

test("sync loop: covers Running and Degraded states as firable", { skip: skipAll }, async () => {
  const { pool, tenant, teardown } = await setupDb();
  try {
    const integration = await seedDeployedCron(pool, tenant.id);
    const repo = new Repo(pool, tenant.id);

    const scheduler = startScheduler({ pool, sandbox: stubSandbox });
    const sync = startSyncLoop({
      pool,
      sandbox: stubSandbox,
      scheduler,
      sftpWatcher: stubSftpWatcher,
    });

    for (const state of ["Running", "Degraded"] as const) {
      await repo.updateIntegrationState(integration.id, state);
      await sync.reconcile();
      assert.deepEqual(
        scheduler.currentIds(),
        [integration.id],
        `expected ${state} integration to remain registered`,
      );
    }

    // Draft / Approved / Building should not be registered.
    for (const state of ["Draft", "Approved", "Building", "Retired"] as const) {
      await repo.updateIntegrationState(integration.id, state);
      await sync.reconcile();
      assert.deepEqual(
        scheduler.currentIds(),
        [],
        `expected ${state} integration to be deregistered`,
      );
    }

    sync.stop();
    scheduler.stopAll();
  } finally {
    await teardown();
  }
});
