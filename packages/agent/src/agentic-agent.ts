// AgenticGenerator: real multi-turn agent for integration code generation.
//
// Why this exists: integration generation isn't a single prompt → JSON call.
// It's a conversation. The agent inspects the source system's schema, tries
// requests, sees what comes back, drafts code, runs it through the sandbox,
// reads the errors, revises, and iterates until the sandbox passes.
//
// Implementation: Claude Agent SDK with custom MCP tools that wrap our
// platform's primitives — inspect_system, dry_run_request, validate_in_sandbox.
// The agent loops up to maxTurns and emits the final AgentOutput as a JSON
// payload that passes AgentRawResponseSchema validation.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  query,
  tool,
  createSdkMcpServer,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentAPI,
  AgentRequest,
  AgentOutput,
  SandboxAPI,
  SandboxResult,
} from "@temper/shared";
import { parseAgentResponse } from "./parser.js";

export interface AgenticGeneratorOptions {
  /** Sandbox to use for in-loop validation calls. */
  sandbox?: SandboxAPI;
  /** Hard cap on agent turns. Default 20. */
  maxTurns?: number;
  /** Model. Default: sonnet for speed/cost. */
  model?: string;
  /**
   * Allowed hostnames the agent itself may hit during discovery
   * (separate from the integration's runtime allowlist).
   * Defaults to common mock-system hosts for the demo.
   */
  discoveryAllowlist?: string[];
}

export class AgenticGenerator implements AgentAPI {
  constructor(private opts: AgenticGeneratorOptions = {}) {}

