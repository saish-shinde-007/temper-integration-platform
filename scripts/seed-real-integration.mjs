// Seed a real integration version + secrets for the demo, so the runner
// will actually move orders from System A to System B on its next cron tick.
// Bypasses the agent — same effect as if Claude had generated this code.

import { openDb, Repo, SecretsManager, AuditLogger } from "../packages/db/dist/index.js";
import { createHash, randomUUID } from "node:crypto";

const TENANT = process.env.DEMO_TENANT_ID || "tenant-demo";
const DB_PATH = process.env.DATABASE_PATH || "./data/temper.db";

const REAL_SOURCE = `// Real REST poll -> REST POST integration
export async function run(secrets, triggerPayload) {
  try {
    const cursor = secrets.CURSOR || "1970-01-01T00:00:00.000Z";
    const sourceUrl = secrets.SYSTEM_A_URL + "/orders?since=" + encodeURIComponent(cursor);
    const resp = await fetch(sourceUrl);
    if (!resp.ok) return { ok: false, error: "source returned " + resp.status };
    const orders = await resp.json();

    let lastSeen = cursor;
    let sent = 0;
    for (const order of orders) {
      const payload = {
        orderId: order.id,
        customerName: order.customer,
        totalAmount: order.amount,
      };
      const post = await fetch(secrets.SYSTEM_B_URL + "/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (post.ok) {
        sent += 1;
        if (order.created_at > lastSeen) lastSeen = order.created_at;
      }
    }
    return { ok: true, output: { processed: sent, new_cursor: lastSeen } };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}
`;

const DECLARED_ENDPOINTS = ["mock-system-a", "mock-system-b"];
const DECLARED_SECRETS = ["SYSTEM_A_URL", "SYSTEM_B_URL", "CURSOR"];

const db = openDb(DB_PATH);
const repo = new Repo(db, TENANT);
const audit = new AuditLogger(db, TENANT);
const secrets = new SecretsManager(db, (tid) => new AuditLogger(db, tid));

const integrations = repo.listIntegrations();
if (integrations.length === 0) {
  console.error("No integration found in tenant", TENANT);
  process.exit(1);
}

const integration = integrations[0];
console.log("Seeding real integration into:", integration.name, "(id:", integration.id + ")");

const sha = createHash("sha256").update(REAL_SOURCE).digest("hex");
const version = repo.createIntegrationVersion(integration.id, {
  sha256: sha,
  source_code: REAL_SOURCE,
  declared_endpoints: DECLARED_ENDPOINTS,
  declared_secrets: DECLARED_SECRETS,
});

repo.setCurrentVersion(integration.id, version.id);
repo.updateIntegrationState(integration.id, "Deployed");

// Set secrets so the integration can reach the mocks.
// Note: hostnames here are the docker-compose network aliases — what the
// sandbox container will see from inside temper-net.
await secrets.setSecret(TENANT, "SYSTEM_A_URL", "http://mock-system-a:5001");
await secrets.setSecret(TENANT, "SYSTEM_B_URL", "http://mock-system-b:5002");
await secrets.setSecret(TENANT, "CURSOR", "1970-01-01T00:00:00.000Z");

await audit.record("integration.deployed", null, {
  integrationId: integration.id,
  versionId: version.id,
  note: "seeded real source + secrets for demo",
});

console.log("✓ New version:", version.id, "(sha:", sha.slice(0, 12) + "...)");
console.log("✓ Set secrets: SYSTEM_A_URL, SYSTEM_B_URL, CURSOR");
console.log("✓ Integration is Deployed. Runner will fire it on the next cron tick (within 1 minute).");
