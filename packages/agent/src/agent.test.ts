import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAgent } from "./agent.js";

function mockClient(text: string) {
  return {
    messages: {
      create: async () => ({ content: [{ type: "text", text }] }),
    },
  } as never;
}

test("returns parsed AgentOutput with sha256 hash", async () => {
  const payload = {
    source_code: "export async function run() { return { ok: true }; }",
    declared_endpoints: ["api.systema.test"],
    declared_secrets: ["SYSTEM_A_URL"],
  };
  const agent = new ClaudeAgent(mockClient(JSON.stringify(payload)));

  const out = await agent.generateIntegrationCode({
    description: "test",
    trigger: { type: "cron", expression: "*/15 * * * *" },
  });

  assert.equal(out.language, "typescript");
  assert.equal(out.declared_endpoints[0], "api.systema.test");
  assert.equal(out.declared_secrets[0], "SYSTEM_A_URL");
  assert.equal(out.source_code, payload.source_code);
  assert.equal(out.sha256.length, 64);
  assert.match(out.sha256, /^[0-9a-f]{64}$/);
});

test("extracts JSON from a ```json fenced code block", async () => {
  const payload = {
    source_code: "export async function run() { return { ok: true }; }",
    declared_endpoints: ["api.systemb.test"],
    declared_secrets: ["SYSTEM_B_TOKEN"],
  };
  const fenced = "Here you go:\n\n```json\n" + JSON.stringify(payload) + "\n```\n";
  const agent = new ClaudeAgent(mockClient(fenced));

  const out = await agent.generateIntegrationCode({
    description: "test",
    trigger: { type: "webhook", path: "/hook" },
  });

  assert.equal(out.declared_endpoints[0], "api.systemb.test");
  assert.equal(out.declared_secrets[0], "SYSTEM_B_TOKEN");
});

test("defaults declared_endpoints and declared_secrets to []", async () => {
  const payload = { source_code: "export async function run() { return { ok: true }; }" };
  const agent = new ClaudeAgent(mockClient(JSON.stringify(payload)));

  const out = await agent.generateIntegrationCode({
    description: "test",
    trigger: { type: "cron", expression: "0 * * * *" },
  });

  assert.deepEqual(out.declared_endpoints, []);
  assert.deepEqual(out.declared_secrets, []);
});

test("throws a clear error when response has no JSON", async () => {
  const agent = new ClaudeAgent(mockClient("sorry, I cannot help"));

  await assert.rejects(
    () =>
      agent.generateIntegrationCode({
        description: "test",
        trigger: { type: "cron", expression: "0 * * * *" },
      }),
    /parseable JSON|source_code/,
  );
});
