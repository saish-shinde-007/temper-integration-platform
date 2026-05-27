// Smoke tests for the control plane HTTP surface.
//
// Uses fastify.inject() so we never bind to a port. Each test gets a
// fresh tenant in a shared Postgres database; the suite is skipped when
// no TEST_DATABASE_URL / DATABASE_URL is configured.
//
// Run with: pnpm --filter @temper/api test

import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb, createTenant } from "@temper/db";
import { buildApp } from "./index.js";

const CONNECTION_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skipAll = !CONNECTION_URL;

async function setup(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  tenantA: string;
  tenantB: string;
  close: () => Promise<void>;
}> {
  if (!CONNECTION_URL) {
    throw new Error("setup() called without a connection URL");
  }
  const pool = await openDb(CONNECTION_URL);
  const tenantA = (await createTenant(pool, { name: "Tenant A" })).id;
  const tenantB = (await createTenant(pool, { name: "Tenant B" })).id;
  const app = await buildApp({ db: pool, logger: false });
  return {
    app,
    tenantA,
    tenantB,
    close: async () => {
      await app.close();
      await pool.query("DELETE FROM tenants WHERE id IN ($1, $2)", [
        tenantA,
        tenantB,
      ]);
      await closeDb(pool);
    },
  };
}

const sampleBody = {
  name: "Order sync",
  description: "Sync orders from System A to System B nightly.",
  trigger: { type: "cron", expression: "0 2 * * *" },
};

test("GET /v1/healthz returns ok without a tenant", { skip: skipAll }, async () => {
  const { app, close } = await setup();
  try {
    const res = await app.inject({ method: "GET", url: "/v1/healthz" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  } finally {
    await close();
  }
});

test("Missing X-Tenant-Id returns 401", { skip: skipAll }, async () => {
  const { app, close } = await setup();
  try {
    delete process.env.DEMO_TENANT_ID;
    const res = await app.inject({ method: "GET", url: "/v1/integrations" });
    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error, "missing_tenant");
  } finally {
    await close();
  }
});

test("POST /v1/integrations creates and returns the Integration", { skip: skipAll }, async () => {
  const { app, tenantA, close } = await setup();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/v1/integrations",
      headers: { "x-tenant-id": tenantA, "content-type": "application/json" },
      payload: sampleBody,
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.name, "Order sync");
    assert.equal(body.state, "Draft");
    assert.equal(body.tenant_id, tenantA);
    assert.equal(body.trigger.type, "cron");
  } finally {
    await close();
  }
});

test("POST /v1/integrations with invalid body returns 400", { skip: skipAll }, async () => {
  const { app, tenantA, close } = await setup();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/v1/integrations",
      headers: { "x-tenant-id": tenantA, "content-type": "application/json" },
      payload: { name: "x", description: "short", trigger: { type: "cron", expression: "* * * * *" } },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error, "validation_failed");
  } finally {
    await close();
  }
});

test("GET /v1/integrations returns the created integration for the same tenant", { skip: skipAll }, async () => {
  const { app, tenantA, close } = await setup();
  try {
    const create = await app.inject({
      method: "POST",
      url: "/v1/integrations",
      headers: { "x-tenant-id": tenantA, "content-type": "application/json" },
      payload: sampleBody,
    });
    const created = create.json();

    const list = await app.inject({
      method: "GET",
      url: "/v1/integrations",
      headers: { "x-tenant-id": tenantA },
    });
    assert.equal(list.statusCode, 200);
    const rows = list.json();
    assert.equal(Array.isArray(rows), true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, created.id);
  } finally {
    await close();
  }
});

test("GET /v1/integrations/:id on a non-existent id returns 404", { skip: skipAll }, async () => {
  const { app, tenantA, close } = await setup();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/v1/integrations/does-not-exist",
      headers: { "x-tenant-id": tenantA },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await close();
  }
});

test("CRITICAL: tenant isolation — created with A, invisible to B", { skip: skipAll }, async () => {
  const { app, tenantA, tenantB, close } = await setup();
  try {
    const create = await app.inject({
      method: "POST",
      url: "/v1/integrations",
      headers: { "x-tenant-id": tenantA, "content-type": "application/json" },
      payload: sampleBody,
    });
    assert.equal(create.statusCode, 201);
    const created = create.json();

    // Tenant B holds the exact id — still 404.
    const stolen = await app.inject({
      method: "GET",
      url: `/v1/integrations/${created.id}`,
      headers: { "x-tenant-id": tenantB },
    });
    assert.equal(stolen.statusCode, 404, "Tenant B must not see A's integration");

    // Tenant B's list is empty.
    const listB = await app.inject({
      method: "GET",
      url: "/v1/integrations",
      headers: { "x-tenant-id": tenantB },
    });
    assert.equal(listB.statusCode, 200);
    assert.deepEqual(listB.json(), []);

    // Tenant A still sees its own integration.
    const ownView = await app.inject({
      method: "GET",
      url: `/v1/integrations/${created.id}`,
      headers: { "x-tenant-id": tenantA },
    });
    assert.equal(ownView.statusCode, 200);
    assert.equal(ownView.json().id, created.id);
  } finally {
    await close();
  }
});

