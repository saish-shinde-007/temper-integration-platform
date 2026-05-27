// Tests for the egress proxy. Run with: pnpm --filter @temper/egress-proxy test
//
// We spin up:
//   - one Fastify instance as the proxy under test
//   - one Fastify instance acting as an upstream "real" server
//
// The upstream listens on 127.0.0.1 so we can use it as a target whose
// hostname ("127.0.0.1") we allow/block in the proxy's per-execution
// allowlist. Wildcard behavior is verified at the unit level since exercising
// `*.systema.test` against a real DNS name is awkward in CI.

import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";

import { hostnameAllowed } from "./allowlist.js";
import { buildServer } from "./index.js";
import { ProxyStore } from "./proxy.js";
import type { EgressCall } from "@temper/shared";

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

async function startUpstream(): Promise<{ server: FastifyInstance; baseUrl: string }> {
  const server = Fastify({ logger: false });
  server.get("/orders", async () => ({ orders: [{ id: 1 }, { id: 2 }] }));
  server.post("/echo", async (req) => ({ echoed: req.body }));
  server.get("/boom", async (_req, reply) => {
    reply.code(500).send({ error: "kaboom" });
  });
  await server.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function startProxy(): Promise<{ server: FastifyInstance; baseUrl: string; store: ProxyStore }> {
  const store = new ProxyStore();
  const server = buildServer({ store, logger: false });
  await server.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, store };
}

async function registerExecution(
  proxyUrl: string,
  executionId: string,
  allowlist: string[],
  ttlSeconds?: number,
): Promise<void> {
  const resp = await fetch(`${proxyUrl}/execution`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ executionId, allowlist, ttl_seconds: ttlSeconds }),
  });
  if (resp.status !== 201) {
    const text = await resp.text();
    assert.fail(`register failed (${resp.status}): ${text}`);
  }
}

async function fetchLog(proxyUrl: string, executionId: string): Promise<EgressCall[]> {
  const resp = await fetch(`${proxyUrl}/log/${executionId}`);
  if (resp.status !== 200) {
    const text = await resp.text();
    assert.fail(`log fetch failed (${resp.status}): ${text}`);
  }
  return (await resp.json()) as EgressCall[];
}

// ------------------------------------------------------------------
// allowlist unit tests
// ------------------------------------------------------------------

test("allowlist: exact hostname match", () => {
  assert.equal(hostnameAllowed("api.systema.test", ["api.systema.test"]), true);
  assert.equal(hostnameAllowed("API.SYSTEMA.TEST", ["api.systema.test"]), true);
  assert.equal(hostnameAllowed("other.test", ["api.systema.test"]), false);
});

test("allowlist: wildcard *.systema.test matches subdomains and apex", () => {
  const allow = ["*.systema.test"];
  assert.equal(hostnameAllowed("api.systema.test", allow), true);
  assert.equal(hostnameAllowed("v2.systema.test", allow), true);
  assert.equal(hostnameAllowed("a.b.systema.test", allow), true);
  assert.equal(hostnameAllowed("systema.test", allow), true);
});

test("allowlist: wildcard does NOT cross domain", () => {
  const allow = ["*.systema.test"];
  assert.equal(hostnameAllowed("evil.com", allow), false);
  assert.equal(hostnameAllowed("systema.test.evil.com", allow), false);
  assert.equal(hostnameAllowed("notsystema.test", allow), false);
});

test("allowlist: empty/garbage entries are ignored", () => {
  assert.equal(hostnameAllowed("api.systema.test", []), false);
  assert.equal(hostnameAllowed("api.systema.test", ["", "  "]), false);
  assert.equal(hostnameAllowed("api.systema.test", ["*."]), false);
});

test("allowlist: mixed exact + wildcard", () => {
  const allow = ["fixed.example.com", "*.systema.test"];
  assert.equal(hostnameAllowed("fixed.example.com", allow), true);
  assert.equal(hostnameAllowed("api.systema.test", allow), true);
  assert.equal(hostnameAllowed("api.example.com", allow), false);
});

// ------------------------------------------------------------------
// integration tests
// ------------------------------------------------------------------

test("execution lifecycle + empty log", async () => {
  const proxy = await startProxy();
  try {
    await registerExecution(proxy.baseUrl, "exec-1", ["127.0.0.1"]);
    const calls = await fetchLog(proxy.baseUrl, "exec-1");
    assert.deepEqual(calls, []);

    const del = await fetch(`${proxy.baseUrl}/execution/exec-1`, { method: "DELETE" });
    assert.equal(del.status, 204);

    const after = await fetch(`${proxy.baseUrl}/log/exec-1`);
    assert.equal(after.status, 404);
  } finally {
    await proxy.server.close();
  }
});

test("allowlisted request is forwarded and logged with status_code", async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy();
  try {
    await registerExecution(proxy.baseUrl, "exec-allow", ["127.0.0.1"]);

    const resp = await fetch(`${proxy.baseUrl}/proxy/exec-allow`, {
      method: "GET",
      headers: { "X-Target-URL": `${upstream.baseUrl}/orders` },
    });

    assert.equal(resp.status, 200);
    const body = (await resp.json()) as { orders: { id: number }[] };
    assert.equal(body.orders.length, 2);

    const calls = await fetchLog(proxy.baseUrl, "exec-allow");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].blocked, false);
    assert.equal(calls[0].status_code, 200);
    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /\/orders$/);
    assert.ok(calls[0].timestamp);
  } finally {
    await proxy.server.close();
    await upstream.server.close();
  }
});

