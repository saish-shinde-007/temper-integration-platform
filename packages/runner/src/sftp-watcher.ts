// SFTP file-drop watcher. Every 30s, for each Deployed/Running integration
// with trigger.type === 'sftp', we:
//   1. Connect to the SFTP using credentials from the integration's secrets.
//   2. List files matching the trigger's pattern under the trigger's path.
//   3. For each filename we haven't seen before, fire the integration once
//      with { filename, path, size, modifyTime } as the trigger payload.
//   4. Remember the filename so we don't refire on the next tick.
//
// Credentials are read from the tenant's secrets store using a well-known
// convention: SFTP_USER, SFTP_PASS. Host/port/path come from the trigger
// config itself. The pattern is a simple glob (the only token we honour
// is `*`, converted to `.*` in a RegExp) — anchored to the whole filename.
//
// The seen-set is in-memory per-process. Restarting the runner will refire
// for every file currently present; that's acceptable for the demo. In a
// production system this would be persisted (e.g. via a per-integration
// "sftp_cursor" row).

import SftpClient from "ssh2-sftp-client";
import { Repo, SecretsManager, AuditLogger } from "@temper/db";
import type { Integration, SftpTrigger } from "@temper/shared";
import { fireIntegration, type FireContext } from "./executor.js";

export interface SftpWatcher {
  stop(): void;
  /** Run a single tick now. Exposed for tests and the sync loop's initial pass. */
  tick(): Promise<void>;
  currentIds(): string[];
}

const POLL_INTERVAL_MS = 30_000;

export function startSftpWatcher(ctx: FireContext): SftpWatcher {
  // integrationId -> Set of filenames we've already fired for
  const seen = new Map<string, Set<string>>();
  let interval: NodeJS.Timeout | null = null;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return; // skip overlapping ticks
    inFlight = true;
    try {
      // We only know about the demo tenant here. In a multi-tenant runner,
      // sync.ts would feed us the active tenants; for now we fall back to
      // DEMO_TENANT_ID just like the rest of the runner.
      const tenantId = process.env.DEMO_TENANT_ID ?? "tenant-demo";
      const repo = new Repo(ctx.pool, tenantId);
      const integrations = (await repo.listIntegrations()).filter(
        (i): i is Integration & { trigger: SftpTrigger } =>
          i.trigger.type === "sftp" &&
          (i.state === "Deployed" ||
            i.state === "Running" ||
            i.state === "Degraded"),
      );

      for (const integration of integrations) {
        try {
          await checkOne(ctx, repo, tenantId, integration, seen);
        } catch (err) {
          console.error(
            `[sftp-watcher] check failed for ${integration.id}:`,
            err,
          );
        }
      }
    } finally {
      inFlight = false;
    }
  }

  interval = setInterval(() => {
    tick().catch((e) =>
      console.error("[sftp-watcher] unexpected tick error", e),
    );
  }, POLL_INTERVAL_MS);

  return {
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
    tick,
    currentIds() {
      return Array.from(seen.keys());
    },
  };
}

async function checkOne(
  ctx: FireContext,
  _repo: Repo,
  tenantId: string,
  integration: Integration & { trigger: SftpTrigger },
  seen: Map<string, Set<string>>,
): Promise<void> {
  const secrets = new SecretsManager(
    ctx.pool,
    (tid: string) => new AuditLogger(ctx.pool, tid),
  );
  const user = await secrets.getSecret(tenantId, "SFTP_USER");
  const pass = await secrets.getSecret(tenantId, "SFTP_PASS");
  if (!user || !pass) {
    // Missing creds — skip silently. The first run will surface the error
    // via the run row's stderr; we don't want to spam every poll.
    return;
  }

  const client = new SftpClient();
  let connected = false;
  try {
    await client.connect({
      host: integration.trigger.host,
      port: integration.trigger.port,
      username: user,
      password: pass,
      readyTimeout: 10_000,
    });
    connected = true;

    const list = await client.list(integration.trigger.path);
    const matcher = globToRegExp(integration.trigger.pattern);
    const matches = list.filter(
      (entry) => entry.type === "-" && matcher.test(entry.name),
    );

    const seenForIntegration =
      seen.get(integration.id) ?? new Set<string>();

    // On first observation of an integration, prime the seen set with
    // everything currently present instead of firing for every existing
    // file. Otherwise a Deploy with 100 files in the inbox would fire
    // 100 times instantly.
    if (!seen.has(integration.id)) {
      for (const m of matches) seenForIntegration.add(m.name);
      seen.set(integration.id, seenForIntegration);
      return;
    }

    for (const entry of matches) {
      if (seenForIntegration.has(entry.name)) continue;

      const payload = {
        filename: entry.name,
        path: integration.trigger.path,
        size: entry.size,
        modify_time: entry.modifyTime,
      };

      try {
        await fireIntegration(
          ctx,
          integration.id,
          integration.tenant_id,
          "sftp",
          payload,
        );
      } catch (err) {
        console.error(
          `[sftp-watcher] fire failed for ${integration.id} / ${entry.name}:`,
          err,
        );
      } finally {
        // Mark seen even on failure so we don't loop on a poison file.
        // The run row records the failure for operator visibility.
        seenForIntegration.add(entry.name);
      }
    }
  } finally {
    if (connected) {
      await client.end().catch(() => {
        // ignore end errors — connection may already be down
      });
    }
  }
}

/**
 * Convert a simple glob (only `*` is special) into an anchored RegExp.
 * Escapes every other regex metacharacter so a pattern like `orders-*.csv`
 * doesn't accidentally treat `.` as a wildcard.
 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
