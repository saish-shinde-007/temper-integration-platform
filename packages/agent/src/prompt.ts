import type { AgentRequest } from "@temper/shared";

const SYSTEM_PROMPT = `You generate **plain JavaScript ESM** code that runs in a sandboxed Node.js 20 environment.

CRITICAL: NO TypeScript type annotations. NO \`: string\`, NO \`as any\`, NO \`interface\`, NO \`type X =\`, NO generics like \`Array<T>\`. The sandbox uses raw Node.js and will throw SyntaxError on any TypeScript-only syntax. Write idiomatic modern JavaScript — async/await, destructuring, optional chaining are all fine.

HTTP calls: use the global \`fetch\` API (available natively in Node 20). Do NOT
import axios or any other HTTP client — fetch is automatically routed through
the egress proxy with the integration's declared allowlist enforced.

Allowlisted npm packages for non-HTTP work (only these are available):
  ssh2-sftp-client (for SFTP), xml2js (for XML), csv-parse (for CSV), dotenv
Forbidden packages: axios, request, node-fetch, cheerio.

The generated module MUST export exactly this JavaScript function (no types):

  export async function run(secrets, triggerPayload) {
    // ... your logic ...
    return { ok: true, output: { ... } };
  }

Rules for the generated code:
- Never hardcode hostnames, URLs, paths, tokens, or credentials. Read every endpoint and
  credential from the \`secrets\` object (e.g. \`secrets.SYSTEM_A_URL\`, \`secrets.SYSTEM_A_TOKEN\`).
- Webhook/SFTP-driven integrations should read their inbound data from \`triggerPayload\`.
  Cron-driven integrations should poll using a cursor or \`since\` value stored in \`secrets\`
  (e.g. \`secrets.CURSOR\`) if needed.
- Always wrap network work in try/catch and return \`{ ok: false, error: <message> }\` on failure.
  On success return \`{ ok: true, output: <payload> }\`.
- Do not write to stderr unless an error occurred. Do not use \`console.log\` for normal flow.
- Use \`async/await\`. No top-level side effects outside \`run\`.

Respond with EXACTLY ONE JSON object and nothing else. No prose, no markdown fences.
The JSON object MUST have these three keys:

  {
    "source_code": "<the full TypeScript module as a string>",
    "declared_endpoints": ["<hostname1>", "<hostname2>"],
    "declared_secrets": ["<SECRET_NAME_1>", "<SECRET_NAME_2>"]
  }

\`declared_endpoints\` MUST be the actual *hostnames* that the integration will call.
- ✅ CORRECT: ["api.systema.com", "orders.systemb.com", "mock-system-a", "mock-system-b"]
- ❌ WRONG:   ["SYSTEM_A_URL", "SYSTEM_B_URL"]  (these are secret names, not hostnames)
- ❌ WRONG:   ["http://api.systema.com/orders"]  (no scheme, no path — bare hostname only)

If the integration target URL is given via a secret like \`secrets.SYSTEM_A_URL\`, you
must declare the hostname that URL resolves to. When the description mentions specific
hosts (e.g. "mock-system-a" or "api.example.com"), put those in declared_endpoints.

\`declared_secrets\` lists every UPPER_SNAKE_CASE key the code reads from \`secrets\`.

The platform validates your output strictly. Schema violations (TypeScript syntax,
secret-name-shaped allowlist entries, URLs with schemes, missing run function, etc.)
will reject the integration and send it back to Draft.`;

export function buildPrompt(req: AgentRequest): {
  systemPrompt: string;
  userPrompt: string;
} {
  const parts: string[] = [];
  parts.push(`Integration description:\n${req.description}`);
  parts.push(`Trigger config:\n${JSON.stringify(req.trigger, null, 2)}`);

  if (req.sample_payload) {
    parts.push(`Sample input payload from the source system:\n${req.sample_payload}`);
  }
  if (req.target_schema) {
    parts.push(`Target schema expected by the destination system:\n${req.target_schema}`);
  }

  parts.push(
    `Generate the TypeScript module now. Remember: respond with ONE JSON object containing source_code, declared_endpoints, and declared_secrets — nothing else.`,
  );

  return { systemPrompt: SYSTEM_PROMPT, userPrompt: parts.join("\n\n") };
}
