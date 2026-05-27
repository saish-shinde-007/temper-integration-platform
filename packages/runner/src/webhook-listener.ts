// Webhook trigger endpoint. POST /trigger/:integrationId fires the
// integration if its trigger.type === 'webhook'. Tenant comes from the
// X-Tenant-Id header (matches the API's tenant middleware convention) or
// falls back to DEMO_TENANT_ID for unauthenticated demo use.
//
// We deliberately do not authenticate the webhook caller here — in real
// deployments this would sit behind an auth layer or a per-integration
// shared secret. For the demo, the integration must be Deployed/Running
// and the tenant must match, which is enforced via Repo's tenant scoping.

import Fastify, { type FastifyInstance } from "fastify";
import { Repo } from "@temper/db";
import { fireIntegration, type FireContext } from "./executor.js";

export async function startWebhookListener(
  ctx: FireContext,
  port: number,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true }));

  app.post<{
    Params: { integrationId: string };
  }>("/trigger/:integrationId", async (req, reply) => {
    const { integrationId } = req.params;
    const headerValue = req.headers["x-tenant-id"];
    const headerTenantId = Array.isArray(headerValue)
      ? headerValue[0]
      : headerValue;
    const tenantId =
      headerTenantId?.trim() || process.env.DEMO_TENANT_ID;

    if (!tenantId) {
      return reply.code(401).send({
        error: "missing_tenant",
        message:
          "X-Tenant-Id header is required (or set DEMO_TENANT_ID for the demo)",
      });
    }

    const repo = new Repo(ctx.pool, tenantId);
    const integration = await repo.getIntegration(integrationId);
    if (!integration) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (integration.trigger.type !== "webhook") {
      return reply.code(400).send({
        error: "wrong_trigger",
        message: `integration trigger is ${integration.trigger.type}, not webhook`,
      });
    }

    try {
      const result = await fireIntegration(
        ctx,
        integrationId,
        tenantId,
        "webhook",
        req.body,
      );
      return { ok: true, status: result.status };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: "fire_failed", message });
    }
  });

  await app.listen({ port, host: "0.0.0.0" });
  return app;
}
