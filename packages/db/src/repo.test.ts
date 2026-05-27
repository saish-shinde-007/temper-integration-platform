// Repo smoke tests + the critical multi-tenant isolation proof.
//
// Run with: pnpm test  (which runs `node --import tsx --test src/*.test.ts`)
//
// These tests now talk to Postgres. They expect `TEST_DATABASE_URL` (or
// `DATABASE_URL`) to point at a writable Postgres database; each test
// makes its own pool, applies the schema, and tears down at the end.
//
// The isolation test is the most important assertion in this package:
// even if tenant B's Repo is handed an integration id that genuinely
// belongs to tenant A, getIntegration() must return null and any update
// must throw.

import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb, Repo, createTenant, createUser } from "./repo.js";

const CONNECTION_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Skip the whole suite if no Postgres is available — better than a noisy
// failure on a developer machine that hasn't started one.
const skipAll = !CONNECTION_URL;

async function setup() {
  if (!CONNECTION_URL) {
    throw new Error("setup() called without a connection URL");
  }
  const pool = await openDb(CONNECTION_URL);
  const tenantA = await createTenant(pool, { name: "Tenant A" });
  const tenantB = await createTenant(pool, { name: "Tenant B" });
  await createUser(pool, {
    tenantId: tenantA.id,
    email: "alice@a.example",
    role: "admin",
  });
  await createUser(pool, {
    tenantId: tenantB.id,
    email: "bob@b.example",
    role: "admin",
  });
  return {
    pool,
    tenantA,
    tenantB,
    repoA: new Repo(pool, tenantA.id),
    repoB: new Repo(pool, tenantB.id),
    teardown: async () => {
      // Best-effort cleanup so successive runs against a shared DB don't
      // accumulate rows. Cascades through users/integrations/etc.
      await pool.query("DELETE FROM tenants WHERE id IN ($1, $2)", [
        tenantA.id,
        tenantB.id,
      ]);
      await closeDb(pool);
    },
  };
}

test("Repo: createIntegration persists and returns a Draft integration", { skip: skipAll }, async () => {
  const { repoA, teardown } = await setup();
  try {
    const integ = await repoA.createIntegration({
      name: "Order sync",
      description: "Sync orders from System A to System B nightly.",
      trigger: { type: "cron", expression: "0 2 * * *" },
    });
    assert.equal(integ.name, "Order sync");
    assert.equal(integ.state, "Draft");
    assert.equal(integ.current_version_id, null);
    assert.equal(integ.trigger.type, "cron");
  } finally {
    await teardown();
  }
});

test("Repo: getIntegration round-trips", { skip: skipAll }, async () => {
  const { repoA, teardown } = await setup();
  try {
    const created = await repoA.createIntegration({
      name: "Webhook handler",
      description: "Handle inbound webhooks from System B.",
      trigger: { type: "webhook", path: "/hooks/b" },
    });
    const fetched = await repoA.getIntegration(created.id);
    assert.ok(fetched);
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.name, "Webhook handler");
    assert.equal(fetched.trigger.type, "webhook");
  } finally {
    await teardown();
  }
});

test("Repo: listIntegrations returns only this tenant's rows", { skip: skipAll }, async () => {
  const { repoA, repoB, teardown } = await setup();
  try {
    await repoA.createIntegration({
      name: "A-1",
      description: "Tenant A first integration here.",
      trigger: { type: "cron", expression: "* * * * *" },
    });
    await repoA.createIntegration({
      name: "A-2",
      description: "Tenant A second integration here.",
      trigger: { type: "cron", expression: "* * * * *" },
    });
    await repoB.createIntegration({
      name: "B-1",
      description: "Tenant B first integration here.",
      trigger: { type: "cron", expression: "* * * * *" },
    });

    const listA = await repoA.listIntegrations();
    const listB = await repoB.listIntegrations();
    assert.equal(listA.length, 2);
    assert.equal(listB.length, 1);
    assert.equal(listB[0]!.name, "B-1");
    assert.ok(listA.every((i) => i.tenant_id !== listB[0]!.tenant_id));
  } finally {
    await teardown();
  }
});

test("Repo: updateIntegrationState changes state and updated_at", { skip: skipAll }, async () => {
  const { repoA, teardown } = await setup();
  try {
    const created = await repoA.createIntegration({
      name: "State test",
      description: "Testing the state machine transitions here.",
      trigger: { type: "cron", expression: "* * * * *" },
    });
    // Tiny wait so the ISO timestamps differ.
    await new Promise((r) => setTimeout(r, 5));
    await repoA.updateIntegrationState(created.id, "Approved");
    const after = await repoA.getIntegration(created.id);
    assert.ok(after);
    assert.equal(after.state, "Approved");
    assert.notEqual(after.updated_at, created.updated_at);
  } finally {
    await teardown();
  }
});

test("Repo: createIntegrationVersion + listVersionsForIntegration", { skip: skipAll }, async () => {
  const { repoA, teardown } = await setup();
  try {
    const integ = await repoA.createIntegration({
      name: "Versioned",
      description: "Integration that we will version multiple times.",
      trigger: { type: "cron", expression: "* * * * *" },
    });
    const v1 = await repoA.createIntegrationVersion(integ.id, {
      sha256: "a".repeat(64),
      source_code: "export default async () => {}",
      declared_endpoints: ["https://api.example.com"],
      declared_secrets: ["API_KEY"],
    });
    const v2 = await repoA.createIntegrationVersion(integ.id, {
      sha256: "b".repeat(64),
      source_code: "export default async () => { return 2; }",
      declared_endpoints: ["https://api.example.com"],
      declared_secrets: [],
    });

    const versions = await repoA.listVersionsForIntegration(integ.id);
    assert.equal(versions.length, 2);
    const ids = versions.map((v) => v.id).sort();
    assert.deepEqual(ids, [v1.id, v2.id].sort());
  } finally {
    await teardown();
  }
});

