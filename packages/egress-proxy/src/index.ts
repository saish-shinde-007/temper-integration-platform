// Egress proxy server entrypoint.
//
// Run via `pnpm dev` (tsx watch) for local dev, or `node dist/index.js` in
// the container. The sandbox network routes all outbound HTTP at this
// process; we enforce the per-execution allowlist and log every call.

import Fastify, { type FastifyInstance } from "fastify";
import type { EgressCall } from "@temper/shared";
import { ProxyStore, handleProxyRequest } from "./proxy.js";

export interface BuildServerOptions {
  store?: ProxyStore;
  // Allow tests to suppress request logging noise.
  logger?: boolean;
}

export function buildServer(opts: BuildServerOptions = {}): FastifyInstance {
  const store = opts.store ?? new ProxyStore();
  const fastify = Fastify({
    logger: opts.logger ?? false,
    // Don't try to parse bodies for the proxy route — we stream them through.
    bodyLimit: 50 * 1024 * 1024,
  });

  // Health check (handy for docker-compose `depends_on: healthcheck`).
  fastify.get("/healthz", async () => ({ ok: true, executions: store.size() }));

  // Register a new execution + its allowlist.
  fastify.post<{
    Body: { executionId?: string; allowlist?: string[]; ttl_seconds?: number };
  }>("/execution", async (req, reply) => {
    const body = req.body ?? {};
    if (typeof body.executionId !== "string" || !body.executionId) {
      reply.code(400).send({ error: "executionId is required" });
      return;
    }
    if (!Array.isArray(body.allowlist) || body.allowlist.some((h) => typeof h !== "string")) {
      reply.code(400).send({ error: "allowlist must be string[]" });
      return;
    }
    const state = store.register(body.executionId, body.allowlist, body.ttl_seconds);
    reply.code(201).send({
      executionId: state.executionId,
      allowlist: state.allowlist,
      expiresAt: new Date(state.expiresAt).toISOString(),
    });
  });

  // Tear down an execution's state (sandbox executor calls this after run).
  fastify.delete<{ Params: { executionId: string } }>(
    "/execution/:executionId",
    async (req, reply) => {
      const removed = store.delete(req.params.executionId);
      reply.code(removed ? 204 : 404).send();
    },
  );

  // Retrieve the egress call log for an execution.
  fastify.get<{ Params: { executionId: string } }>(
    "/log/:executionId",
    async (req, reply): Promise<EgressCall[] | undefined> => {
      const state = store.get(req.params.executionId);
      if (!state) {
        reply.code(404).send({ error: "unknown_execution", executionId: req.params.executionId });
        return;
      }
      return state.calls;
    },
  );

  // The proxy route. We disable body parsing so handleProxyRequest can stream
  // the raw body upstream via undici (req.raw).
  fastify.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  const proxyHandler = async (req: any, reply: any) => {
    const { executionId } = req.params as { executionId: string };
    await handleProxyRequest(store, executionId, req, reply);
  };

  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const) {
    fastify.route({
      method,
      url: "/proxy/:executionId",
      handler: proxyHandler,
    });
    fastify.route({
      method,
      url: "/proxy/:executionId/*",
      handler: proxyHandler,
    });
  }

  return fastify;
}

async function main(): Promise<void> {
  const port = Number(process.env.EGRESS_PROXY_PORT ?? 5080);
  const store = new ProxyStore();
  store.startSweeper();
  const server = buildServer({ store, logger: true });

  const shutdown = async (signal: string) => {
    server.log.info({ signal }, "shutting down egress proxy");
    store.stopSweeper();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await server.listen({ port, host: "0.0.0.0" });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

// Only auto-start when this file is the program entrypoint (not when imported
// by tests).
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const argvHref = `file://${process.argv[1]}`;
  return import.meta.url === argvHref || process.argv[1].endsWith("/egress-proxy/dist/index.js") || process.argv[1].endsWith("/egress-proxy/src/index.ts");
})();

if (invokedDirectly) {
  void main();
}

export type { ExecutionState } from "./proxy.js";
export { ProxyStore } from "./proxy.js";
export { hostnameAllowed } from "./allowlist.js";
