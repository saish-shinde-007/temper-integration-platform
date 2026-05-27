// /v1/integrations/:id/runs        — list runs for an integration
// /v1/integrations/:id/logs   (SSE) — stream stdout/stderr while the
//                                     integration is in an active state
//
// SSE strategy (acceptable for the demo per the spec): every 1 s, re-read
// the most recent run rows and emit any new stdout/stderr lines as
// separate events. The stream closes when the integration leaves an
// active state (Generating / Tested / Building / Running) or when the
// client disconnects. Production would replace this poll loop with a
// real log fan-out from the sandbox process.

import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";
import type { IntegrationState, Run } from "@temper/shared";
import { Repo } from "@temper/db";

const ACTIVE_STATES = new Set<IntegrationState>([
  "Generating",
  "Tested",
  "Building",
  "Running",
]);

const POLL_INTERVAL_MS = 1000;
// Hard cap so a stuck integration can't keep an SSE socket open forever.
const MAX_STREAM_MS = 10 * 60 * 1000; // 10 min

interface StreamCursor {
  // Per-run cursor: how many chars of stdout/stderr we've already sent.
  stdoutBytes: number;
  stderrBytes: number;
  status: string;
}

export function registerRunsRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
): void {
  // ---- List runs ----
  app.get<{ Params: { id: string } }>(
    "/v1/integrations/:id/runs",
    async (req, reply) => {
      const repo = req.repo!;
      const integration = await repo.getIntegration(req.params.id);
      if (!integration) {
        reply.code(404);
        return { error: "not_found", message: `Integration ${req.params.id} not found` };
      }
      return repo.listRunsForIntegration(integration.id);
    },
  );

  // ---- SSE log stream ----
  //
  // @fastify/sse-v2 augments reply with `sse()`. We don't use the
  // observable form here because we want fine control over the close
  // timing — instead we drive a 1s polling loop and call reply.sse({...})
  // manually.
  app.get<{ Params: { id: string } }>(
    "/v1/integrations/:id/logs",
    async (req, reply) => {
      const repo = req.repo!;
      const tenantId = req.tenantId!;
      const integration = await repo.getIntegration(req.params.id);
      if (!integration) {
        reply.code(404);
        return { error: "not_found", message: `Integration ${req.params.id} not found` };
      }

      // sse-v2: opens the stream when we yield events through reply.sse().
      // We use the manual write-loop form so we can keep polling state.
      const cursors = new Map<string, StreamCursor>();
      let eventId = 0;
      let stopped = false;

      const cleanup = () => {
        stopped = true;
      };
      req.raw.on("close", cleanup);
      req.raw.on("error", cleanup);

      const startedAt = Date.now();

      // sse-v2 exposes reply.sse(iterable). Build an async generator that
      // yields events until we decide to close.
      const stream = async function* () {
        // Initial "connected" frame so clients know the channel is live.
        yield {
          id: String(eventId++),
          event: "connected",
          data: JSON.stringify({
            integration_id: integration.id,
            state: integration.state,
          }),
        };

        // Re-fetch a fresh Repo on every tick — the pool handles its own
        // connection reuse and we keep tenant scoping per-call.
        while (!stopped) {
          if (Date.now() - startedAt > MAX_STREAM_MS) break;

          // Re-read state + runs.
          const current = await new Repo(pool, tenantId).getIntegration(integration.id);
          if (!current) {
            yield {
              id: String(eventId++),
              event: "error",
              data: JSON.stringify({ message: "integration disappeared" }),
            };
            break;
          }

          const runs = await new Repo(pool, tenantId).listRunsForIntegration(integration.id);
          for (const run of runs) {
            const cursor = cursors.get(run.id) ?? {
              stdoutBytes: 0,
              stderrBytes: 0,
              status: "",
            };

            // Emit any new stdout bytes since last tick.
            if (run.stdout.length > cursor.stdoutBytes) {
              const delta = run.stdout.slice(cursor.stdoutBytes);
              cursor.stdoutBytes = run.stdout.length;
              for (const line of splitLines(delta)) {
                yield {
                  id: String(eventId++),
                  event: "stdout",
                  data: JSON.stringify({
                    run_id: run.id,
                    line,
                    ts: new Date().toISOString(),
                  }),
                };
              }
            }
            if (run.stderr.length > cursor.stderrBytes) {
              const delta = run.stderr.slice(cursor.stderrBytes);
              cursor.stderrBytes = run.stderr.length;
              for (const line of splitLines(delta)) {
                yield {
                  id: String(eventId++),
                  event: "stderr",
                  data: JSON.stringify({
                    run_id: run.id,
                    line,
                    ts: new Date().toISOString(),
                  }),
                };
              }
            }
            // Status transition.
            if (cursor.status !== run.status) {
              cursor.status = run.status;
              yield {
                id: String(eventId++),
                event: "status",
                data: JSON.stringify({
                  run_id: run.id,
                  status: run.status,
                  exit_code: run.exit_code,
                }),
              };
            }
            cursors.set(run.id, cursor);
          }

          // Close when the integration leaves an active state.
          if (!ACTIVE_STATES.has(current.state)) {
            yield {
              id: String(eventId++),
              event: "done",
              data: JSON.stringify({
                integration_id: integration.id,
                final_state: current.state,
              }),
            };
            break;
          }

          await sleep(POLL_INTERVAL_MS);
        }
      };

      // sse-v2's reply.sse accepts an async iterable.
      const sseReply = reply as FastifyReply & {
        sse: (
          iterable: AsyncIterable<{ id?: string; event?: string; data: string }>,
        ) => void;
      };
      sseReply.sse(stream());
      // Returning the reply tells Fastify we've taken over the response.
      return reply;
    },
  );
}

// ---------- helpers ----------

function splitLines(chunk: string): string[] {
  // Keep newlines as separator; emit each non-empty line as its own event.
  // Trailing partial lines (no newline) are still emitted — the next tick
  // will emit anything new after them.
  if (chunk.length === 0) return [];
  return chunk
    .split(/\r?\n/)
    .filter((s) => s.length > 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Marker export to satisfy the Run import (keeps the type available if
// downstream consumers want to import the same module).
export type { Run };
