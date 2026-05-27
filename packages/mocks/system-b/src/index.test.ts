// Minimal smoke test for mock-system-b.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "./index.js";

test("GET /health returns ok", async () => {
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok" });
  await app.close();
});

test("POST /orders appends and GET /received returns the entries", async () => {
  const app = buildServer();
  // Clean slate, since module state persists across tests in the same process.
  await app.inject({ method: "POST", url: "/reset" });

  const payload1 = { id: "ord_1", customer: "Acme", amount: 12.34 };
  const payload2 = { batch: [1, 2, 3] };

  const r1 = await app.inject({
    method: "POST",
    url: "/orders",
    payload: payload1,
  });
  assert.equal(r1.statusCode, 200);
  assert.deepEqual(r1.json(), { ok: true, count: 1 });

  const r2 = await app.inject({
    method: "POST",
    url: "/orders",
    payload: payload2,
  });
  assert.equal(r2.statusCode, 200);
  assert.deepEqual(r2.json(), { ok: true, count: 2 });

  const list = await app.inject({ method: "GET", url: "/received" });
  assert.equal(list.statusCode, 200);
  const entries = list.json() as Array<{ received_at: string; body: unknown }>;
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0]!.body, payload1);
  assert.deepEqual(entries[1]!.body, payload2);
  assert.ok(typeof entries[0]!.received_at === "string");

  await app.close();
});

test("POST /reset clears received", async () => {
  const app = buildServer();
  await app.inject({ method: "POST", url: "/orders", payload: { x: 1 } });
  const res = await app.inject({ method: "POST", url: "/reset" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, count: 0 });
  const list = await app.inject({ method: "GET", url: "/received" });
  assert.deepEqual(list.json(), []);
  await app.close();
});
