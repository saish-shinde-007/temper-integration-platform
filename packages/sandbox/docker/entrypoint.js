// In-container entrypoint. Runs as uid 10001 with a read-only rootfs.
//
// Responsibilities:
//   1. Dynamic-import /code/main.mjs (host bind-mount, read-only).
//   2. Collect secrets from SECRET_<NAME> env vars.
//   3. Decode TRIGGER_PAYLOAD JSON.
//   4. Invoke module.run(secrets, triggerPayload).
//   5. Emit exactly one final JSON line: {"ok":bool,"output":...,"error":...}
//   6. Exit 0 on success, 1 on failure. Walltime is enforced from outside.
//
// We deliberately do NOT try to police the payload at runtime (no vm2, no
// AsyncResource introspection). The isolation contract is enforced by the
// kernel (seccomp + cgroups + read-only fs + dropped caps + non-root user),
// not by JS-level wrappers that the payload could shadow.

const CODE_PATH = "/code/main.mjs";

// Monkey-patch globalThis.fetch so EVERY HTTP call from the integration code
// is rewritten to go through the egress proxy with X-Target-URL. This is the
// enforcement bridge between "user wrote fetch(url)" and the egress allowlist.
//
// The proxy expects POST /proxy/<executionId> with X-Target-URL header.
// Calls from inside the sandbox have no other route out (NetworkMode=temper-net
// + the proxy is the only thing on it that goes upstream).
const EGRESS_PROXY = process.env.HTTP_PROXY || "";
const EXECUTION_ID = process.env.EXECUTION_ID || "";

if (EGRESS_PROXY && EXECUTION_ID && typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function temperProxyFetch(input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    // Don't recurse if a payload directly hits the proxy (loopback safety).
    if (url.startsWith(EGRESS_PROXY)) {
      return originalFetch(input, init);
    }
    const opts = init || {};
    const headers = new Headers(opts.headers || {});
    headers.set("X-Target-URL", url);
    return originalFetch(
      `${EGRESS_PROXY}/proxy/${EXECUTION_ID}`,
      {
        method: opts.method || "GET",
        headers,
        body: opts.body,
        signal: opts.signal,
      },
    );
  };
}

/** Collect SECRET_FOO=bar env into { FOO: "bar" }. */
function collectSecrets() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SECRET_") && typeof v === "string") {
      out[k.slice("SECRET_".length)] = v;
    }
  }
  return out;
}

function parseTriggerPayload() {
  const raw = process.env.TRIGGER_PAYLOAD;
  if (!raw || raw === "null" || raw === "undefined") return null;
  try {
    return JSON.parse(raw);
  } catch {
    // If the host sent us a non-JSON payload, surface the raw string rather
    // than crashing — generated code may want to handle it.
    return raw;
  }
}

/** Single-line JSON result. We pin to one line so the host can grep stdout. */
function emit(result) {
  // No trailing whitespace inside the JSON; newline terminator only.
  process.stdout.write(JSON.stringify(result) + "\n");
}

async function main() {
  const secrets = collectSecrets();
  const triggerPayload = parseTriggerPayload();

  let mod;
  try {
    mod = await import(CODE_PATH);
  } catch (err) {
    emit({
      ok: false,
      output: null,
      error: {
        kind: "ImportError",
        message: err && err.message ? String(err.message) : String(err),
        stack: err && err.stack ? String(err.stack) : null,
      },
    });
    process.exit(1);
  }

  const run = mod && (mod.run || (mod.default && mod.default.run));
  if (typeof run !== "function") {
    emit({
      ok: false,
      output: null,
      error: {
        kind: "ContractError",
        message:
          "Module did not export a `run` function. Expected `export async function run(secrets, triggerPayload) { ... }`.",
        stack: null,
      },
    });
    process.exit(1);
  }

  try {
    const output = await run(secrets, triggerPayload);
    emit({ ok: true, output: output ?? null, error: null });
    process.exit(0);
  } catch (err) {
    emit({
      ok: false,
      output: null,
      error: {
        kind: err && err.name ? String(err.name) : "Error",
        message: err && err.message ? String(err.message) : String(err),
        stack: err && err.stack ? String(err.stack) : null,
      },
    });
    process.exit(1);
  }
}

// Last-ditch handlers so an unhandled rejection still produces a structured
// result line instead of an empty stdout.
process.on("uncaughtException", (err) => {
  emit({
    ok: false,
    output: null,
    error: {
      kind: "UncaughtException",
      message: err && err.message ? String(err.message) : String(err),
      stack: err && err.stack ? String(err.stack) : null,
    },
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  emit({
    ok: false,
    output: null,
    error: {
      kind: "UnhandledRejection",
      message:
        reason && reason.message ? String(reason.message) : String(reason),
      stack: reason && reason.stack ? String(reason.stack) : null,
    },
  });
  process.exit(1);
});

main();
