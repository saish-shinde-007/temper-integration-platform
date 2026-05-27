// Proxy forwarding logic and in-memory execution state.
//
// We use header-based forwarding (see README): the sandbox's HTTP client
// posts to /proxy/:executionId with a `X-Target-URL` header naming the real
// destination. We look up the execution's allowlist, hostname-check the
// target, and either forward via undici or return 403.

import type { FastifyReply, FastifyRequest } from "fastify";
import { request as undiciRequest } from "undici";
import type { EgressCall } from "@temper/shared";
import { hostnameAllowed } from "./allowlist.js";

export interface ExecutionState {
  executionId: string;
  allowlist: string[];
  calls: EgressCall[];
  createdAt: number;
  expiresAt: number;
}

const DEFAULT_TTL_SECONDS = 5 * 60;

// Headers we strip from the inbound request before forwarding upstream.
// Hop-by-hop headers + proxy-control headers must not be relayed.
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
  "x-target-url",
  "content-length", // undici recomputes
]);

// Headers we strip from the upstream response before relaying to the client.
const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
]);

export class ProxyStore {
  private executions = new Map<string, ExecutionState>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly clockMs: () => number = Date.now) {}

  startSweeper(intervalMs = 30_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweepExpired(), intervalMs);
    // Don't keep the event loop alive just for the sweeper.
    this.sweeper.unref?.();
  }

  stopSweeper(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  register(executionId: string, allowlist: string[], ttlSeconds?: number): ExecutionState {
    const ttl = (ttlSeconds && ttlSeconds > 0 ? ttlSeconds : DEFAULT_TTL_SECONDS) * 1000;
    const now = this.clockMs();
    const state: ExecutionState = {
      executionId,
      allowlist: [...allowlist],
      calls: [],
      createdAt: now,
      expiresAt: now + ttl,
    };
    this.executions.set(executionId, state);
    return state;
  }

  get(executionId: string): ExecutionState | undefined {
    const state = this.executions.get(executionId);
    if (!state) return undefined;
    if (state.expiresAt <= this.clockMs()) {
      this.executions.delete(executionId);
      return undefined;
    }
    return state;
  }

  delete(executionId: string): boolean {
    return this.executions.delete(executionId);
  }

  size(): number {
    return this.executions.size;
  }

  sweepExpired(): number {
    const now = this.clockMs();
    let removed = 0;
    for (const [id, state] of this.executions) {
      if (state.expiresAt <= now) {
        this.executions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

// Parse the target URL header. Returns null on missing/malformed input.
function parseTargetUrl(raw: string | string[] | undefined): URL | null {
  if (!raw) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function sanitizeRequestHeaders(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function relayResponseHeaders(reply: FastifyReply, headers: Record<string, string | string[] | undefined>): void {
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
    reply.header(k, v);
  }
}

export interface HandleProxyOptions {
  // Allow tests to substitute the upstream HTTP client.
  fetcher?: typeof undiciRequest;
  // Allow tests to inject a fixed clock for deterministic timestamps.
  now?: () => Date;
}

export async function handleProxyRequest(
  store: ProxyStore,
  executionId: string,
  req: FastifyRequest,
  reply: FastifyReply,
  opts: HandleProxyOptions = {},
): Promise<void> {
  const fetcher = opts.fetcher ?? undiciRequest;
  const now = opts.now ?? (() => new Date());

  const state = store.get(executionId);
  if (!state) {
    reply.code(404).send({ error: "unknown_execution", executionId });
    return;
  }

  const target = parseTargetUrl(req.headers["x-target-url"]);
  if (!target) {
    const call: EgressCall = {
      timestamp: now().toISOString(),
      method: req.method,
      url: "",
      status_code: null,
      blocked: true,
      reason: "missing_or_invalid_x_target_url_header",
    };
    state.calls.push(call);
    reply.code(400).send({
      error: "missing_or_invalid_target_url",
      message:
        "Set the X-Target-URL header to the absolute http(s) URL you want to call. " +
        "Example: X-Target-URL: https://api.systema.test/orders",
    });
    return;
  }

  if (!hostnameAllowed(target.hostname, state.allowlist)) {
    const reason = `hostname_not_allowlisted:${target.hostname}`;
    const call: EgressCall = {
      timestamp: now().toISOString(),
      method: req.method,
      url: target.toString(),
      status_code: null,
      blocked: true,
      reason,
    };
    state.calls.push(call);
    reply.code(403).send({
      error: "egress_blocked",
      message: `Host '${target.hostname}' is not in the allowlist for execution ${executionId}.`,
      hostname: target.hostname,
      allowlist: state.allowlist,
    });
    return;
  }

  // Forward.
  const headers = sanitizeRequestHeaders(req);
  // Set Host header to the target so virtual-hosted servers route correctly.
  headers["host"] = target.host;

  // Fastify has buffered the inbound body for us (see index.ts —
  // we register a `*` content-type parser that returns the raw Buffer).
  // For body-bearing methods we forward that buffer to undici; for
  // GET/HEAD/OPTIONS we send no body. Forwarding as a Buffer (not a
  // stream) avoids the "raw stream already consumed" pitfall and works
  // uniformly for JSON, binary, and form payloads.
  const methodsWithoutBody = new Set(["GET", "HEAD", "OPTIONS"]);
  const hasBody = !methodsWithoutBody.has(req.method.toUpperCase());
  const body: Buffer | undefined = hasBody
    ? Buffer.isBuffer(req.body)
      ? (req.body as Buffer)
      : req.body === undefined || req.body === null
        ? undefined
        : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body))
    : undefined;

  try {
    const upstream = await fetcher(target.toString(), {
      method: req.method as any,
      headers,
      body,
      // We let undici follow no redirects automatically — the proxy should
      // surface 3xx to the caller so the sandbox makes a fresh allowlisted
      // request for the redirect target.
      maxRedirections: 0,
      throwOnError: false,
    });

    const call: EgressCall = {
      timestamp: now().toISOString(),
      method: req.method,
      url: target.toString(),
      status_code: upstream.statusCode,
      blocked: false,
    };
    state.calls.push(call);

    // Buffer the upstream body before relaying so Fastify's reply.send
    // sees a Buffer (deterministic, no half-closed-stream weirdness).
    const responseBuf = Buffer.from(await upstream.body.arrayBuffer());
    reply.code(upstream.statusCode);
    relayResponseHeaders(reply, upstream.headers as Record<string, string | string[] | undefined>);
    reply.send(responseBuf);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const call: EgressCall = {
      timestamp: now().toISOString(),
      method: req.method,
      url: target.toString(),
      status_code: null,
      blocked: true,
      reason: `upstream_error:${message}`,
    };
    state.calls.push(call);
    reply.code(502).send({
      error: "upstream_unreachable",
      message: `Failed to reach ${target.toString()}: ${message}`,
    });
  }
}
