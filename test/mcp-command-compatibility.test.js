import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseMcpCommandArguments,
  resolveMcpCommandRuntime,
} from "../src/mcp-command.js";

const main = new URL("../src/main.js", import.meta.url).pathname;

function initialize(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "proofwake-mcp-compatibility-test", version: "1.0.0" },
    },
  };
}

function run(args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [main, ...args], {
      env: {
        ...process.env,
        PROOFWAKE_MCP_ALLOW_WRITES: "",
        SHADOWBILL_MCP_ALLOW_WRITES: "",
        PROOFWAKE_REPOSITORY_REGISTRY: "",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function temporary(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-mcp-command-compatibility-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("legacy Shadowbill write aliases and registry override remain supported", () => {
  const parsed = parseMcpCommandArguments([]);
  assert.deepEqual(resolveMcpCommandRuntime(parsed, {
    PROOFWAKE_MCP_ALLOW_WRITES: "TRUE",
    PROOFWAKE_REPOSITORY_REGISTRY: "/tmp/legacy-registry.json",
  }), {
    ...parsed,
    registryPath: "/tmp/legacy-registry.json",
    allowWrites: true,
    allowEvaluationWrites: false,
  });
  assert.equal(resolveMcpCommandRuntime(parsed, {
    SHADOWBILL_MCP_ALLOW_WRITES: "on",
  }).allowWrites, true);
});

test("explicit command arguments override registry environment and preserve independent gates", () => {
  const parsed = parseMcpCommandArguments([
    "--registry", "/tmp/explicit-registry.json",
    "--allow-evaluation-writes",
  ]);
  const runtime = resolveMcpCommandRuntime(parsed, {
    PROOFWAKE_REPOSITORY_REGISTRY: "/tmp/environment-registry.json",
    PROOFWAKE_MCP_ALLOW_WRITES: "yes",
    PROOFWAKE_MCP_ALLOW_EVALUATION_WRITES: "1",
  });
  assert.equal(runtime.registryPath, "/tmp/explicit-registry.json");
  assert.equal(runtime.allowWrites, true);
  assert.equal(runtime.allowEvaluationWrites, true);
});

test("no environment variable can enable evaluation receipt writes", () => {
  const parsed = parseMcpCommandArguments([]);
  const runtime = resolveMcpCommandRuntime(parsed, {
    PROOFWAKE_MCP_ALLOW_EVALUATION_WRITES: "1",
    SHADOWBILL_MCP_ALLOW_EVALUATION_WRITES: "true",
    ALLOW_EVALUATION_WRITES: "yes",
  });
  assert.equal(runtime.allowEvaluationWrites, false);
});

test("installed legacy write environment alias enables only the Shadowbill write tool", async () => {
  await temporary(async (directory) => {
    const dataPath = join(directory, "events.jsonl");
    const input = [
      initialize(),
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";
    const result = await run(["mcp", "--data", dataPath], input, {
      SHADOWBILL_MCP_ALLOW_WRITES: "true",
    });

    assert.equal(result.code, 0, result.stderr);
    const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const names = responses[1].result.tools.map((tool) => tool.name);
    assert.equal(names.includes("shadowbill_record_chat_turn"), true);
    assert.equal(names.includes("proofwake_submit_evaluation_receipt"), false);
  });
});
