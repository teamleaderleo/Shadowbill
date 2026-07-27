import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const main = new URL("../src/main.js", import.meta.url).pathname;

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [main, ...args], {
      env: process.env,
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
    child.stdin.end();
  });
}

test("installed MCP usage failures are fixed, bounded, and stack-free", async () => {
  const secret = "--private-token-path-sentinel";
  const result = await run(["mcp", secret]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Proofwake MCP: PROOFWAKE_MCP_USAGE: Unknown MCP argument\./u);
  assert.match(result.stderr, /Proofwake MCP stdio server/u);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.stderr.includes("at runMcpCommand"), false);
  assert.equal(result.stderr.includes(main), false);
});

test("installed MCP help exits without opening the stdio server", async () => {
  const result = await run(["mcp", "--help"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--allow-evaluation-writes/u);
  assert.equal(result.stderr, "");
});
