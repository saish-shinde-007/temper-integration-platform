// Shared response parser used by both the API-based and CLI-based agents.
// Both providers (Anthropic SDK and `claude` CLI) return free-form text that
// should contain a JSON object with source_code, declared_endpoints, and
// declared_secrets. This module is defensive about formatting variations
// AND strictly validates the result against AgentRawResponseSchema (Zod).
// Validation failures bubble up so the workflow can mark the integration
// Draft + record the error in the audit log.

import { AgentRawResponseSchema, type AgentRawResponse } from "@temper/shared";

export type ParsedResponse = AgentRawResponse;

export function parseAgentResponse(text: string): ParsedResponse {
  // 1. Try parsing the entire response as JSON.
  const direct = tryParseJson(text.trim());
  if (direct) return normalize(direct);

  // 2. Try extracting from a ```json or ```typescript fenced block.
  const fenced = text.match(/```(?:json|typescript|ts)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = tryParseJson(fenced[1].trim());
    if (inner) return normalize(inner);
  }

  // 3. Last resort: grab the first balanced {...} substring and parse that.
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    const slice = text.slice(braceStart, braceEnd + 1);
    const inner = tryParseJson(slice);
    if (inner) return normalize(inner);
  }

  throw new Error(
    `Agent response did not contain a parseable JSON object with source_code. Got: ${text.slice(0, 200)}`,
  );
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalize(raw: unknown): ParsedResponse {
  // Soft-coerce missing arrays to [] before strict validation so a single
  // missing field doesn't blow up the whole parse. Zod takes it from here.
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (!Array.isArray(obj.declared_endpoints)) obj.declared_endpoints = [];
    if (!Array.isArray(obj.declared_secrets)) obj.declared_secrets = [];
  }

  const result = AgentRawResponseSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Agent output failed schema validation. ${issues}`);
  }
  return result.data;
}
