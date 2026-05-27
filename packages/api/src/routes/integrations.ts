// /v1/integrations/* — CRUD + workflow signals.
//
// All routes here assume the tenantMiddleware has already attached
// req.tenantId, req.repo, req.audit. They never construct a Repo with a
// caller-supplied tenant id.
//
// State transitions are NEVER decided here. The HTTP layer translates
// the user's intent ("approve", "deploy") into a signal to the Temporal
// workflow, and the workflow updates the state. For the demo, the stub
// TemporalClient collapses that to inline DB writes — same effect, no
// Temporal server required.

import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { ZodError, z } from "zod";
import {
  CreateIntegrationRequestSchema,
  ApproveIntegrationRequestSchema,
} from "@temper/shared";
import type { TemporalClient } from "../temporal-client.js";

const RejectIntegrationRequestSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

function workflowIdFor(integrationId: string): string {
  // Matches the stub's startIntegrationWorkflow id scheme. The real
  // TemporalClient will use the same convention.
  return `wf-${integrationId}`;
}

export function registerIntegrationRoutes(
  app: FastifyInstance,
  _pool: pg.Pool,
  temporal: TemporalClient,
): void {
  // ---- Create ----
  app.post("/v1/integrations", async (req, reply) => {
    const body = CreateIntegrationRequestSchema.parse(req.body);
    const repo = req.repo!;
    const audit = req.audit!;
    const tenantId = req.tenantId!;

    const integration = await repo.createIntegration({
      name: body.name,
      description: body.description,
      trigger: body.trigger,
    });

    await audit.record("integration.created", null, {
      integration_id: integration.id,
      name: integration.name,
      trigger: integration.trigger,
      tenant_id: tenantId,
    });

    reply.code(201);
    return integration;
  });

  // ---- List ----
  app.get("/v1/integrations", async (req) => {
    return req.repo!.listIntegrations();
  });

  // ---- Get one (with current_version expanded) ----
  app.get<{ Params: { id: string } }>(
    "/v1/integrations/:id",
    async (req, reply) => {
      const repo = req.repo!;
      const integration = await repo.getIntegration(req.params.id);
      if (!integration) {
        reply.code(404);
        return { error: "not_found", message: `Integration ${req.params.id} not found` };
      }
      // Prefer the explicitly-pinned current version (set on Deploy).
      // Fall back to the latest version overall so the UI can show the
      // generated code as soon as Generation finishes, before Approve+Deploy.
      let current_version = integration.current_version_id
        ? await repo.getIntegrationVersion(integration.current_version_id)
        : null;
      if (!current_version) {
        const all = await repo.listVersionsForIntegration(integration.id);
        current_version = all[0] ?? null; // listVersionsForIntegration returns newest first
      }
      return { ...integration, current_version };
    },
  );

  // ---- Test: start (or restart) the workflow ----
  app.post<{ Params: { id: string } }>(
    "/v1/integrations/:id/test",
    async (req, reply) => {
      const repo = req.repo!;
      const audit = req.audit!;
      const tenantId = req.tenantId!;
      const integration = await repo.getIntegration(req.params.id);
      if (!integration) {
        reply.code(404);
        return { error: "not_found", message: `Integration ${req.params.id} not found` };
      }

      const { workflowId } = await temporal.startIntegrationWorkflow(
        integration.id,
        tenantId,
      );

      await audit.record("integration.tested", null, {
        integration_id: integration.id,
        workflow_id: workflowId,
      });

      // Return the freshly-stubbed integration row so callers can poll.
      const updated = await repo.getIntegration(integration.id);
      return { workflow_id: workflowId, integration: updated };
    },
  );

  // ---- Approve ----
  app.post<{ Params: { id: string } }>(
    "/v1/integrations/:id/approve",
    async (req, reply) => {
      const body = ApproveIntegrationRequestSchema.parse(req.body);
      const repo = req.repo!;
      const audit = req.audit!;
      const integration = await repo.getIntegration(req.params.id);
      if (!integration) {
        reply.code(404);
        return { error: "not_found", message: `Integration ${req.params.id} not found` };
      }
      // Sanity check that the version actually belongs to this tenant +
      // integration before sending a signal. The workflow does this too,
      // but rejecting at the edge gives a cleaner 4xx instead of a 500.
      const version = await repo.getIntegrationVersion(body.version_id);
      if (!version || version.integration_id !== integration.id) {
        reply.code(400);
        return {
          error: "invalid_version",
          message: `Version ${body.version_id} does not belong to integration ${integration.id}`,
        };
      }

      await temporal.signalApprove(workflowIdFor(integration.id), body.version_id);
      await audit.record("integration.approved", null, {
        integration_id: integration.id,
        version_id: body.version_id,
      });

      const updated = await repo.getIntegration(integration.id);
      return updated;
    },
  );

  // ---- Reject ----
  app.post<{ Params: { id: string } }>(
    "/v1/integrations/:id/reject",
    async (req, reply) => {
      let parsedBody: { reason?: string } = {};
      try {
        parsedBody = RejectIntegrationRequestSchema.parse(req.body ?? {});
      } catch (err) {
        if (err instanceof ZodError) throw err;
        throw err;
      }
      const repo = req.repo!;
      const audit = req.audit!;
      const integration = await repo.getIntegration(req.params.id);
      if (!integration) {
        reply.code(404);
        return { error: "not_found", message: `Integration ${req.params.id} not found` };
      }

      await temporal.signalReject(workflowIdFor(integration.id), parsedBody.reason);
      await audit.record("integration.rejected", null, {
        integration_id: integration.id,
        reason: parsedBody.reason ?? null,
      });

      const updated = await repo.getIntegration(integration.id);
      return updated;
    },
  );

  // ---- Deploy ----
  app.post<{ Params: { id: string } }>(
    "/v1/integrations/:id/deploy",
    async (req, reply) => {
      const repo = req.repo!;
      const audit = req.audit!;
      const integration = await repo.getIntegration(req.params.id);
      if (!integration) {
        reply.code(404);
        return { error: "not_found", message: `Integration ${req.params.id} not found` };
      }

      await temporal.signalDeploy(workflowIdFor(integration.id));
      await audit.record("integration.deployed", null, {
        integration_id: integration.id,
      });

      const updated = await repo.getIntegration(integration.id);
      return updated;
    },
  );

  // ---- Versions ----
  app.get<{ Params: { id: string } }>(
    "/v1/integrations/:id/versions",
    async (req, reply) => {
      const repo = req.repo!;
      // Confirm parent exists in this tenant first so we return 404 instead
      // of an empty array for missing/foreign integrations.
      const integration = await repo.getIntegration(req.params.id);
      if (!integration) {
        reply.code(404);
        return { error: "not_found", message: `Integration ${req.params.id} not found` };
      }
      return repo.listVersionsForIntegration(integration.id);
    },
  );

  app.get<{ Params: { id: string; versionId: string } }>(
    "/v1/integrations/:id/versions/:versionId",
    async (req, reply) => {
      const repo = req.repo!;
      // Tenant guard via the integration first.
      const integration = await repo.getIntegration(req.params.id);
      if (!integration) {
        reply.code(404);
        return { error: "not_found", message: `Integration ${req.params.id} not found` };
      }
      const version = await repo.getIntegrationVersion(req.params.versionId);
      if (!version || version.integration_id !== integration.id) {
        reply.code(404);
        return {
          error: "not_found",
          message: `Version ${req.params.versionId} not found`,
        };
      }
      return version;
    },
  );
}
