// Cron scheduler. Maintains one node-cron ScheduledTask per cron-triggered
// integration. The sync loop is responsible for adding/removing entries
// based on what's currently in the DB — the scheduler itself doesn't poll.
//
// We validate cron expressions at registration time; if invalid we log and
// skip rather than crash the runner (a single bad integration shouldn't
// stop the others).

import cron, { type ScheduledTask } from "node-cron";
import type { Integration } from "@temper/shared";
import { fireIntegration, type FireContext } from "./executor.js";

export interface Scheduler {
  register(integration: Integration): void;
  deregister(integrationId: string): void;
  stopAll(): void;
  currentIds(): string[];
}

export function startScheduler(ctx: FireContext): Scheduler {
  const tasks = new Map<string, ScheduledTask>();

  return {
    register(integration: Integration) {
      if (integration.trigger.type !== "cron") return;
      if (tasks.has(integration.id)) return; // already registered

      const expression = integration.trigger.expression;
      if (!cron.validate(expression)) {
        console.error(
          `[scheduler] invalid cron expression for ${integration.id}: ${expression}`,
        );
        return;
      }

      const task = cron.schedule(expression, async () => {
        try {
          await fireIntegration(
            ctx,
            integration.id,
            integration.tenant_id,
            "cron",
          );
        } catch (err) {
          console.error(
            `[scheduler] fire failed for ${integration.id}:`,
            err,
          );
        }
      });
      tasks.set(integration.id, task);
    },
    deregister(integrationId: string) {
      const t = tasks.get(integrationId);
      if (t) {
        t.stop();
        tasks.delete(integrationId);
      }
    },
    stopAll() {
      tasks.forEach((t) => t.stop());
      tasks.clear();
    },
    currentIds() {
      return Array.from(tasks.keys());
    },
  };
}
