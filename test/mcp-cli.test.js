import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "proofwake-mcp-cli-test", version: "1.0.0" },
  },
};

async function runMcp(args) {
  const child = spawn(process.execPath, ["src/main.js", "mcp", ...args], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify(initialize)}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "proofwake_fleet_status", arguments: {} },
  })}\n`);
  child.stdin.end();
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return {
    code,
    stderr,
    responses: stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}

test("mcp derives the registry beside the selected ledger and accepts an explicit override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-mcp-cli-"));
  try {
    const dataPath = join(directory, "events.jsonl");
    const defaultRegistry = join(directory, "repositories.json");
    const explicitRegistry = join(directory, "approved-repositories.json");
    await writeFile(dataPath, "");
    await writeFile(defaultRegistry, '{"version":1,"entries":[]}\n');
    await writeFile(explicitRegistry, '{"version":1,"entries":[]}\n');

    const derived = await runMcp(["--data", dataPath]);
    assert.equal(derived.code, 0, derived.stderr);
    assert.equal(derived.responses[1].result.isError, false);
    assert.deepEqual(derived.responses[1].result.structuredContent.summary, {
      total: 0,
      green: 0,
      red: 0,
      yellow: 0,
      grey: 0,
    });

    await writeFile(defaultRegistry, '{"version":1,"entries":[{"secret":"must stay unused"}]}\n');
    const explicit = await runMcp(["--data", dataPath, "--registry", explicitRegistry]);
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal(explicit.responses[1].result.isError, false);
    assert.equal(explicit.responses[1].result.structuredContent.summary.total, 0);
    assert.equal(JSON.stringify(explicit.responses).includes("must stay unused"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
