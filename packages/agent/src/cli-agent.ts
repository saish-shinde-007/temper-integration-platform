// ClaudeCliAgent: invokes the `claude` Claude Code CLI as a subprocess
// instead of calling the Anthropic HTTP API directly.
//
// Why this exists: lets the platform use the user's already-authenticated
// Claude Code login instead of provisioning an ANTHROPIC_API_KEY. Same
// underlying Claude model, different transport.
//
// Contract: implements AgentAPI from @temper/shared. Drop-in for ClaudeAgent.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { AgentAPI, AgentRequest, AgentOutput } from "@temper/shared";
import { buildPrompt } from "./prompt.js";
import { parseAgentResponse } from "./parser.js";

export interface ClaudeCliAgentOptions {
  /** Path to the `claude` binary. Defaults to "claude" (resolved via PATH). */
  cliPath?: string;
  /** Model to ask the CLI to use. Default: sonnet for speed. */
  model?: "sonnet" | "opus" | "haiku" | string;
  /** Hard timeout for the CLI call. Default: 120s. */
  timeoutMs?: number;
}

export class ClaudeCliAgent implements AgentAPI {
  constructor(private opts: ClaudeCliAgentOptions = {}) {}

  async generateIntegrationCode(req: AgentRequest): Promise<AgentOutput> {
    const { systemPrompt, userPrompt } = buildPrompt(req);

    // The CLI doesn't have a separate "system" message slot, so we prepend the
    // system instructions to the user prompt with a clear separator. Claude
    // handles this reliably.
    const combined = `${systemPrompt}\n\n---\n\n${userPrompt}`;

    const cliPath = this.opts.cliPath ?? process.env.CLAUDE_CLI_PATH ?? "claude";
    const model = this.opts.model ?? process.env.CLAUDE_CLI_MODEL ?? "sonnet";
    const timeoutMs = this.opts.timeoutMs ?? 120_000;

    const text = await invokeCli(cliPath, combined, model, timeoutMs);

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

function invokeCli(
  cliPath: string,
  prompt: string,
  model: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["--print", "--model", model, "--output-format", "text"];

    const child = spawn(cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Claude CLI ('${cliPath}') timed out after ${timeoutMs}ms. stderr: ${stderr.slice(0, 500)}`,
        ),
      );
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Claude CLI spawn failed ('${cliPath}'): ${err.message}. Is the 'claude' CLI installed? npm install -g @anthropic-ai/claude-code`,
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `Claude CLI exited with code ${code}. stderr: ${stderr.slice(0, 500)}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
