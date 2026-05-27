import Anthropic from "@anthropic-ai/sdk";
import type { AgentAPI, AgentRequest, AgentOutput } from "@temper/shared";
import { createHash } from "node:crypto";
import { buildPrompt } from "./prompt.js";
import { parseAgentResponse } from "./parser.js";

export class ClaudeAgent implements AgentAPI {
  constructor(
    private client: Anthropic,
    private model: string = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-5",
  ) {}

  async generateIntegrationCode(req: AgentRequest): Promise<AgentOutput> {
    const { systemPrompt, userPrompt } = buildPrompt(req);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = response.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { type: string; text?: string }) => b.text ?? "")
      .join("");

    const parsed = parseAgentResponse(text);
    const sha256 = createHash("sha256").update(parsed.source_code).digest("hex");

    return {
      source_code: parsed.source_code,
      sha256,
      declared_endpoints: parsed.declared_endpoints ?? [],
      declared_secrets: parsed.declared_secrets ?? [],
      language: "typescript" as const,
    };
  }
}

