// ClaudeFetchAgent: minimal direct-fetch implementation of AgentAPI.
//
// Avoids the @anthropic-ai/sdk dependency entirely. Useful in Cloud Run where
// pinning to a known-good API contract beats wrestling with SDK version pins.
// Same single-shot semantics as ClaudeAgent — no tools, one prompt → JSON out.

import { createHash } from "node:crypto";
import type { AgentAPI, AgentRequest, AgentOutput } from "@temper/shared";
import { buildPrompt } from "./prompt.js";
import { parseAgentResponse } from "./parser.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

export interface ClaudeFetchAgentOptions {
  apiKey?: string;
  model?: string;
  apiVersion?: string;
}

export class ClaudeFetchAgent implements AgentAPI {
  constructor(private opts: ClaudeFetchAgentOptions = {}) {}

  async generateIntegrationCode(req: AgentRequest): Promise<AgentOutput> {
    const apiKey = this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    const model = this.opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
    const version = this.opts.apiVersion ?? "2023-06-01";

    const { systemPrompt, userPrompt } = buildPrompt(req);

    const resp = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": version,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Anthropic API ${resp.status}: ${body.slice(0, 500)}`);
    }

    const data = (await resp.json()) as {
      content: Array<{ type: string; text?: string }>;
    };

    const text = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");

    const parsed = parseAgentResponse(text);
    const sha256 = createHash("sha256").update(parsed.source_code).digest("hex");

    return {
      source_code: parsed.source_code,
      sha256,
      declared_endpoints: parsed.declared_endpoints,
      declared_secrets: parsed.declared_secrets,
      language: "typescript" as const,
    };
  }
}
