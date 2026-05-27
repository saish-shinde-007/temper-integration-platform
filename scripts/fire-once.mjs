import Docker from "dockerode";
import { SandboxExecutor } from "/Users/saishshinde/Desktop/temper/packages/sandbox/dist/index.js";
import { openDb, Repo, SecretsManager, AuditLogger } from "/Users/saishshinde/Desktop/temper/packages/db/dist/index.js";

const docker = new Docker();
const sandbox = new SandboxExecutor(docker, {
  baseImage: "temper-sandbox-base:latest",
  egressProxyUrl: "http://egress-proxy:5080",
  egressProxyLogUrl: "http://localhost:5080/log",
  networkName: "temper_temper-net",
});

const db = openDb("/Users/saishshinde/Desktop/temper/data/temper.db");
const repo = new Repo(db, "tenant-demo");
const integrations = repo.listIntegrations();
const integration = integrations.find(i => i.state === 'Running' || i.state === 'Deployed');
const version = repo.getIntegrationVersion(integration.current_version_id);

const audit = new AuditLogger(db, "tenant-demo");
const secretsM = new SecretsManager(db, (tid) => new AuditLogger(db, tid));
const secrets = {};
for (const name of version.declared_secrets) {
  const v = await secretsM.getSecret("tenant-demo", name);
  if (v) secrets[name] = v;
}

console.log("Running sandbox with source sha256:", version.sha256.slice(0, 16) + "...");
console.log("Declared endpoints:", version.declared_endpoints);
console.log("Secrets injected:", Object.keys(secrets));
const start = Date.now();
const result = await sandbox.run({
  source_code: version.source_code,
  declared_endpoints: version.declared_endpoints,
  secrets,
  timeout_ms: 30000,
  memory_mb: 256,
  trigger_payload: null,
});
console.log("Result:", { status: result.status, duration_ms: result.duration_ms, exit_code: result.exit_code, source_sha256_match: result.source_sha256 === version.sha256, egress_calls: result.egress_calls.length });
console.log("Wall-clock total:", Date.now() - start, "ms");
