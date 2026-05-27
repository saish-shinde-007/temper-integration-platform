// Factory that picks the right agent implementation based on env config.
//
// Precedence:
//   1. AGENT_PROVIDER=agentic     → AgenticGenerator (Claude Agent SDK, multi-turn, tools)
//   2. AGENT_PROVIDER=cli         → ClaudeCliAgent (shells out to `claude --print`)
//   3. AGENT_PROVIDER=api         → ClaudeAgent (Anthropic SDK with API key, single-shot)
//   4. ANTHROPIC_API_KEY is set   → ClaudeAgent
//   5. Otherwise                  → ClaudeCliAgent

import Anthropic from "@anthropic-ai/sdk";
import type { AgentAPI, SandboxAPI } from "@temper/shared";
import { ClaudeAgent } from "./agent.js";
import { ClaudeCliAgent } from "./cli-agent.js";
import { ClaudeFetchAgent } from "./fetch-agent.js";
import { AgenticGenerator } from "./agentic-agent.js";

export type AgentProvider = "agentic" | "cli" | "api" | "fetch" | "auto";

export interface CreateAgentOptions {
  provider?: AgentProvider;
  /** Required for `agentic` provider so the agent can validate drafts in the sandbox during its loop. */
  sandbox?: SandboxAPI;
}

export function createAgent(opts: CreateAgentOptions = {}): AgentAPI {
  const requested =
    opts.provider ??
    (process.env.AGENT_PROVIDER as AgentProvider | undefined) ??
    "auto";

  if (requested === "agentic") {
    console.log("[agent] using AgenticGenerator (Claude Agent SDK, multi-turn)");
    return new AgenticGenerator({ sandbox: opts.sandbox });
  }

  if (requested === "cli") {
    console.log("[agent] using ClaudeCliAgent (claude CLI, single-shot)");
    return new ClaudeCliAgent();
  }

  if (requested === "fetch") {
    console.log("[agent] using ClaudeFetchAgent (direct fetch to Anthropic, single-shot)");
    return new ClaudeFetchAgent();
  }

  if (requested === "api") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "AGENT_PROVIDER=api but ANTHROPIC_API_KEY is not set. Set the key or switch to AGENT_PROVIDER=cli|agentic.",
      );
    }
    console.log("[agent] using ClaudeAgent (Anthropic SDK, single-shot)");
    return new ClaudeAgent(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
  }

  // auto: prefer SDK if a real key is set, fall back to CLI.
  const key = process.env.ANTHROPIC_API_KEY;
  if (key && key.length > 10 && key !== "dummy-no-key") {
    console.log("[agent] auto: ANTHROPIC_API_KEY detected, using ClaudeAgent");
    return new ClaudeAgent(new Anthropic({ apiKey: key }));
  }
  console.log("[agent] auto: no API key, falling back to ClaudeCliAgent");
  return new ClaudeCliAgent();
}
