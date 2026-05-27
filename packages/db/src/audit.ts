// Hash-chained, tamper-evident audit log.
//
// Each event's hash is computed over (prev_hash, type, tenant_id, user_id,
// payload, created_at). Mutating any field of any event breaks the chain
// at that point — verify() walks the chain and reports the first break.
//
// Ordering on Postgres uses the `seq BIGSERIAL` column added in schema.sql
// (SQLite's implicit rowid is gone). The chain itself remains identical:
// sha256 of the same field set, in the same order.

import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  AuditEventSchema,
  type AuditEvent,
  type AuditEventType,
} from "@temper/shared";

const GENESIS_HASH = "0".repeat(64);

interface AuditRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  type: string;
  payload_json: string;
  hash: string;
  prev_hash: string;
  created_at: string;
}

function hashEvent(parts: {
  prev_hash: string;
  type: string;
  tenant_id: string;
  user_id: string | null;
  payload_json: string;
  created_at: string;
}): string {
  const h = createHash("sha256");
  // Deterministic, ordered, length-prefixed-by-separator concatenation.
  // Separator '\x1f' (Unit Separator) is illegal in JSON / hex / uuid,
  // so no collision is possible from field contents.
  h.update(parts.prev_hash);
  h.update("\x1f");
  h.update(parts.type);
  h.update("\x1f");
  h.update(parts.tenant_id);
  h.update("\x1f");
  h.update(parts.user_id ?? "");
  h.update("\x1f");
  h.update(parts.payload_json);
  h.update("\x1f");
  h.update(parts.created_at);
  return h.digest("hex");
}

function rowToEvent(row: AuditRow): AuditEvent {
  return AuditEventSchema.parse({
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    type: row.type,
    payload: JSON.parse(row.payload_json),
    hash: row.hash,
    prev_hash: row.prev_hash,
    created_at: row.created_at,
  });
}

export class AuditLogger {
  constructor(
    private readonly pool: pg.Pool,
    private readonly tenantId: string,
  ) {}

  /**
   * Append a new audit event to this tenant's chain.
   *
   * The hash is computed from the previous event's hash (or genesis), so
   * concurrent writers in the same tenant must serialize. We use a single
   * pooled connection running a SERIALIZABLE-like flow: BEGIN, SELECT the
   * latest hash with FOR UPDATE on the tail to block concurrent appends,
   * INSERT, COMMIT. Postgres' FOR UPDATE on the tail row prevents two
   * writers from reading the same prev_hash and inserting parallel
   * branches in the chain.
   */
  async record(
    type: AuditEventType,
    userId: string | null,
    payload: Record<string, unknown>,
  ): Promise<AuditEvent> {
    const id = randomUUID();
    const created_at = new Date().toISOString();
    const payload_json = JSON.stringify(payload);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Lock the most recent audit row for this tenant to serialize
      // concurrent appends. If the chain is empty the SELECT returns no
      // rows and the FOR UPDATE has nothing to lock — that's fine, the
      // genesis branch only fires the first time per tenant.
      const prevRes = await client.query<{ hash: string }>(
        "SELECT hash FROM audit_log WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1 FOR UPDATE",
        [this.tenantId],
      );
      const prev_hash = prevRes.rows[0]?.hash ?? GENESIS_HASH;

      const hash = hashEvent({
        prev_hash,
        type,
        tenant_id: this.tenantId,
        user_id: userId,
        payload_json,
        created_at,
      });

      await client.query(
        `INSERT INTO audit_log (id, tenant_id, user_id, type, payload_json, hash, prev_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, this.tenantId, userId, type, payload_json, hash, prev_hash, created_at],
      );
      await client.query("COMMIT");

      return rowToEvent({
        id,
        tenant_id: this.tenantId,
        user_id: userId,
        type,
        payload_json,
        hash,
        prev_hash,
        created_at,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** List all audit events for this tenant in chain order. */
  async list(): Promise<AuditEvent[]> {
    const res = await this.pool.query<AuditRow>(
      "SELECT id, tenant_id, user_id, type, payload_json, hash, prev_hash, created_at " +
        "FROM audit_log WHERE tenant_id = $1 ORDER BY seq ASC",
      [this.tenantId],
    );
    return res.rows.map(rowToEvent);
  }

  /**
   * Walk the chain. Returns `{ok: true}` if every recomputed hash matches
   * the stored hash and the chain links match. Returns `{ok: false,
   * brokenAt: <event.id>}` pointing at the first event whose stored hash
   * or prev_hash disagrees with the chain.
   */
  async verify(): Promise<{ ok: true } | { ok: false; brokenAt: string }> {
    const res = await this.pool.query<AuditRow>(
      "SELECT id, tenant_id, user_id, type, payload_json, hash, prev_hash, created_at " +
        "FROM audit_log WHERE tenant_id = $1 ORDER BY seq ASC",
      [this.tenantId],
    );

    let prev_hash = GENESIS_HASH;
    for (const row of res.rows) {
      if (row.prev_hash !== prev_hash) {
        return { ok: false, brokenAt: row.id };
      }
      const expected = hashEvent({
        prev_hash,
        type: row.type,
        tenant_id: row.tenant_id,
        user_id: row.user_id,
        payload_json: row.payload_json,
        created_at: row.created_at,
      });
      if (expected !== row.hash) {
        return { ok: false, brokenAt: row.id };
      }
      prev_hash = row.hash;
    }
    return { ok: true };
  }
}
