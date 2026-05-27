// Tenant resolution middleware.
//
// Pulls the tenant id from the X-Tenant-Id header (case-insensitive,
// Fastify lowercases all incoming headers). Falls back to
// process.env.DEMO_TENANT_ID for unauthenticated demo use. If neither is
// present, the request is rejected with 401 — no implicit cross-tenant
// access.
//
// On success, attaches:
//   req.tenantId   — string, the resolved id
//   req.repo       — a fresh Repo(pool, tenantId) for this request
//   req.audit      — a fresh AuditLogger(pool, tenantId)
//
// A fresh Repo/AuditLogger per request is cheap (just two object
// constructions over a shared pg.Pool) and keeps tenant scoping
// impossible to leak via shared mutable state.

import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { Repo, AuditLogger } from "@temper/db";

// Module augmentation so TypeScript knows about the attached fields.
declare module "fastify" {
  interface FastifyRequest {
    tenantId?: string;
    repo?: Repo;
    audit?: AuditLogger;
  }
}

export async function tenantMiddleware(
  req: FastifyRequest,
  reply: FastifyReply,
  pool: pg.Pool,
): Promise<void> {
  const headerValue = req.headers["x-tenant-id"];
  const headerTenantId = Array.isArray(headerValue)
    ? headerValue[0]
    : headerValue;
  const tenantId = headerTenantId?.trim() || process.env.DEMO_TENANT_ID;

  if (!tenantId) {
    await reply.code(401).send({
      error: "missing_tenant",
      message:
        "X-Tenant-Id header is required (or set DEMO_TENANT_ID for the demo)",
    });
    return;
  }

  req.tenantId = tenantId;
  req.repo = new Repo(pool, tenantId);
  req.audit = new AuditLogger(pool, tenantId);
}
