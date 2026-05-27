// Periodic reconciliation between the DB and the in-process trigger
// registrations. Every 60s we read the set of Deployed/Running/Degraded
// integrations and:
//   - Register cron tasks for any cron-triggered integration not already
//     registered.
//   - Deregister cron tasks whose integration is no longer in a firable
//     state (or has been retired/deleted).
//
// Webhook triggers don't need sync — the listener is always live and looks
// up the integration per request.
//
// The SFTP watcher polls on its own schedule but we don't have to seed it
// here; its tick reads the DB each time.
//
// The first reconcile fires immediately at start so a freshly-restarted
// runner picks up existing cron integrations within seconds, not minutes.

import { Repo } from "@temper/db";
import type { Integration } from "@temper/shared";
import type { Scheduler } from "./scheduler.js";
import type { SftpWatcher } from "./sftp-watcher.js";
import type { FireContext } from "./executor.js";

export interface SyncContext extends FireContext {
  scheduler: Scheduler;
  sftpWatcher: SftpWatcher;
}

export interface SyncLoop {
  stop(): void;
  /** Run a single reconcile now. Exposed for tests and the initial pass. */
  reconcile(): Promise<void>;
}

const SYNC_INTERVAL_MS = 60_000;

export function startSyncLoop(ctx: SyncContext): SyncLoop {
  async function reconcile(): Promise<void> {
    try {
      await reconcileOnce(ctx);
    } catch (err) {
      console.error("[sync] reconcile failed:", err);
    }
  }

  // Initial pass before we set up the timer so the runner is ready ASAP.
  // We deliberately do not `await` here — startSyncLoop is synchronous
  // and the timer is the long-lived behaviour anyway. Errors are swallowed
  // inside reconcile() so this is safe to fire-and-forget.
  void reconcile();

  const interval = setInterval(() => {
    void reconcile();
  }, SYNC_INTERVAL_MS);

  return {
    stop() {
      clearInterval(interval);
    },
    reconcile,
  };
}

async function reconcileOnce(ctx: SyncContext): Promise<void> {
  // We need to enumerate integrations across all tenants. The Repo class
  // is intentionally tenant-scoped, so we walk the tenants table directly
  // (read-only) and then use Repo per tenant for the actual list.
  const tenantRes = await ctx.pool.query<{ id: string }>(
    "SELECT id FROM tenants",
  );

  const wantedCronIds = new Set<string>();

  for (const { id: tenantId } of tenantRes.rows) {
    const repo = new Repo(ctx.pool, tenantId);
    const firable: Integration[] = (await repo.listIntegrations()).filter(
      (i) =>
        i.state === "Deployed" ||
        i.state === "Running" ||
        i.state === "Degraded",
    );

    for (const integration of firable) {
      if (integration.trigger.type === "cron") {
        wantedCronIds.add(integration.id);
        ctx.scheduler.register(integration);
      }
    }
  }

  // Drop cron registrations that are no longer wanted (retired, deleted,
  // demoted to Draft, etc.).
  for (const existingId of ctx.scheduler.currentIds()) {
    if (!wantedCronIds.has(existingId)) {
      ctx.scheduler.deregister(existingId);
    }
  }
}