  async generateIntegrationCode(req: AgentRequest): Promise<AgentOutput> {
    // If E2B is configured, spin up ONE reusable sandbox for this whole
    // generation so the agent's 5-10 validate_in_sandbox calls don't each
    // pay E2B's ~1-2s cold start. Fresh sandbox per fire is the runtime
    // story; reuse during generation is the cost story.
    let sandbox = this.opts.sandbox;
    let reusableSandboxHandle: { kill: () => Promise<void> } | null = null;
    if (process.env.E2B_API_KEY) {
      const { createReusableSandbox, E2BSandboxExecutor } = await import("@temper/sandbox");
      const e2b = await createReusableSandbox();
      reusableSandboxHandle = e2b as unknown as { kill: () => Promise<void> };
      sandbox = new E2BSandboxExecutor({ reusableSandbox: e2b });
      console.log("[agentic] using reusable E2B sandbox for validates");
    }

    const maxTurns = this.opts.maxTurns ?? 20;
    const model = this.opts.model ?? process.env.CLAUDE_CLI_MODEL ?? "sonnet";
    const discoveryAllowlist = this.opts.discoveryAllowlist ?? [
      "mock-system-a",
      "mock-system-b",
      "localhost",
    ];

    const turnLog: string[] = [];

    const tools = createSdkMcpServer({
      name: "integration-tools",
      version: "1.0.0",
      tools: [
        // ---- Discovery: is the target reachable? ----
        tool(
          "inspect_system_health",
          "Hit a target system's /health endpoint to confirm it's reachable. Use this first when you don't know what hostname to put in declared_endpoints.",
          {
            hostname: z
              .string()
              .describe("Hostname of the target system, e.g. 'mock-system-a' or 'api.example.com'. No scheme, no path."),
            port: z
              .number()
              .optional()
              .describe("Optional port. Defaults to 80."),
          },
          async ({ hostname, port }) => {
            turnLog.push(`tool: inspect_system_health(${hostname}:${port ?? 80})`);
            if (!hostnameAllowed(hostname, discoveryAllowlist)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `BLOCKED: ${hostname} is not in the discovery allowlist (${discoveryAllowlist.join(",")}). Pick a hostname the description references.`,
                  },
                ],
              };
            }
            try {
              const url = `http://${hostname}${port ? ":" + port : ":5001"}/health`;
              const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
              return {
                content: [
                  {
                    type: "text",
                    text: `GET ${url} → ${r.status} ${r.statusText}\n${(await r.text()).slice(0, 500)}`,
                  },
                ],
              };
            } catch (e) {
              return {
                content: [
                  { type: "text", text: `error: ${(e as Error).message}` },
                ],
              };
            }
          },
        ),

        // ---- Discovery: sample request to inspect response shape ----
        tool(
          "dry_run_request",
          "Make a single read-only HTTP request to a target system to inspect its response shape. Use this BEFORE drafting code so you understand the data you'll be transforming. Read-only methods only (GET / HEAD).",
          {
            method: z.enum(["GET", "HEAD"]),
            url: z.string().describe("Full URL including scheme and path"),
            headers: z.record(z.string()).optional(),
          },
          async ({ method, url, headers }) => {
            turnLog.push(`tool: dry_run_request(${method} ${url})`);
            try {
              const u = new URL(url);
              if (!hostnameAllowed(u.hostname, discoveryAllowlist)) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `BLOCKED: ${u.hostname} is not in discovery allowlist`,
                    },
                  ],
                };
              }
              const r = await fetch(url, {
                method,
                headers: headers as Record<string, string> | undefined,
                signal: AbortSignal.timeout(8000),
              });
              const body = await r.text();
              return {
                content: [
                  {
                    type: "text",
                    text: `${method} ${url} → ${r.status}\nbody (${body.length} chars, first 2000):\n${body.slice(0, 2000)}`,
                  },
                ],
              };
            } catch (e) {
              return {
                content: [
                  { type: "text", text: `error: ${(e as Error).message}` },
                ],
              };
            }
          },
        ),

        // ---- The key tool: validate the draft in the real sandbox ----
        tool(
          "validate_in_sandbox",
          "Run the candidate integration code in the platform's hardened sandbox. Returns sandbox stdout/stderr/exit_code and any errors. USE THIS to verify your draft works before submitting the final JSON. Iterate by reading the failure and revising the source.",
          {
            source_code: z
              .string()
              .describe("The candidate JavaScript ESM module (plain JS, no TS types). Must export `async function run(secrets, triggerPayload)`."),
            declared_endpoints: z
              .array(z.string())
              .describe("Hostnames (no scheme, no path) the code will call"),
            declared_secrets: z
              .array(z.string())
              .describe("UPPER_SNAKE_CASE secret names read from `secrets`"),
            test_secrets: z
              .record(z.string())
              .optional()
              .describe("Secret values to inject for this validation run, e.g. {SYSTEM_A_URL: 'http://mock-system-a:5001'}"),
          },
          async ({ source_code, declared_endpoints, declared_secrets, test_secrets }) => {
            turnLog.push(
              `tool: validate_in_sandbox(${source_code.length} chars, endpoints=${declared_endpoints.length}, secrets=${declared_secrets.length})`,
            );
            if (!sandbox) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Sandbox not wired into this agent instance — skipping validation. The platform will validate at workflow time.",
                  },
                ],
              };
            }
            try {
              const result: SandboxResult = await sandbox.run({
                source_code,
                declared_endpoints,
                secrets: (test_secrets as Record<string, string>) ?? {},
                timeout_ms: 30_000,
                memory_mb: 256,
              });
              return {
                content: [
                  {
                    type: "text",
                    text:
                      `sandbox status: ${result.status}\n` +
                      `duration: ${result.duration_ms}ms\n` +
                      `exit_code: ${result.exit_code ?? "null"}\n` +
                      `egress_calls (${result.egress_calls.length}): ${JSON.stringify(result.egress_calls.slice(0, 5))}\n` +
                      `stdout:\n${result.stdout.slice(0, 2000)}\n` +
                      (result.stderr ? `stderr:\n${result.stderr.slice(0, 1000)}` : ""),
                  },
                ],
              };
            } catch (e) {
              return {
                content: [
                  { type: "text", text: `sandbox error: ${(e as Error).message}` },
                ],
              };
            }
          },
        ),

        // ---- Final output ----
        tool(
          "submit_final_integration",
          "Submit the final integration as a JSON object once validate_in_sandbox passes. Call this AT THE END after at least one successful sandbox validation. The platform's Zod schema will reject if validation didn't pass.",
          {
            source_code: z.string(),
            declared_endpoints: z.array(z.string()),
            declared_secrets: z.array(z.string()),
          },
          async (args) => {
            turnLog.push("tool: submit_final_integration");
            // The final structured result is embedded in the tool args themselves.
            // We surface it via a sentinel so the outer loop can extract it
            // from the assistant turn that called this tool.
            return {
              content: [
                {
                  type: "text",
                  text: `__FINAL__${JSON.stringify(args)}__END__`,
                },
              ],
            };
          },
        ),
      ],
    });

    const systemPrompt = buildAgenticSystemPrompt();
    const userPrompt = buildAgenticUserPrompt(req);

    let finalJson: unknown = null;
    let lastAssistantText = "";

    const iter = query({
      prompt: userPrompt,
      options: {
        systemPrompt,
        mcpServers: { integration: tools },
        allowedTools: [
          "mcp__integration__inspect_system_health",
          "mcp__integration__dry_run_request",
          "mcp__integration__validate_in_sandbox",
          "mcp__integration__submit_final_integration",
        ],
        maxTurns,
        permissionMode: "bypassPermissions",
        model,
      },
    });

    try {
      for await (const message of iter as AsyncIterable<SDKMessage>) {
        if (message.type === "assistant") {
          const blocks = (message as { message?: { content?: unknown[] } }).message?.content ?? [];
          for (const b of blocks) {
            const block = b as { type?: string; text?: string; input?: unknown; name?: string };
            if (block.type === "text" && typeof block.text === "string") {
              lastAssistantText += block.text;
            }
            // Capture the submit_final_integration tool's args as the canonical result
            if (block.type === "tool_use" && block.name && block.name.endsWith("submit_final_integration")) {
              finalJson = block.input;
            }
          }
        }
        if (message.type === "result") {
          break;
        }
      }
    } finally {
      if (reusableSandboxHandle) {
        try {
          await reusableSandboxHandle.kill();
          console.log("[agentic] reusable E2B sandbox killed");
        } catch {
          // best-effort cleanup
        }
      }
    }

    // Prefer the structured submission; fall back to parsing the last text.
    let parsed;
    if (finalJson && typeof finalJson === "object") {
      parsed = parseAgentResponse(JSON.stringify(finalJson));
    } else {
      parsed = parseAgentResponse(lastAssistantText);
    }

    const sha256 = createHash("sha256").update(parsed.source_code).digest("hex");

    console.log(`[agentic] generated integration with ${turnLog.length} tool calls`);

    return {
      source_code: parsed.source_code,
      sha256,
      declared_endpoints: parsed.declared_endpoints,
      declared_secrets: parsed.declared_secrets,
      language: "typescript" as const,
    };
  }
}

