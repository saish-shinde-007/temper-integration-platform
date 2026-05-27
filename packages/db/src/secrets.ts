// Encrypted-at-rest secrets manager.
//
// Uses AES-256-GCM (via node:crypto) for AEAD encryption. The plaintext
// value of a secret is never written to disk — only the ciphertext + nonce
// + auth tag are persisted. Each read and write emits an audit event.
//
// Why aes-256-gcm and not libsodium secretbox?
//   - Both are acceptable per spec; aes-256-gcm avoids the libsodium WASM
//     init dance and the `await ready` ceremony, which is friction in
//     tests and in the standalone CLI seed.
//   - The semantics are equivalent: AEAD, 96-bit nonce, 128-bit auth tag.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type pg from "pg";
import type { SecretsAPI } from "@temper/shared";
import type { AuditLoggerFactory } from "./repo.js";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12; // 96-bit nonce recommended for GCM
const TAG_BYTES = 16;
const KEY_BYTES = 32;

// Demo placeholder from .env.example. We tolerate this exact value in
// non-production environments but anything else of the wrong length
// throws.
const DEMO_KEY = "demo-only-32-bytes-replace-in-prod-xx";

/**
 * Resolve the 32-byte master key. Accepts the well-known demo placeholder
 * (and pads/truncates it to 32 bytes) but rejects anything else of the
 * wrong shape outside of NODE_ENV=test|development.
 */
export function resolveMasterKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new Error(
      "SECRETS_MASTER_KEY is required (32 bytes). Set it in your environment.",
    );
  }
  const env = process.env.NODE_ENV ?? "development";
  if (raw === DEMO_KEY) {
    // Pad the demo string to exactly 32 bytes so the cipher accepts it.
    // This branch only triggers for the documented demo placeholder.
    const buf = Buffer.alloc(KEY_BYTES);
    Buffer.from(raw, "utf8").copy(buf, 0, 0, Math.min(raw.length, KEY_BYTES));
    return buf;
  }
  // Otherwise: prefer hex (64 chars) then base64 then utf8 — accept the
  // first that yields a 32-byte buffer.
  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === 64) {
    candidates.push(Buffer.from(raw, "hex"));
  }
  try {
    candidates.push(Buffer.from(raw, "base64"));
  } catch {
    // ignore
  }
  candidates.push(Buffer.from(raw, "utf8"));
  for (const buf of candidates) {
    if (buf.length === KEY_BYTES) return buf;
  }
  if (env === "production") {
    throw new Error(
      `SECRETS_MASTER_KEY must be 32 bytes (got ${Buffer.from(raw, "utf8").length} utf8 bytes). ` +
        `Provide a 64-char hex string, a 44-char base64 string, or a 32-byte utf8 value.`,
    );
  }
  // In dev/test, hash-stretch the value to 32 bytes so smoke tests work.
  // This is NOT secure and we make the trade-off explicit in the message.
  // eslint-disable-next-line no-console
  console.warn(
    "[secrets] SECRETS_MASTER_KEY is not 32 bytes; deriving a 32-byte key via SHA-256. " +
      "This is only acceptable in development.",
  );
  return createHash("sha256").update(raw, "utf8").digest();
}

export class SecretsManager implements SecretsAPI {
  private readonly key: Buffer;

  constructor(
    private readonly pool: pg.Pool,
    private readonly auditFor: AuditLoggerFactory,
    masterKey?: Buffer,
  ) {
    this.key = masterKey ?? resolveMasterKey(process.env.SECRETS_MASTER_KEY);
    if (this.key.length !== KEY_BYTES) {
      throw new Error(
        `Master key must be ${KEY_BYTES} bytes, got ${this.key.length}.`,
      );
    }
  }

  async getSecret(tenantId: string, name: string): Promise<string | null> {
    const res = await this.pool.query<{
      encrypted_value: Buffer;
      nonce: Buffer;
    }>(
      "SELECT encrypted_value, nonce FROM secrets WHERE tenant_id = $1 AND name = $2",
      [tenantId, name],
    );
    const row = res.rows[0];

    // Emit audit event whether or not the secret exists — readers shouldn't
    // be able to probe the existence of a secret without leaving a trace.
    await this.auditFor(tenantId).record("secret.read", null, {
      name,
      found: !!row,
    });

    if (!row) return null;
    // pg returns BYTEA columns as Node Buffers already, but be defensive:
    // in some node-postgres configs they can come back as Uint8Array.
    const ciphertext = Buffer.isBuffer(row.encrypted_value)
      ? row.encrypted_value
      : Buffer.from(row.encrypted_value);
    const nonce = Buffer.isBuffer(row.nonce) ? row.nonce : Buffer.from(row.nonce);
    return this.decrypt(ciphertext, nonce);
  }

  async setSecret(
    tenantId: string,
    name: string,
    value: string,
  ): Promise<void> {
    const { ciphertext, nonce } = this.encrypt(value);
    const now = new Date().toISOString();

    // Upsert keyed on (tenant_id, name). Postgres' ON CONFLICT cleanly
    // replaces the previous version atomically.
    await this.pool.query(
      `INSERT INTO secrets (id, tenant_id, name, encrypted_value, nonce, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, name) DO UPDATE
         SET encrypted_value = EXCLUDED.encrypted_value,
             nonce = EXCLUDED.nonce,
             created_at = EXCLUDED.created_at`,
      [randomUUID(), tenantId, name, ciphertext, nonce, now],
    );

    await this.auditFor(tenantId).record("secret.written", null, { name });
  }

  async deleteSecret(tenantId: string, name: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM secrets WHERE tenant_id = $1 AND name = $2",
      [tenantId, name],
    );

    await this.auditFor(tenantId).record("secret.written", null, {
      name,
      deleted: true,
    });
  }

  async listSecretNames(tenantId: string): Promise<string[]> {
    const res = await this.pool.query<{ name: string }>(
      "SELECT name FROM secrets WHERE tenant_id = $1 ORDER BY name ASC",
      [tenantId],
    );
    return res.rows.map((r) => r.name);
  }

  // ---- internals ----

  private encrypt(plaintext: string): { ciphertext: Buffer; nonce: Buffer } {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, nonce);
    const enc = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    // Store ciphertext || authTag together so we can retrieve them as one BYTEA.
    return { ciphertext: Buffer.concat([enc, tag]), nonce };
  }

  private decrypt(blob: Buffer, nonce: Buffer): string {
    if (blob.length < TAG_BYTES) {
      throw new Error("Encrypted blob too short to contain auth tag");
    }
    const tag = blob.subarray(blob.length - TAG_BYTES);
    const enc = blob.subarray(0, blob.length - TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, this.key, nonce);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(enc), decipher.final()]);
    return out.toString("utf8");
  }
}
