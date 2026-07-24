import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { JsonlEventStore } from "../src/store.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function connect(dataPath, allowWrites = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string"));
  delete env.SHADOWBILL_MCP_ALLOW_WRITES;
  if (allowWrites) env.SHADOWBILL_MCP_ALLOW_WRITES = "1";

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp", "--data", dataPath, "--timezone", "America/Los_Angeles"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "shadowbill-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function textResult(result) {
  const text = result.content.find((item) => item.type === "text");
  assert.ok(text && "text" in text);
  return JSON.parse(text.text);
}

test("MCP is read-only by default and returns daily reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-mcp-read-"));
  const dataPath = join(directory, "events.jsonl");
  const store = new JsonlEventStore(dataPath);
  await store.append({
    type: "chat_turn",
    id: "chat_seed",
    timestamp: "2026-07-25T18:00:00Z",
    conversationHash: "seeded",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    visibleInputTokens: 100_000,
    visibleOutputTokens: 10_000,
  });

  const client = await connect(dataPath);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["shadowbill_daily_report"]);

    const result = await client.callTool({
      name: "shadowbill_daily_report",
      arguments: { date: "2026-07-25", timezone: "America/Los_Angeles" },
    });
    const report = textResult(result);
    assert.equal(report.chatTurns, 1);
    assert.equal(report.visibleInputTokens, 100_000);
    assert.equal(report.visibleOutputTokens, 10_000);
    assert.equal(report.timezone, "America/Los_Angeles");
    assert.ok(report.workingEstimate > 0);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP aggregate chat writes require opt-in and deduplicate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-mcp-write-"));
  const dataPath = join(directory, "events.jsonl");
  const client = await connect(dataPath, true);
  const input = {
    conversationKey: "private-conversation-id",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    visibleInputTokens: 25_000,
    visibleOutputTokens: 4_000,
    toolActivityCount: 3,
    responseDurationMs: 45_000,
    timestamp: "2026-07-25T19:00:00Z",
  };

  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "shadowbill_daily_report",
      "shadowbill_record_chat_turn",
    ]);

    const first = textResult(await client.callTool({ name: "shadowbill_record_chat_turn", arguments: input }));
    const second = textResult(await client.callTool({ name: "shadowbill_record_chat_turn", arguments: input }));
    assert.equal(first.accepted, true);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.id, second.id);
    assert.notEqual(first.conversationHash, input.conversationKey);

    const events = await new JsonlEventStore(dataPath).readAll();
    assert.equal(events.length, 1);
    assert.equal(events[0].conversationHash, first.conversationHash);
    assert.equal("conversationKey" in events[0], false);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
