// Control plane entrypoint.
//
// Boots the Fastify server, wires the tenant middleware on /v1/*, mounts
// the integration + run routes, and starts listening. Tests import
// buildApp() directly so they can call fastify.inject() without binding
// to a port.

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { FastifySSEPlugin as sse } from "fastify-sse-v2";
import type pg from "pg";
import { openDb, seedDemoTenant } from "@temper/db";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerRunsRoutes } from "./routes/runs.js";
import { tenantMiddleware } from "./middleware/tenant.js";
import { errorHandler } from "./middleware/error.js";
import {
  createTemporalClient,
  StubTemporalClient,
  type TemporalClient,
} from "./temporal-client.js";

export interface BuildAppOptions {
  db: pg.Pool;
  temporal?: TemporalClient;
  logger?: boolean | object;
}

/**
 * Construct a configured Fastify instance without starting the listener.
 * Exposed so tests can inject() requests directly. Callers that own the
 * pool lifetime should pass it in (and close it themselves).
 *
 * The `db` field name is preserved for API stability (callers still pass
 * `{ db: ... }`) even though the underlying handle is a pg.Pool now.
 */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // Tests pass `logger: false` for clean output; main() uses pino-pretty.
    logger: opts.logger ?? false,
  });

  await app.register(cors, { origin: true });
  // sse-v2 is a default-exported plugin in v4+
  await app.register(sse);

  app.setErrorHandler(errorHandler);

  // Tenant middleware on /v1/* except /v1/healthz.
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/v1") && !req.url.startsWith("/v1/healthz")) {
      await tenantMiddleware(req, reply, opts.db);
    }
  });

  app.get("/v1/healthz", async () => ({ ok: true }));

  const temporal = opts.temporal ?? new StubTemporalClient(opts.db);

  registerIntegrationRoutes(app, opts.db, temporal);
  registerRunsRoutes(app, opts.db);

  return app;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = await openDb(connectionString);
  await seedDemoTenant(pool);

  const temporal = await createTemporalClient(pool);

  const app = await buildApp({
    db: pool,
    temporal,
    logger: {
      transport: { target: "pino-pretty" },
    },
  });

  const port = Number(process.env.API_PORT ?? 4000);
  const host = process.env.API_HOST ?? "0.0.0.0";
  await app.listen({ port, host });
  app.log.info({ port, host }, "Temper API listening");
}

// Run main() only when invoked as a script — keeps tests free of side
// effects when they import buildApp from this module.
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/api/src/index.ts") ||
  process.argv[1]?.endsWith("/api/dist/index.js");

if (isMainModule) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("API failed to start:", err);
    process.exit(1);
  });
}
