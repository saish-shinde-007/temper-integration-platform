// SandboxExecutor: host-side runner that boots a hardened Docker container,
// streams the generated TypeScript module into it read-only, enforces a
// walltime via SIGKILL, and returns a deterministic SandboxResult.
//
// Security posture (every flag here exists for a reason — see docker/README.md):
//   - Custom user-defined network (temper-net): the only thing the sandbox can
//     reach is the egress-proxy. No default bridge, no host network.
//   - Read-only rootfs + tmpfs for /tmp: code cannot persist anything.
//   - cap-drop ALL + no-new-privileges + seccomp profile: no syscalls beyond
//     a minimal allowlist, no setuid escalation.
//   - Non-root user (uid 10001): even if seccomp slips, the process has no
//     filesystem write authority on the host.
//   - Memory + swap + cpu + pids limits: cgroup-enforced, OOM-kills runaway code.
//   - HTTP(S)_PROXY env vars point the sandbox's axios/fetch at the egress
//     proxy. EGRESS_ALLOWLIST passes the declared endpoints; the proxy is the
//     enforcement point, not the sandbox.
//   - source_code is mounted read-only at /code/main.mjs from a host tmpdir.
//   - AutoRemove cleans up the container; we also rm -rf the tmpdir.

import Docker from "dockerode";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  SandboxAPI,
  SandboxRequest,
  SandboxResult,
  EgressCall,
} from "@temper/shared";

export interface SandboxExecutorOptions {
  /** Image built from packages/sandbox/docker/Dockerfile. */
  baseImage?: string;
  /** Where the sandbox's HTTP(S)_PROXY env points. Defaults to the in-net DNS name. */
  egressProxyUrl?: string;
  /** GET endpoint on the egress proxy that returns the JSON call log for a correlation id. */
  egressProxyLogUrl?: string;
  memoryMb?: number;
  cpu?: number;
  pidsLimit?: number;
  /** Absolute path to docker/seccomp.json. If unset, Docker's default profile is used. */
  seccompProfilePath?: string;
  /** Docker network the container joins. The egress-proxy must also be on this network. */
  networkName?: string;
  /**
   * If true, fail closed when we cannot fetch the egress log from the proxy.
   * Tests set this to false; production runs should set true once the proxy is live.
   */
  failClosedOnProxy?: boolean;
}

const DEFAULTS = {
  baseImage: "temper-sandbox-base:latest",
  egressProxyUrl: "http://egress-proxy:5080",
  egressProxyLogUrl: "http://localhost:5080/log",
  memoryMb: 256,
  cpu: 0.5,
  pidsLimit: 64,
  networkName: "temper-net",
  failClosedOnProxy: false,
} as const;

export class SandboxExecutor implements SandboxAPI {
  constructor(
    private readonly docker: Docker,
    private readonly opts: SandboxExecutorOptions = {},
  ) {}