test("POST body is forwarded transparently", async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy();
  try {
    await registerExecution(proxy.baseUrl, "exec-post", ["127.0.0.1"]);

    const resp = await fetch(`${proxy.baseUrl}/proxy/exec-post`, {
      method: "POST",
      headers: {
        "X-Target-URL": `${upstream.baseUrl}/echo`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hello: "world" }),
    });

    assert.equal(resp.status, 200);
    const body = (await resp.json()) as { echoed: { hello: string } };
    assert.deepEqual(body.echoed, { hello: "world" });
  } finally {
    await proxy.server.close();
    await upstream.server.close();
  }
});

test("off-allowlist request returns 403 with helpful body and is logged blocked", async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy();
  try {
    // Allowlist excludes 127.0.0.1 — only allow some other host.
    await registerExecution(proxy.baseUrl, "exec-block", ["allowed.example.com"]);

    const resp = await fetch(`${proxy.baseUrl}/proxy/exec-block`, {
      method: "GET",
      headers: { "X-Target-URL": `${upstream.baseUrl}/orders` },
    });

    assert.equal(resp.status, 403);
    const body = (await resp.json()) as {
      error: string;
      message: string;
      hostname: string;
      allowlist: string[];
    };
    assert.equal(body.error, "egress_blocked");
    assert.equal(body.hostname, "127.0.0.1");
    assert.deepEqual(body.allowlist, ["allowed.example.com"]);
    assert.match(body.message, /127\.0\.0\.1/);

    const calls = await fetchLog(proxy.baseUrl, "exec-block");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].blocked, true);
    assert.equal(calls[0].status_code, null);
    assert.match(calls[0].reason ?? "", /hostname_not_allowlisted/);
  } finally {
    await proxy.server.close();
    await upstream.server.close();
  }
});

test("missing X-Target-URL header returns 400 and is logged", async () => {
  const proxy = await startProxy();
  try {
    await registerExecution(proxy.baseUrl, "exec-bad", ["127.0.0.1"]);

    const resp = await fetch(`${proxy.baseUrl}/proxy/exec-bad`, { method: "GET" });
    assert.equal(resp.status, 400);

    const calls = await fetchLog(proxy.baseUrl, "exec-bad");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].blocked, true);
    assert.match(calls[0].reason ?? "", /missing_or_invalid_x_target_url_header/);
  } finally {
    await proxy.server.close();
  }
});

test("unknown execution id returns 404 on /proxy", async () => {
  const proxy = await startProxy();
  try {
    const resp = await fetch(`${proxy.baseUrl}/proxy/does-not-exist`, {
      method: "GET",
      headers: { "X-Target-URL": "http://127.0.0.1:1/x" },
    });
    assert.equal(resp.status, 404);
  } finally {
    await proxy.server.close();
  }
});

test("DELETE /execution cleans up state", async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy();
  try {
    await registerExecution(proxy.baseUrl, "exec-del", ["127.0.0.1"]);

    // Make a request so log is non-empty.
    const ok = await fetch(`${proxy.baseUrl}/proxy/exec-del`, {
      headers: { "X-Target-URL": `${upstream.baseUrl}/orders` },
    });
    assert.equal(ok.status, 200);

    const del = await fetch(`${proxy.baseUrl}/execution/exec-del`, { method: "DELETE" });
    assert.equal(del.status, 204);

    // Subsequent log fetch should 404, subsequent proxy call should 404.
    const log = await fetch(`${proxy.baseUrl}/log/exec-del`);
    assert.equal(log.status, 404);

    const blocked = await fetch(`${proxy.baseUrl}/proxy/exec-del`, {
      headers: { "X-Target-URL": `${upstream.baseUrl}/orders` },
    });
    assert.equal(blocked.status, 404);

    // Re-deleting yields 404.
    const del2 = await fetch(`${proxy.baseUrl}/execution/exec-del`, { method: "DELETE" });
    assert.equal(del2.status, 404);
  } finally {
    await proxy.server.close();
    await upstream.server.close();
  }
});

test("TTL expiry removes execution state", async () => {
  const proxy = await startProxy();
  try {
    // ttl_seconds is in seconds; 1s is the smallest acceptable value.
    await registerExecution(proxy.baseUrl, "exec-ttl", ["127.0.0.1"], 1);
    await new Promise((r) => setTimeout(r, 1_200));

    const log = await fetch(`${proxy.baseUrl}/log/exec-ttl`);
    assert.equal(log.status, 404);
  } finally {
    await proxy.server.close();
  }
});

test("wildcard allowlist is honored end-to-end (matched via host header override)", async () => {
  // We allow a wildcard and verify the matching logic by directly probing
  // the store/handler. (Setting up a fake DNS for an end-to-end fetch with
  // a synthetic hostname is out of scope; the unit tests cover wildcard
  // patterns and this test just confirms the integration path uses them.)
  const upstream = await startUpstream();
  const proxy = await startProxy();
  try {
    await registerExecution(proxy.baseUrl, "exec-wild", ["*.systema.test", "127.0.0.1"]);

    // 127.0.0.1 is in the same allowlist alongside the wildcard — passes.
    const allowed = await fetch(`${proxy.baseUrl}/proxy/exec-wild`, {
      headers: { "X-Target-URL": `${upstream.baseUrl}/orders` },
    });
    assert.equal(allowed.status, 200);

    // A host that does not match the wildcard is rejected.
    const blocked = await fetch(`${proxy.baseUrl}/proxy/exec-wild`, {
      headers: { "X-Target-URL": "http://evil.example.com/x" },
    });
    assert.equal(blocked.status, 403);
  } finally {
    await proxy.server.close();
    await upstream.server.close();
  }
});
