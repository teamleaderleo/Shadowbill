import assert from "node:assert/strict";
import test from "node:test";
import { createProofwakeMcpSession } from "../src/evidence-mcp.js";

function initialize() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "protocol-test", version: "1.0.0" },
    },
  };
}

test("evidence tools reuse compatibility tools/call validation and extension metadata", async () => {
  const session = createProofwakeMcpSession({
    store: { readAll: async () => [] },
    registryStore: null,
    pricing: {},
    profile: {},
    timeZone: "UTC",
    allowWrites: false,
  });
  await session.handle(initialize());

  const extensionMetadata = await session.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "proofwake_fleet_status",
      arguments: {},
      _meta: { progressToken: "test" },
    },
  });
  assert.equal(extensionMetadata.result.isError, true);
  assert.equal(extensionMetadata.result.structuredContent.error.code, "PROOFWAKE_REGISTRY_UNAVAILABLE");

  const invalidArguments = await session.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "proofwake_fleet_status", arguments: [] },
  });
  assert.equal(invalidArguments.error.code, -32602);

  const task = await session.handle({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "proofwake_fleet_status", arguments: {}, task: { ttl: 1 } },
  });
  assert.equal(task.error.code, -32601);
  assert.match(task.error.message, /Task-augmented/);
});
