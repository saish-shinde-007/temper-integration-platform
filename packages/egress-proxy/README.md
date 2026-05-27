# @temper/egress-proxy

Network gate for the sandbox. The sandbox container runs on a docker network
where the only reachable address is this proxy. Untrusted LLM-generated code
makes its HTTP calls through us; we enforce a per-execution hostname
allowlist and log every call (allowed or blocked).

## How the sandbox talks to us

We use a **header-based forwarding convention** (chosen over a real
HTTP CONNECT proxy for demo simplicity — see TODO at the bottom).

The sandbox's generated code uses a small helper that wraps fetch:

```typescript
async function fetchViaProxy(
  url: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const proxyUrl = process.env.HTTP_PROXY!;        // e.g. http://egress-proxy:5080
  const executionId = process.env.EXECUTION_ID!;
  return fetch(`${proxyUrl}/proxy/${executionId}`, {
    method: options.method ?? "GET",
    headers: {
      ...options.headers,
      "X-Target-URL": url,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}
```

The proxy reads `X-Target-URL`, parses its hostname, checks the execution's
allowlist, and either forwards (via undici) or returns 403 with a JSON body
explaining why. Every attempt is recorded.

## Endpoints

| Method  | Path                          | Purpose                                                |
| ------- | ----------------------------- | ------------------------------------------------------ |
| POST    | `/execution`                  | Register `{ executionId, allowlist[], ttl_seconds? }`  |
| DELETE  | `/execution/:executionId`     | Tear down execution state                              |
| GET     | `/log/:executionId`           | Returns `EgressCall[]` for that execution              |
| ANY     | `/proxy/:executionId[/*]`     | Forward target named in `X-Target-URL` header          |
| GET     | `/healthz`                    | Health probe                                           |

State lives in memory only. Default TTL is 5 minutes (configurable per
execution); a background sweeper drops expired entries.

## Allowlist syntax

Hostnames are matched case-insensitively. Two pattern forms are supported:

- **Exact**: `api.systema.test` matches `api.systema.test` and nothing else.
- **Wildcard prefix**: `*.systema.test` matches `systema.test`,
  `api.systema.test`, `v2.systema.test`, `a.b.systema.test`. It does NOT
  match `notsystema.test` or `systema.test.evil.com`.

IPs are matched as opaque strings (so `127.0.0.1` works as an exact entry).

## Logging

Every forward attempt produces an `EgressCall` (see `@temper/shared`):

```ts
{
  timestamp: string;
  method: string;
  url: string;
  status_code: number | null;  // null when blocked
  blocked: boolean;
  reason?: string;             // populated when blocked
}
```

## Env

- `EGRESS_PROXY_PORT` — listen port (default `5080`)

## Development

```bash
pnpm --filter @temper/egress-proxy dev      # tsx watch
pnpm --filter @temper/egress-proxy build    # tsc
pnpm --filter @temper/egress-proxy test     # node:test via tsx
pnpm --filter @temper/egress-proxy start    # node dist/index.js
```

## TODO: real CONNECT proxy

For production we'd swap the header-based scheme for a real HTTP CONNECT
proxy so existing `HTTP_PROXY=...` clients (axios, native fetch via undici's
ProxyAgent, requests in other languages) work unmodified. That requires
parsing the CONNECT method, peeking the SNI on the TLS handshake to enforce
the allowlist, then transparently tunneling. The header convention here is
adequate for the integration platform demo because the agent-generated code
is the only HTTP consumer in the sandbox and we control its shape.
