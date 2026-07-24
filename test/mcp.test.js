import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DEFAULT_WORKING_PROFILE } from "../src/estimate.js";
import { runShadowbillMcpStdioServer } from "../src/mcp.js";
import { JsonlEventStore } from "../src/store.js";

const pricing = {
  inputPerMillion: 5,
  cachedInputPerMillion: 0.5,
  cacheWritePerMillion: 6.25,
  outputPerMillion: 30,
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
};

const initialize = (id = 1, protocolVersion = "2025-11-25") => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "shadowbill-test", version: "1.0.0" },
  },
});

async function exchange(options, messages) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let text = "";
  output.on("data", (chunk) => { text += chunk; });

  const running = runShadowbillMcpStdioServer(options, { input, output });
  for (const message of messages) {
    input.write(typeof message === "string" ? `${message}\n` : `${JSON.stringify(message)}\n`);
  }
  input.end();
  await running;

  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function options(store, allowWrites = false) {
  return {
    store,
    pricing,
    profile: DEFAULT_WORKING_PROFILE,
    timeZone: "America/Los_Angeles",
    allowWrites,
  };
}

test("MCP requires initialize and ignores premature notifications", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-mcp-lifecycle-"));
  const store = new JsonlEventStore(join(directory, "events.jsonl"));
  try {
    const responses = await exchange(options(store), [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      initialize(2),
      initialize(3),
      { jsonrpc: "2.0", id: 4, method: "ping" },
    ]);
    assert.equal(responses[0].error.code, -32002);
    assert.equal(responses[1].result.protocolVersion, "2025-11-25");
    assert.equal(responses[1].result.serverInfo.name, "shadowbill");
    assert.equal(responses[2].error.code, -32600);
    assert.deepEqual(responses[3].result, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP read-only mode lists one tool and returns a daily report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-mcp-report-"));
  const store = new JsonlEventStore(join(directory, "events.jsonl"));
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

  try {
    const responses = await exchange(options(store), [
      initialize(),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "shadowbill_daily_report",
          arguments: { date: "2026-07-25", timezone: "America/Los_Angeles" },
        },
      },
    ]);
    assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ["shadowbill_daily_report"]);
    assert.equal(responses[1].result.tools[0].annotations.readOnlyHint, true);
    assert.equal(responses[2].result.isError, false);
    assert.equal(responses[2].result.structuredContent.chatTurns, 1);
    assert.equal(responses[2].result.structuredContent.visibleInputTokens, 100_000);
    assert.equal(responses[2].result.structuredContent.timezone, "America/Los_Angeles");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP aggregate writes are opt-in, idempotent, and content-minimized", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-mcp-write-"));
  const store = new JsonlEventStore(join(directory, "events.jsonl"));
  const input = {
    conversationKey: "private-conversation-identifier",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    visibleInputTokens: 25_000,
    visibleOutputTokens: 4_000,
    toolActivityCount: 3,
    responseDurationMs: 45_000,
    timestamp: "2026-07-25T19:00:00Z",
  };

  try {
    const responses = await exchange(options(store, true), [
      initialize(),
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "shadowbill_record_chat_turn", arguments: input } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "shadowbill_record_chat_turn", arguments: input } },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "shadowbill_record_chat_turn",
          arguments: { ...input, prompt: "private text must be rejected" },
        },
      },
    ]);

    assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), [
      "shadowbill_daily_report",
      "shadowbill_record_chat_turn",
    ]);
    assert.equal(responses[2].result.structuredContent.duplicate, false);
    assert.equal(responses[3].result.structuredContent.duplicate, true);
    assert.equal(responses[2].result.structuredContent.id, responses[3].result.structuredContent.id);
    assert.equal(responses[4].result.isError, true);

    const events = await store.readAll();
    assert.equal(events.length, 1);
    assert.equal(events[0].conversationHash, responses[2].result.structuredContent.conversationHash);
    assert.notEqual(events[0].conversationHash, input.conversationKey);
    assert.equal("conversationKey" in events[0], false);
    assert.equal("prompt" in events[0], false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP returns protocol errors for malformed messages, unknown tools, and task calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-mcp-errors-"));
  const store = new JsonlEventStore(join(directory, "events.jsonl"));
  try {
    const responses = await exchange(options(store), [
      "{bad json",
      initialize(),
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "missing", arguments: {} } },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "shadowbill_daily_report", arguments: {}, task: { ttl: 1000 } },
      },
      { jsonrpc: "2.0", id: 4, method: "unknown/method" },
    ]);
    assert.equal(responses[0].error.code, -32700);
    assert.equal(responses[2].error.code, -32601);
    assert.equal(responses[3].error.code, -32601);
    assert.equal(responses[4].error.code, -32601);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