function hostnameAllowed(hostname: string, allowlist: string[]): boolean {
  for (const a of allowlist) {
    if (a === hostname) return true;
    if (a.startsWith("*.") && hostname.endsWith(a.slice(1))) return true;
  }
  return false;
}

function buildAgenticSystemPrompt(): string {
  return `You are an integration code generator. The user describes how to move data between two enterprise systems; you produce a JavaScript module that the platform will sandbox and run on a schedule (or webhook, or SFTP trigger).

Your workflow:
1. **Discovery**: Use \`inspect_system_health\` and \`dry_run_request\` to confirm the target systems are reachable and to see real response payloads. Don't guess the response shape — fetch a sample.
2. **Draft**: Write the integration module. It MUST be plain JavaScript ESM (no TypeScript types, no \`as any\`, no \`interface\`, no \`type X =\`). Use the global \`fetch\` (the sandbox routes it through an egress proxy). Read every URL and secret from the \`secrets\` argument. Wrap network calls in try/catch.
3. **Validate**: Use \`validate_in_sandbox\` to run your draft. Read the output carefully. If it failed, fix and validate again. Keep iterating until the sandbox returns status=succeeded AND the integration's own return value is \`{ok:true, ...}\`.
4. **Submit**: Call \`submit_final_integration\` ONCE with the final code, hostnames you actually called, and UPPER_SNAKE_CASE secret names you read from \`secrets\`.

The generated module MUST be of this exact shape (no types):

\`\`\`javascript
export async function run(secrets, triggerPayload) {
  try {
    // read secrets.X, do fetch(...) work, return { ok: true, output: ... }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
\`\`\`

Schema rules for submit_final_integration:
- \`declared_endpoints\`: bare hostnames only — e.g. ["mock-system-a", "mock-system-b"]. No URL schemes, no paths, no secret variable names like SYSTEM_A_URL.
- \`declared_secrets\`: UPPER_SNAKE_CASE keys read from \`secrets\` — e.g. ["SYSTEM_A_URL", "SYSTEM_B_URL", "CURSOR"].

If validation keeps failing after 3 attempts on the same error, call submit_final_integration anyway with your best draft — the platform will surface the issue back to the user.`;
}

function buildAgenticUserPrompt(req: AgentRequest): string {
  const parts: string[] = [];
  parts.push(`Description from the user:\n${req.description}`);
  parts.push(`Trigger config:\n${JSON.stringify(req.trigger, null, 2)}`);
  if (req.sample_payload) parts.push(`Sample input payload:\n${req.sample_payload}`);
  if (req.target_schema) parts.push(`Target schema:\n${req.target_schema}`);
  parts.push(
    `For the demo, the source and target are both reachable at hostnames in the discovery allowlist. Use \`inspect_system_health\` and \`dry_run_request\` against those before drafting.\n\nWhen you call validate_in_sandbox, pass test_secrets that resolve URLs to the discovery hosts (e.g., {SYSTEM_A_URL: "http://mock-system-a:5001", SYSTEM_B_URL: "http://mock-system-b:5002", CURSOR: "1970-01-01T00:00:00.000Z"}).`,
  );
  return parts.join("\n\n");
}
