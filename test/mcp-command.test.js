import assert from "node:assert/strict";
import test from "node:test";
import { McpCommandUsageError, parseMcpCommandArguments } from "../src/mcp-command.js";

test("MCP command write gates default off and enable independently", () => {
  assert.deepEqual(parseMcpCommandArguments([]), {
    registryPath: undefined,
    dataPath: undefined,
    allowWrites: false,
    allowEvaluationWrites: false,
    help: false,
  });
  assert.deepEqual(parseMcpCommandArguments([
    "--data", "/tmp/events.jsonl",
    "--registry", "/tmp/repositories.json",
    "--allow-evaluation-writes",
  ]), {
    registryPath: "/tmp/repositories.json",
    dataPath: "/tmp/events.jsonl",
    allowWrites: false,
    allowEvaluationWrites: true,
    help: false,
  });
  assert.deepEqual(parseMcpCommandArguments([
    "--allow-writes",
    "--allow-evaluation-writes",
  ]), {
    registryPath: undefined,
    dataPath: undefined,
    allowWrites: true,
    allowEvaluationWrites: true,
    help: false,
  });
});

test("MCP command rejects unknown, duplicate, and missing-value arguments", () => {
  for (const args of [
    ["--unknown"],
    ["--allow-evaluation-writes", "--allow-evaluation-writes"],
    ["--allow-writes", "--allow-writes"],
    ["--data"],
    ["--registry", "--allow-writes"],
    ["--data", "one", "--data", "two"],
  ]) {
    assert.throws(
      () => parseMcpCommandArguments(args),
      (error) => error instanceof McpCommandUsageError && error.code === "PROOFWAKE_MCP_USAGE",
    );
  }
});

test("MCP command help is side-effect-free at parse time", () => {
  assert.deepEqual(parseMcpCommandArguments(["--help"]), {
    registryPath: undefined,
    dataPath: undefined,
    allowWrites: false,
    allowEvaluationWrites: false,
    help: true,
  });
});