test("POST /v1/integrations/:id/test moves an integration past Draft", { skip: skipAll }, async () => {
  const { app, tenantA, close } = await setup();
  try {
    const create = await app.inject({
      method: "POST",
      url: "/v1/integrations",
      headers: { "x-tenant-id": tenantA, "content-type": "application/json" },
      payload: sampleBody,
    });
    const created = create.json();

    const testRes = await app.inject({
      method: "POST",
      url: `/v1/integrations/${created.id}/test`,
      headers: { "x-tenant-id": tenantA },
    });
    assert.equal(testRes.statusCode, 200);
    const body = testRes.json();
    assert.ok(body.workflow_id);
    assert.equal(body.integration.state, "Tested");
    assert.ok(body.integration.current_version_id);
  } finally {
    await close();
  }
});

test("Approve + Deploy walk the state machine", { skip: skipAll }, async () => {
  const { app, tenantA, close } = await setup();
  try {
    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/integrations",
        headers: { "x-tenant-id": tenantA, "content-type": "application/json" },
        payload: sampleBody,
      })
    ).json();
    const tested = (
      await app.inject({
        method: "POST",
        url: `/v1/integrations/${created.id}/test`,
        headers: { "x-tenant-id": tenantA },
      })
    ).json();
    const versionId = tested.integration.current_version_id;

    const approved = await app.inject({
      method: "POST",
      url: `/v1/integrations/${created.id}/approve`,
      headers: { "x-tenant-id": tenantA, "content-type": "application/json" },
      payload: { version_id: versionId },
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().state, "Approved");

    const deployed = await app.inject({
      method: "POST",
      url: `/v1/integrations/${created.id}/deploy`,
      headers: { "x-tenant-id": tenantA },
    });
    assert.equal(deployed.statusCode, 200);
    assert.equal(deployed.json().state, "Running");
  } finally {
    await close();
  }
});

test("GET /v1/integrations/:id/runs returns runs created by test", { skip: skipAll }, async () => {
  const { app, tenantA, close } = await setup();
  try {
    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/integrations",
        headers: { "x-tenant-id": tenantA, "content-type": "application/json" },
        payload: sampleBody,
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/v1/integrations/${created.id}/test`,
      headers: { "x-tenant-id": tenantA },
    });
    const res = await app.inject({
      method: "GET",
      url: `/v1/integrations/${created.id}/runs`,
      headers: { "x-tenant-id": tenantA },
    });
    assert.equal(res.statusCode, 200);
    const runs = res.json();
    assert.equal(Array.isArray(runs), true);
    assert.ok(runs.length >= 1);
    assert.equal(runs[0].status, "succeeded");
  } finally {
    await close();
  }
});

test("GET /v1/integrations/:id/versions returns versions after test", { skip: skipAll }, async () => {
  const { app, tenantA, close } = await setup();
  try {
    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/integrations",
        headers: { "x-tenant-id": tenantA, "content-type": "application/json" },
        payload: sampleBody,
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/v1/integrations/${created.id}/test`,
      headers: { "x-tenant-id": tenantA },
    });
    const res = await app.inject({
      method: "GET",
      url: `/v1/integrations/${created.id}/versions`,
      headers: { "x-tenant-id": tenantA },
    });
    assert.equal(res.statusCode, 200);
    const versions = res.json();
    assert.equal(Array.isArray(versions), true);
    assert.equal(versions.length, 1);
  } finally {
    await close();
  }
});

test("DEMO_TENANT_ID env var works as a fallback", { skip: skipAll }, async () => {
  const { app, tenantA, close } = await setup();
  try {
    process.env.DEMO_TENANT_ID = tenantA;
    // No X-Tenant-Id header — should still resolve via env.
    await app.inject({
      method: "POST",
      url: "/v1/integrations",
      headers: { "content-type": "application/json" },
      payload: sampleBody,
    });
    const list = await app.inject({ method: "GET", url: "/v1/integrations" });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().length, 1);
  } finally {
    delete process.env.DEMO_TENANT_ID;
    await close();
  }
});
