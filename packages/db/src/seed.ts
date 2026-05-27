// Seed the demo tenant + admin user. Idempotent: re-running has no
// effect if the tenant + user already exist with the matching ids/emails.
//
// Reads:
//   DEMO_TENANT_ID    (default: "tenant-demo")
//   DEMO_TENANT_NAME  (default: "Demo Tenant")
//   DEMO_USER_EMAIL   (default: "demo@example.com")
//   DATABASE_URL      (postgres connection string)
//
// Usage:
//   tsx src/seed.ts                       # standalone CLI
//   await seedDemoTenant(await openDb())  # programmatic

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { openDb, closeDb } from "./repo.js";
import { AuditLogger } from "./audit.js";

export interface SeedResult {
  tenant: { id: string; name: string; created_at: string };
  user: { id: string; tenant_id: string; email: string; role: "admin" };
  created: { tenant: boolean; user: boolean };
}

export async function seedDemoTenant(pool: pg.Pool): Promise<SeedResult> {
  const tenantId = process.env.DEMO_TENANT_ID ?? "tenant-demo";
  const tenantName = process.env.DEMO_TENANT_NAME ?? "Demo Tenant";
  const userEmail = process.env.DEMO_USER_EMAIL ?? "demo@example.com";
  const now = new Date().toISOString();

  // ---- Tenant (idempotent on id) ----
  const tenantRes = await pool.query<{
    id: string;
    name: string;
    created_at: string;
  }>("SELECT id, name, created_at FROM tenants WHERE id = $1", [tenantId]);
  let tenant = tenantRes.rows[0];
  let tenantCreated = false;
  if (!tenant) {
    // ON CONFLICT DO NOTHING handles the race where two seeders fire in
    // parallel on a fresh DB — only one INSERT wins, and the loser falls
    // back to the SELECT below.
    await pool.query(
      "INSERT INTO tenants (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
      [tenantId, tenantName, now],
    );
    const after = await pool.query<{
      id: string;
      name: string;
      created_at: string;
    }>("SELECT id, name, created_at FROM tenants WHERE id = $1", [tenantId]);
    tenant = after.rows[0];
    // tenantCreated is true only if we were the writer that won the race
    // (i.e. the row's created_at matches our `now`). Good enough for the
    // audit guard below; worst case we emit one extra "tenant.created"
    // event on a parallel seed, which is harmless.
    tenantCreated = tenant?.created_at === now;
  }

  if (!tenant) {
    throw new Error(`Failed to upsert tenant ${tenantId}`);
  }

  // ---- User (idempotent on tenant + email) ----
  const userRes = await pool.query<{
    id: string;
    tenant_id: string;
    email: string;
    role: "admin";
    created_at: string;
  }>(
    "SELECT id, tenant_id, email, role, created_at FROM users WHERE tenant_id = $1 AND email = $2",
    [tenantId, userEmail],
  );
  let user = userRes.rows[0];
  let userCreated = false;
  if (!user) {
    const userId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, email, role, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, email) DO NOTHING`,
      [userId, tenantId, userEmail, "admin", now],
    );
    const after = await pool.query<{
      id: string;
      tenant_id: string;
      email: string;
      role: "admin";
      created_at: string;
    }>(
      "SELECT id, tenant_id, email, role, created_at FROM users WHERE tenant_id = $1 AND email = $2",
      [tenantId, userEmail],
    );
    user = after.rows[0];
    userCreated = user?.created_at === now;
  }

  if (!user) {
    throw new Error(
      `Failed to upsert user ${userEmail} for tenant ${tenantId}`,
    );
  }

  // Audit the creation only when we actually created something — otherwise
  // every restart of the API would add a noise event to the chain.
  if (tenantCreated) {
    const audit = new AuditLogger(pool, tenantId);
    await audit.record("tenant.created", user.id, {
      tenant_id: tenantId,
      tenant_name: tenantName,
    });
  }

  return {
    tenant,
    user,
    created: { tenant: tenantCreated, user: userCreated },
  };
}

// CLI entrypoint: `tsx src/seed.ts` or `pnpm seed`
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/seed.ts") ||
  process.argv[1]?.endsWith("/seed.js");

if (isMainModule) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // eslint-disable-next-line no-console
    console.error("DATABASE_URL is required to run the seed CLI.");
    process.exit(1);
  }
  (async () => {
    const pool = await openDb(url);
    try {
      const res = await seedDemoTenant(pool);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Seed failed:", err);
      process.exitCode = 1;
    } finally {
      await closeDb(pool);
    }
  })();
}
