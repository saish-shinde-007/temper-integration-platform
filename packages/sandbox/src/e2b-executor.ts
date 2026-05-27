// E2BSandboxExecutor: uses E2B's hosted Firecracker microVMs as the sandbox.
//
// Why this exists: Docker containers share a host kernel. Even with our
// hardening flags, one kernel CVE is one escape. E2B provides per-execution
// Firecracker VMs as a service — same isolation primitive the architecture
// doc targets for production, available immediately without us standing up
// a KVM fleet.
//
// Network model: E2B sandboxes run in E2B's cloud. They reach the integration's
// declared endpoints over the public internet, which means the demo's mock
// services need to be publicly reachable (Cloud Run with public ingress).
// For the local-dev path, the Docker executor stays available; the factory
// picks between them.
//
// Contract: implements SandboxAPI from @temper/shared, same as DockerSandboxExecutor.
// Drop-in swap.

import { Sandbox } from "@e2b/code-interpreter";
import { createHash, randomUUID } from "node:crypto";
import type {
  SandboxAPI,
  SandboxRequest,
  SandboxResult,
  EgressCall,
} from "@temper/shared";

export interface E2BSandboxExecutorOptions {
  /** E2B API key. Falls back to process.env.E2B_API_KEY. */
  apiKey?: string;
  /** E2B template id. Defaults to "code-interpreter-v1" (Node + common libs). */
  templateId?: string;
  /**
   * Optional pre-existing Sandbox to reuse across calls. The agent passes one
   * here during generation so its 5-10 validate_in_sandbox calls don't each
   * pay sandbox cold-start. Production fires leave this undefined → one
   * fresh sandbox per fire.
   */
  reusableSandbox?: Sandbox;
}

export class E2BSandboxExecutor implements SandboxAPI {
  constructor(private opts: E2BSandboxExecutorOptions = {}) {}

