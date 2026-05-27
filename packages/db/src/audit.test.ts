// Audit-log hash-chain tests.
//
// 1. Happy path: record N events, verify() returns ok:true.
// 2. Tamper proof: directly UPDATE one event's payload via SQL, verify()
//    returns ok:false with brokenAt pointing at that event.
// 3. Tampering with prev_hash (chain break) is also detected.
// 4. Tenant isolation: chains for different tenants are independent.
//
// Skipped unless TEST_DATABASE_URL / DATABASE_URL is set to a writable
// Postgres database.

import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb, createTenant } from "./repo.js";
import { AuditLogger } from "./audit.js";

const CONNECTION_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skipAll = !CONNECTION_URL;

async function setupTenant(name: string) {
  if (!CONNECTION_URL) {
    throw new Error("setupTenant() called without a connection URL");
  }
  const pool = await openDb(CONNECTION_URL);
  const t = await createTenant(pool, { name });
  return {
    pool,
    tenantId: t.id,
    audit: new AuditLogger(pool, t.id),
    teardown: async () => {
      await pool.query("DELETE FROM tenants WHERE id = $1", [t.id]);
      await closeDb(pool);
    },
  };
}

test("AuditLogger: records N events and verify() reports ok", { skip: skipAll }, async () => {
  const { audit, teardown } = await setupTenant("HappyPath");
  try {
    const events = [];
    for (let i = 0; i < 5; i++) {
      events.push(
        await audit.record("integration.created", null, {
          seq: i,
          name: `event-${i}`,
        }),
      );
    }

    const listed = await audit.list();
    assert.equal(listed.length, 5);
    // Chain: each event's prev_hash equals the previous event's hash;
    // first event has prev_hash = "0"*64.
    assert.equal(listed[0]!.prev_hash, "0".repeat(64));
    for (let i = 1; i < listed.length; i++) {
      assert.equal(listed[i]!.prev_hash, listed[i - 1]!.hash);
    }

    const result = await audit.verify();
    assert.deepEqual(result, { ok: true });
  } finally {
    await teardown();
  }
});

test("AuditLogger: mutating an event's payload via SQL breaks the chain at that event", { skip: skipAll }, async () => {
  const { pool, audit, teardown } = await setupTenant("Tamper");
  try {
    const recorded = [];
    for (let i = 0; i < 5; i++) {
      recorded.push(
        await audit.record("integration.created", null, {
          seq: i,
          name: `e-${i}`,
        }),
      );
    }

    // Before tampering: chain is intact.
    assert.deepEqual(await audit.verify(), { ok: true });

    // Tamper with event 3 (index 2). We change its payload_json directly,
    // bypassing the AuditLogger.record path. The stored hash now no longer
    // matches the recomputed hash for that event.
    const target = recorded[2]!;
    const tampered = JSON.stringify({ seq: 2, name: "e-2", tampered: true });
    await pool.query("UPDATE audit_log SET payload_json = $1 WHERE id = $2", [
      tampered,
      target.id,
    ]);

    const result = await audit.verify();
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.equal(
        result.brokenAt,
        target.id,
        "verify must point at the tampered event",
      );
    }
  } finally {
    await teardown();
  }
});

test("AuditLogger: mutating an event's prev_hash breaks the chain at that event", { skip: skipAll }, async () => {
  const { pool, audit, teardown } = await setupTenant("ChainBreak");
  try {
    const recorded = [];
    for (let i = 0; i < 4; i++) {
      recorded.push(await audit.record("integration.run", null, { i }));
    }
    assert.deepEqual(await audit.verify(), { ok: true });

    // Sever the chain at event index 2 by overwriting prev_hash with a
    // bogus value. Even though the stored hash would still recompute given
    // that bogus prev_hash, the chain LINK (prev_hash != previous.hash) is
    // what breaks first — verify() must catch that.
    const target = recorded[2]!;
    await pool.query("UPDATE audit_log SET prev_hash = $1 WHERE id = $2", [
      "f".repeat(64),
      target.id,
    ]);

    const result = await audit.verify();
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.equal(result.brokenAt, target.id);
    }
  } finally {
    await teardown();
  }
});

test("AuditLogger: chains are isolated per tenant", { skip: skipAll }, async () => {
  if (!CONNECTION_URL) return;
  // Two tenants in the same DB; tampering with A's chain must not affect
  // B's verify() result.
  const pool = await openDb(CONNECTION_URL);
  try {
    const tA = await createTenant(pool, { name: "AuditA" });
    const tB = await createTenant(pool, { name: "AuditB" });
    const auditA = new AuditLogger(pool, tA.id);
    const auditB = new AuditLogger(pool, tB.id);

    const eventsA = [];
    for (let i = 0; i < 3; i++) {
      eventsA.push(await auditA.record("integration.created", null, { i }));
    }
    for (let i = 0; i < 3; i++) {
      await auditB.record("integration.created", null, { i });
    }

    // Tamper with A only.
    await pool.query("UPDATE audit_log SET payload_json = $1 WHERE id = $2", [
      "{}",
      eventsA[1]!.id,
    ]);

    const aResult = await auditA.verify();
    const bResult = await auditB.verify();
    assert.equal(aResult.ok, false);
    assert.deepEqual(bResult, { ok: true });

    await pool.query("DELETE FROM tenants WHERE id IN ($1, $2)", [
      tA.id,
      tB.id,
    ]);
  } finally {
    await closeDb(pool);
  }
});