test("Repo: createRun + updateRun + listRunsForIntegration", { skip: skipAll }, async () => {
  const { repoA, teardown } = await setup();
  try {
    const integ = await repoA.createIntegration({
      name: "Runnable",
      description: "Integration we will actually execute runs against now.",
      trigger: { type: "cron", expression: "* * * * *" },
    });
    const v = await repoA.createIntegrationVersion(integ.id, {
      sha256: "c".repeat(64),
      source_code: "export default async () => {}",
      declared_endpoints: [],
      declared_secrets: [],
    });
    const run = await repoA.createRun({
      integration_id: integ.id,
      version_id: v.id,
      trigger_source: "manual",
    });
    assert.equal(run.status, "pending");

    await repoA.updateRun(run.id, {
      status: "running",
    });
    await repoA.updateRun(run.id, {
      status: "succeeded",
      completed_at: new Date().toISOString(),
      duration_ms: 1234,
      exit_code: 0,
      stdout: "ok\n",
      stderr: "",
      output_payload: JSON.stringify({ rows: 5 }),
      egress_calls: [
        {
          timestamp: new Date().toISOString(),
          method: "GET",
          url: "https://api.example.com/orders",
          status_code: 200,
          blocked: false,
        },
      ],
    });

    const fetched = await repoA.getRun(run.id);
    assert.ok(fetched);
    assert.equal(fetched.status, "succeeded");
    assert.equal(fetched.duration_ms, 1234);
    assert.equal(fetched.egress_calls.length, 1);

    const list = await repoA.listRunsForIntegration(integ.id);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, run.id);
  } finally {
    await teardown();
  }
});

// =============================================================
// CRITICAL: tenant isolation
// =============================================================
test("CRITICAL: tenant A cannot read tenant B's integration even with the correct id", { skip: skipAll }, async () => {
  const { repoA, repoB, teardown } = await setup();
  try {
    const bIntegration = await repoB.createIntegration({
      name: "B's secret integration",
      description: "Tenant B's confidential integration definition here.",
      trigger: { type: "cron", expression: "0 0 * * *" },
    });

    // Tenant A holds the *exact* id of tenant B's integration. Still nothing.
    const stolen = await repoA.getIntegration(bIntegration.id);
    assert.equal(stolen, null, "Tenant A must not see Tenant B's integration");

    // Listing returns nothing for tenant A.
    const listA = await repoA.listIntegrations();
    assert.equal(listA.length, 0, "Tenant A must see no integrations");

    // Mutating it from tenant A must throw.
    await assert.rejects(
      () => repoA.updateIntegrationState(bIntegration.id, "Approved"),
      /not found in tenant/,
      "Tenant A must not be able to update Tenant B's integration state",
    );

    // Attaching a version from tenant A must throw.
    await assert.rejects(
      () =>
        repoA.createIntegrationVersion(bIntegration.id, {
          sha256: "d".repeat(64),
          source_code: "evil",
          declared_endpoints: [],
          declared_secrets: [],
        }),
      /not found in tenant/,
      "Tenant A must not be able to attach versions to Tenant B's integration",
    );

    // Listing versions from tenant A must be empty.
    const versionsFromA = await repoA.listVersionsForIntegration(
      bIntegration.id,
    );
    assert.deepEqual(
      versionsFromA,
      [],
      "Tenant A must not see Tenant B's versions",
    );

    // Creating a run for B's integration from tenant A must throw.
    await assert.rejects(
      () =>
        repoA.createRun({
          integration_id: bIntegration.id,
          version_id: "anything",
          trigger_source: "manual",
        }),
      /not found in tenant/,
      "Tenant A must not be able to create runs against Tenant B's integration",
    );

    // Sanity check: tenant B still sees its own integration unscathed.
    const bView = await repoB.getIntegration(bIntegration.id);
    assert.ok(bView, "Tenant B must still see its own integration");
    assert.equal(bView.state, "Draft");
  } finally {
    await teardown();
  }
});

test("Tenant isolation: runs created in tenant B are invisible from tenant A", { skip: skipAll }, async () => {
  const { repoA, repoB, teardown } = await setup();
  try {
    const bIntegration = await repoB.createIntegration({
      name: "B-runs",
      description: "Tenant B integration that will have some runs created.",
      trigger: { type: "cron", expression: "* * * * *" },
    });
    const v = await repoB.createIntegrationVersion(bIntegration.id, {
      sha256: "e".repeat(64),
      source_code: "",
      declared_endpoints: [],
      declared_secrets: [],
    });
    const run = await repoB.createRun({
      integration_id: bIntegration.id,
      version_id: v.id,
      trigger_source: "manual",
    });

    assert.equal(await repoA.getRun(run.id), null);
    assert.deepEqual(
      await repoA.listRunsForIntegration(bIntegration.id),
      [],
      "Tenant A must not see Tenant B's runs",
    );

    // Tenant A trying to mutate B's run throws.
    await assert.rejects(
      () => repoA.updateRun(run.id, { status: "failed" }),
      /not found in tenant/,
    );
  } finally {
    await teardown();
  }
});

test("Repo: constructor rejects empty tenantId", { skip: skipAll }, async () => {
  if (!CONNECTION_URL) return;
  const pool = await openDb(CONNECTION_URL);
  try {
    assert.throws(() => new Repo(pool, ""), /non-empty tenantId/);
  } finally {
    await closeDb(pool);
  }
});
