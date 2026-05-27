// Minimal smoke test for mock-system-a.
// Uses Fastify's `inject` so no real socket binding is required.

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

test("GET /orders returns up to 10 orders sorted by created_at asc", async () => {
  const app = buildServer();
  const res = await app.inject({ method: "GET", url: "/orders" });
  assert.equal(res.statusCode, 200);
  const orders = res.json() as Array<{ id: string; created_at: string }>;
  assert.ok(Array.isArray(orders));
  assert.ok(orders.length > 0 && orders.length <= 10);
  for (let i = 1; i < orders.length; i++) {
    assert.ok(
      orders[i - 1]!.created_at <= orders[i]!.created_at,
      "orders must be sorted by created_at ascending",
    );
  }
  await app.close();
});

test("GET /orders?since=<cursor> only returns orders strictly newer", async () => {
  const app = buildServer();
  const first = await app.inject({ method: "GET", url: "/orders" });
  const firstBatch = first.json() as Array<{ created_at: string }>;
  if (firstBatch.length === 0) {
    await app.close();
    return;
  }
  const cursor = firstBatch[firstBatch.length - 1]!.created_at;
  const res = await app.inject({
    method: "GET",
    url: `/orders?since=${encodeURIComponent(cursor)}`,
  });
  assert.equal(res.statusCode, 200);
  const next = res.json() as Array<{ created_at: string }>;
  for (const order of next) {
    assert.ok(order.created_at > cursor, "since cursor must be exclusive");
  }
  await app.close();
});

test("POST /reset reseeds the store", async () => {
  const app = buildServer();
  const res = await app.inject({ method: "POST", url: "/reset" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; count: number };
  assert.equal(body.ok, true);
  assert.equal(body.count, 50);
  await app.close();
});
