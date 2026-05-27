// Malicious-snippet tests for the SandboxExecutor.
//
// These run real containers via dockerode against the temper-sandbox-base
// image. They are skipped automatically if Docker isn't reachable, so they
// won't break CI on dev laptops without a daemon.
//
// Before running: `pnpm --filter @temper/sandbox docker:build` and ensure
// a `temper-net` docker network exists:
//   docker network create temper-net
//
// Then: `pnpm --filter @temper/sandbox test`

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Docker from "dockerode";

import { SandboxExecutor, extractLastJsonLine } from "./executor.js";
import type { EgressCall } from "@temper/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SECCOMP_PATH = join(__dirname, "..", "docker", "seccomp.json");

/** Quick probe so tests skip cleanly when Docker isn't around. */
async function dockerAvailable(): Promise<boolean> {
  if (
    !existsSync("/var/run/docker.sock") &&
    !process.env.DOCKER_HOST
  ) {
    return false;
  }
  try {
    const d = new Docker();
    await d.ping();
    return true;
  } catch {
    return false;
  }
}

function makeExecutor() {
  const docker = new Docker();
  return new SandboxExecutor(docker, {
    baseImage: process.env.TEMPER_SANDBOX_IMAGE ?? "temper-sandbox-base:latest",
    seccompProfilePath: SECCOMP_PATH,
    memoryMb: 256,
    cpu: 0.5,
    pidsLimit: 64,
    networkName: process.env.TEMPER_SANDBOX_NETWORK ?? "temper-net",
    // Tests do not require the egress proxy to be live.
    failClosedOnProxy: false,
  });
}

// Pure helper test — runs everywhere, no Docker required.
test("extractLastJsonLine pulls the final JSON line from stdout", () => {
  const stdout = [
    "[user log] starting",
    "intermediate noise",
    '{"ok":true,"output":"hello","error":null}',
    "",
  ].join("\n");
  assert.equal(
    extractLastJsonLine(stdout),
    '{"ok":true,"output":"hello","error":null}',
  );

  assert.equal(extractLastJsonLine(""), null);
  assert.equal(extractLastJsonLine("not json at all\n"), null);
  // Garbage between valid lines: still finds the last valid one.
  assert.equal(
    extractLastJsonLine('{"a":1}\nnoise\n{"b":2}\n'),
    '{"b":2}',
  );
});

// ---- Docker-backed integration tests ----

const dockerReady = await dockerAvailable();
const dockerGuard = { skip: !dockerReady };

test(
  "happy path: module.run resolves and output_payload is populated",
  dockerGuard,
  async () => {
    const ex = makeExecutor();
    const result = await ex.run({
      source_code: `
        export async function run(secrets, trigger) {
          return { ok: true, output: 'hello', got_trigger: trigger };
        }
      `,
      declared_endpoints: [],
      secrets: {},
      timeout_ms: 10_000,
      memory_mb: 256,
      trigger_payload: { hi: "there" },
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.exit_code, 0);
    assert.ok(result.output_payload, "expected output_payload to be set");
    const parsed = JSON.parse(result.output_payload!);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.output.output, "hello");
    assert.deepEqual(parsed.output.got_trigger, { hi: "there" });
    // sha256 of the source we sent in, deterministic.
    assert.equal(result.source_sha256.length, 64);
  },
);

test(
  "timeout: infinite loop is SIGKILLed by the host",
  dockerGuard,
  async () => {
    const ex = makeExecutor();
    const result = await ex.run({
      source_code: `
        export async function run() {
          // Tight CPU loop; ignores SIGTERM. Only SIGKILL stops it.
          while (true) {
            // no-op
          }
        }
      `,
      declared_endpoints: [],
      secrets: {},
      timeout_ms: 1_500,
      memory_mb: 256,
    });

    assert.equal(result.status, "timeout");
    assert.equal(result.exit_code, null);
    assert.ok(
      result.duration_ms >= 1_400,
      `expected duration >= timeout, got ${result.duration_ms}ms`,
    );
  },
);

test(
  "filesystem: writing to root is rejected by read-only rootfs",
  dockerGuard,
  async () => {
    const ex = makeExecutor();
    const result = await ex.run({
      source_code: `
        import fs from 'node:fs';
        export async function run() {
          fs.writeFileSync('/etc/passwd_evil', 'pwn');
          return { ok: true };
        }
      `,
      declared_endpoints: [],
      secrets: {},
      timeout_ms: 5_000,
      memory_mb: 256,
    });

    assert.equal(result.status, "failed");
    assert.notEqual(result.exit_code, 0);
    // The final result line should encode an error.
    assert.ok(result.output_payload, "expected an error result payload");
    const parsed = JSON.parse(result.output_payload!);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.error, "expected error object in result");
    // ENOENT / EROFS / EACCES are all acceptable — the point is "no write".
    assert.match(
      String(parsed.error.message),
      /EROFS|EACCES|read-only|ENOENT/i,
      `unexpected error message: ${parsed.error.message}`,
    );
  },
);

test(
  "memory: large allocation is OOM-killed (or rejected by V8 heap cap)",
  { ...dockerGuard, skip: dockerGuard.skip || process.env.SKIP_HEAVY === "1" },
  async () => {
    const ex = makeExecutor();
    const result = await ex.run({
      source_code: `
        export async function run() {
          // ~2GB buffer; far above the 256MB cgroup cap.
          const huge = Buffer.alloc(2 * 1024 * 1024 * 1024);
          return { len: huge.length };
        }
      `,
      declared_endpoints: [],
      secrets: {},
      timeout_ms: 15_000,
      memory_mb: 256,
    });

    // Either: V8 throws "Array buffer allocation failed" / RangeError (status=failed)
    // Or: the cgroup OOM-kills us before that, exit_code 137 (status=failed).
    // Either way, we must not succeed.
    assert.notEqual(result.status, "succeeded");
  },
);

test(
  "egress: off-allowlist fetch is blocked by the egress proxy",
  // Requires the egress-proxy service to be running on temper-net.
  // Skipped by default; opt in with TEMPER_TEST_EGRESS=1.
  {
    ...dockerGuard,
    skip:
      dockerGuard.skip ||
      process.env.TEMPER_TEST_EGRESS !== "1",
  },
  async () => {
    const ex = makeExecutor();
    const result = await ex.run({
      source_code: `
        import axios from 'axios';
        export async function run() {
          try {
            const r = await axios.get('http://evil.example.com/');
            return { reached: true, status: r.status };
          } catch (e) {
            return { reached: false, message: String(e && e.message) };
          }
        }
      `,
      declared_endpoints: ["http://allowed.example.com"],
      secrets: {},
      timeout_ms: 10_000,
      memory_mb: 256,
    });

    // The call should not have reached evil.example.com.
    assert.ok(result.output_payload, "expected an output payload");
    const parsed = JSON.parse(result.output_payload!);
    if (parsed.ok) {
      assert.equal(parsed.output.reached, false);
    }
    // The proxy should have recorded the blocked attempt.
    const blocked = result.egress_calls.find(
      (c: EgressCall) => c.blocked && c.url.includes("evil.example.com"),
    );
    assert.ok(
      blocked,
      "expected the egress proxy to log a blocked call to evil.example.com",
    );
  },
);