  async run(req: SandboxRequest): Promise<SandboxResult> {
    const apiKey = this.opts.apiKey ?? process.env.E2B_API_KEY;
    if (!apiKey) {
      throw new Error(
        "E2B_API_KEY is not set. Pass apiKey in options or set the env var.",
      );
    }
    const sha256 = createHash("sha256")
      .update(req.source_code)
      .digest("hex");
    const start = Date.now();

    // Reuse a passed-in sandbox (agent generation case) or spawn a fresh one
    // (runtime fire case). Either way the call ends with the sandbox in a
    // clean state — we reset filesystem state between invocations.
    let sandbox = this.opts.reusableSandbox;
    let ownsSandbox = false;
    if (!sandbox) {
      sandbox = await Sandbox.create({ apiKey });
      ownsSandbox = true;
    }

    const egressCalls: EgressCall[] = [];

    try {
      // Write source to /tmp/main.mjs inside the sandbox.
      await sandbox.files.write("/tmp/main.mjs", req.source_code);

      // Build the wrapper script that imports main.mjs, calls run(secrets,
      // triggerPayload), and emits a single-line JSON result. We do NOT
      // monkey-patch fetch here because E2B already enforces isolation at
      // the VM boundary; egress allowlist is platform policy, enforced at
      // call sites by inspecting captured network traffic.
      const wrapper = buildWrapperScript(req);
      await sandbox.files.write("/tmp/wrapper.mjs", wrapper);

      // Run with a timeout that matches the request's walltime.
      const timeoutSec = Math.max(1, Math.ceil(req.timeout_ms / 1000));
      const result = await sandbox.commands.run(
        `cd /tmp && node wrapper.mjs`,
        { timeoutMs: timeoutSec * 1000 },
      );

      const durationMs = Date.now() - start;
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";

      // Debug: log first/last bytes of stdout so we can see what E2B returned.
      console.log(`[e2b] exit=${result.exitCode} stdout.len=${stdout.length} stderr.len=${stderr.length}`);
      if (stdout.length > 0) console.log(`[e2b] stdout[head]:`, stdout.slice(0, 300));
      if (stderr.length > 0) console.log(`[e2b] stderr[head]:`, stderr.slice(0, 300));

      // The wrapper emits its egress log + result as a sentinel-bracketed
      // single line. Extract.
      const { result: payloadResult, egress } = extractWrapperOutput(stdout);
      egressCalls.push(...egress);

      const status: SandboxResult["status"] =
        result.exitCode === 0 ? "succeeded" : "failed";

      return {
        status,
        stdout,
        stderr,
        exit_code: result.exitCode,
        duration_ms: durationMs,
        egress_calls: egressCalls,
        source_sha256: sha256,
        output_payload: payloadResult,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const isTimeout = /timeout/i.test((err as Error).message);
      return {
        status: isTimeout ? "timeout" : "failed",
        stdout: "",
        stderr: (err as Error).message,
        exit_code: null,
        duration_ms: durationMs,
        egress_calls: egressCalls,
        source_sha256: sha256,
        output_payload: null,
      };
    } finally {
      if (ownsSandbox && sandbox) {
        try {
          await sandbox.kill();
        } catch {
          // best-effort cleanup
        }
      } else if (sandbox) {
        // Reusable sandbox: reset /tmp state so the next validate doesn't
        // see leftovers. We don't kill it because the agent will use it again.
        try {
          await sandbox.commands.run("rm -f /tmp/main.mjs /tmp/wrapper.mjs");
        } catch {
          // ignore
        }
      }
    }
  }
}

/**
 * Spawn a long-lived E2B sandbox that the agent can reuse for its
 * validate_in_sandbox calls within a single generation. Caller is responsible
 * for kill().
 */
export async function createReusableSandbox(apiKey?: string): Promise<Sandbox> {
  const key = apiKey ?? process.env.E2B_API_KEY;
  if (!key) throw new Error("E2B_API_KEY required");
  return Sandbox.create({ apiKey: key });
}

function buildWrapperScript(req: SandboxRequest): string {
  // Inject secrets as a literal object (escaped) and trigger payload similarly.
  // We track egress by wrapping global fetch so the platform can audit what
  // the generated code actually called.
  return `
const SECRETS = ${JSON.stringify(req.secrets)};
const TRIGGER_PAYLOAD = ${JSON.stringify(req.trigger_payload ?? null)};
const ALLOWLIST = new Set(${JSON.stringify(req.declared_endpoints)});

const __egress = [];
const __originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  let hostname;
  try { hostname = new URL(url).hostname; } catch { hostname = ""; }
  const allowed = [...ALLOWLIST].some(h =>
    h === hostname ||
    (h.startsWith("*.") && hostname.endsWith(h.slice(1)))
  );
  const entry = {
    timestamp: new Date().toISOString(),
    method: (init && init.method) || "GET",
    url,
    status_code: null,
    blocked: !allowed,
  };
  if (!allowed) {
    entry.reason = "hostname_not_allowlisted:" + hostname;
    __egress.push(entry);
    return new Response(JSON.stringify({ error: "egress_blocked", hostname }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  const resp = await __originalFetch(input, init);
  entry.status_code = resp.status;
  __egress.push(entry);
  return resp;
};

let result;
try {
  const mod = await import("./main.mjs");
  const run = mod.run || (mod.default && mod.default.run);
  if (typeof run !== "function") {
    result = { ok: false, error: "module did not export run()" };
  } else {
    result = await run(SECRETS, TRIGGER_PAYLOAD);
  }
} catch (err) {
  result = { ok: false, error: err && err.message ? err.message : String(err) };
}

process.stdout.write("__TEMPER_RESULT__" + JSON.stringify({ result, egress: __egress }) + "__END__\\n");
process.exit(result && result.ok ? 0 : 1);
`;
}

function extractWrapperOutput(stdout: string): {
  result: string | null;
  egress: EgressCall[];
} {
  const m = stdout.match(/__TEMPER_RESULT__(.*)__END__/);
  if (!m) return { result: null, egress: [] };
  try {
    const parsed = JSON.parse(m[1]) as {
      result: unknown;
      egress: EgressCall[];
    };
    return {
      result: JSON.stringify(parsed.result),
      egress: Array.isArray(parsed.egress) ? parsed.egress : [],
    };
  } catch {
    return { result: null, egress: [] };
  }
}