  async run(req: SandboxRequest): Promise<SandboxResult> {
    const correlationId = randomUUID();
    const startTime = Date.now();
    const sha256 = createHash("sha256")
      .update(req.source_code)
      .digest("hex");

    const baseImage = this.opts.baseImage ?? DEFAULTS.baseImage;
    const egressProxyUrl = this.opts.egressProxyUrl ?? DEFAULTS.egressProxyUrl;
    const egressProxyLogBase =
      this.opts.egressProxyLogUrl ?? DEFAULTS.egressProxyLogUrl;
    const memoryMb = this.opts.memoryMb ?? req.memory_mb ?? DEFAULTS.memoryMb;
    const cpu = this.opts.cpu ?? DEFAULTS.cpu;
    const pidsLimit = this.opts.pidsLimit ?? DEFAULTS.pidsLimit;
    const networkName = this.opts.networkName ?? DEFAULTS.networkName;

    // 1. Materialise the integration source to a host tmpdir.
    //    The container mounts this single file read-only at /code/main.mjs.
    //    We do NOT mount the whole tmpdir — that would let any future
    //    auxiliary file in the dir leak in.
    const hostTmpDir = await mkdtemp(join(tmpdir(), "temper-sandbox-"));
    const codePath = join(hostTmpDir, "main.mjs");
    await writeFile(codePath, req.source_code, "utf8");

    // 2. Env vars: secrets (prefixed), trigger payload, proxy + allowlist.
    //    Secret values are passed as env, never written to disk. Secret names
    //    are namespaced with SECRET_ so the entrypoint can dedupe them
    //    from operational vars.
    const env: string[] = [
      `EXECUTION_ID=${correlationId}`,
      `TRIGGER_PAYLOAD=${JSON.stringify(req.trigger_payload ?? null)}`,
      `HTTP_PROXY=${egressProxyUrl}`,
      `HTTPS_PROXY=${egressProxyUrl}`,
      `http_proxy=${egressProxyUrl}`,
      `https_proxy=${egressProxyUrl}`,
      `EGRESS_ALLOWLIST=${req.declared_endpoints.join(",")}`,
      `NO_PROXY=`, // Force every outbound call through the proxy.
    ];
    for (const [k, v] of Object.entries(req.secrets)) {
      env.push(`SECRET_${k}=${v}`);
    }

    // 3. Build the SecurityOpt list: no-new-privileges always, seccomp only if
    //    a custom profile was supplied (otherwise Docker's default applies).
    const securityOpt: string[] = ["no-new-privileges:true"];
    if (this.opts.seccompProfilePath) {
      // dockerode wants the seccomp profile as a JSON string, not a path.
      // We accept a path in the API and require the caller to pass the
      // contents through the SeccompProfilePath option to be inlined below.
      // For convenience: if the caller passed a path, we inline it here.
      try {
        const { readFile } = await import("node:fs/promises");
        const profile = await readFile(this.opts.seccompProfilePath, "utf8");
        securityOpt.push(`seccomp=${profile}`);
      } catch {
        // If we cannot read the profile, fall back to Docker's default
        // rather than silently running with seccomp=unconfined.
      }
    }

    // 4. Create + start the container with every hardening flag.
    const container = await this.docker.createContainer({
      Image: baseImage,
      Env: env,
      WorkingDir: "/sandbox",
      User: "10001:10001",
      NetworkDisabled: false, // We need network for the egress proxy.
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Labels: {
        "temper.execution_id": correlationId,
        "temper.source_sha256": sha256,
      },
      HostConfig: {
        Binds: [`${codePath}:/code/main.mjs:ro`],
        ReadonlyRootfs: true,
        NetworkMode: networkName,
        Memory: memoryMb * 1024 * 1024,
        MemorySwap: memoryMb * 1024 * 1024, // equal to Memory => no swap.
        NanoCpus: Math.floor(cpu * 1e9),
        PidsLimit: pidsLimit,
        CapDrop: ["ALL"],
        SecurityOpt: securityOpt,
        Tmpfs: { "/tmp": "size=10m,mode=1777" },
        AutoRemove: true,
        // Prevent fork bombs even within the pids limit:
        Ulimits: [{ Name: "nproc", Soft: 64, Hard: 64 }],
        // Disable inter-container privilege escalation surfaces:
        Privileged: false,
        // Restart never — a sandbox run is one-shot.
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      },
    });

    let stdout = "";
    let stderr = "";

    // 5. Attach BEFORE start so we capture every byte.
    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });

    const stdoutSink = {
      write: (chunk: Buffer | string) => {
        stdout += chunk.toString();
        return true;
      },
      end: () => {},
    };
    const stderrSink = {
      write: (chunk: Buffer | string) => {
        stderr += chunk.toString();
        return true;
      },
      end: () => {},
    };

    // dockerode's modem demuxStream takes Writable-ish targets.
    (this.docker as unknown as { modem: { demuxStream: Function } }).modem.demuxStream(
      stream,
      stdoutSink,
      stderrSink,
    );

    // 5a. Register the execution + allowlist with the egress proxy so it
    //     will forward this sandbox's calls. If the proxy isn't reachable
    //     (e.g., unit tests without docker-compose up), we soft-fail and
    //     continue — the run will still execute, but off-network calls will
    //     hit a closed port and the egress log will be empty.
    const proxyControlBase = egressProxyLogBase.replace(/\/log\/?$/, "");
    try {
      await fetch(`${proxyControlBase}/execution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executionId: correlationId,
          allowlist: req.declared_endpoints,
          ttl_seconds: Math.ceil(req.timeout_ms / 1000) + 60,
        }),
      });
    } catch {
      // proxy unreachable — soft fail.
    }

    await container.start();

    // 6. Walltime: kill from outside on timeout. We do NOT trust the
    //    entrypoint to police itself — generated code could shadow setTimeout.
    let timedOut = false;
    const timeoutMs = Math.max(1, req.timeout_ms);
    const killTimer = setTimeout(() => {
      timedOut = true;
      // SIGKILL — not SIGTERM. The generated code could catch SIGTERM.
      container.kill({ signal: "SIGKILL" }).catch(() => {
        /* container may have already exited */
      });
    }, timeoutMs);

    let exitCode: number | null = null;
    try {
      const exit = (await container.wait()) as { StatusCode: number };
      exitCode = exit.StatusCode;
    } catch {
      // wait can throw if the container was already removed by AutoRemove
      // after a kill. That's fine — we'll mark as failed/timeout below.
      exitCode = null;
    } finally {
      clearTimeout(killTimer);
    }

    const durationMs = Date.now() - startTime;

    // 7. Pull the egress call log from the proxy by correlation id.
    //    The proxy is the source of truth for what actually went out —
    //    we never trust anything the sandbox emits about its own egress.
    let egressCalls: EgressCall[] = [];
    let proxyReachable = true;
    try {
      const url = `${egressProxyLogBase.replace(/\/+$/, "")}/${correlationId}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const body = (await resp.json()) as EgressCall[];
        if (Array.isArray(body)) egressCalls = body;
      } else {
        proxyReachable = false;
      }
    } catch {
      proxyReachable = false;
    }

    // 8. Cleanup the host tmpdir. AutoRemove handles the container.
    await rm(hostTmpDir, { recursive: true, force: true }).catch(() => {});

    // 9. Decide final status.
    //    - timedOut wins regardless of exit code.
    //    - If we required the proxy and could not reach it, treat as failed
    //      rather than reporting a clean run with empty egress.
    let status: SandboxResult["status"];
    if (timedOut) {
      status = "timeout";
    } else if (exitCode === 0) {
      status = "succeeded";
    } else {
      status = "failed";
    }

    if (
      (this.opts.failClosedOnProxy ?? DEFAULTS.failClosedOnProxy) &&
      !proxyReachable &&
      status === "succeeded"
    ) {
      status = "failed";
      stderr +=
        "\n[sandbox] proxy log unreachable; failing closed to avoid silent unobserved egress.\n";
    }

    const outputPayload = extractLastJsonLine(stdout);

    return {
      status,
      stdout,
      stderr,
      exit_code: timedOut ? null : exitCode,
      duration_ms: durationMs,
      egress_calls: egressCalls,
      source_sha256: sha256,
      output_payload: outputPayload,
    };
  }
}

/**
 * Pull the last well-formed JSON object/array out of stdout. The entrypoint
 * is expected to emit a single line like `{"ok":true,"output":...}` last.
 * We scan from the bottom so user `console.log`s before the final result
 * don't fool us.
 */
export function extractLastJsonLine(s: string): string | null {
  if (!s) return null;
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    if (!(line.startsWith("{") || line.startsWith("["))) continue;
    try {
      JSON.parse(line);
      return line;
    } catch {
      // keep scanning upward
    }
  }
  return null;
}
