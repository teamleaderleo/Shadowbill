import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
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
  });
}

async function repository(root) {
  await mkdir(root, { recursive: true });
  await runProcess("git", ["init", "-q", root]);
  await runProcess("git", ["-C", root, "config", "user.email", "proofwake@example.invalid"]);
  await runProcess("git", ["-C", root, "config", "user.name", "Proofwake Test"]);
  await runProcess("git", ["-C", root, "remote", "add", "origin", "https://github.com/example/project.git"]);
  await writeFile(join(root, "package.json"), '{}\n');
  await runProcess("git", ["-C", root, "add", "package.json"]);
  await runProcess("git", ["-C", root, "commit", "-qm", "initial"]);
}

async function temporary(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-run-cli-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const main = new URL("../src/main.js", import.meta.url).pathname;

test("run help is available without a command separator", async () => {
  const result = await runProcess(process.execPath, [main, "run", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /proofwake run --repo/u);
});

test("machine mode keeps stdout parseable and child output on stderr", async () => {
  await temporary(async (directory) => {
    const root = join(directory, "repo");
    const dataPath = join(directory, "events.jsonl");
    await repository(root);
    const result = await runProcess(process.execPath, [
      main,
      "run",
      "--repo", "example/project",
      "--kind", "verify",
      "--cwd", root,
      "--run-id", "cli-passing",
      "--data", dataPath,
      "--output", "json",
      "--",
      process.execPath,
      "-e",
      'console.log("child-visible")',
    ]);
    assert.equal(result.code, 0);
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, "passed");
    assert.equal(response.runId, "cli-passing");
    assert.equal(response.storageStatus, "inserted");
    assert.match(result.stderr, /child-visible/u);
    const ledger = await readFile(dataPath, "utf8");
    assert.doesNotMatch(ledger, /child-visible/u);
  });
});

test("run preserves the child exit code after receipt persistence", async () => {
  await temporary(async (directory) => {
    const root = join(directory, "repo");
    await repository(root);
    const result = await runProcess(process.execPath, [
      main,
      "run",
      "--repo", "example/project",
      "--kind", "verify",
      "--cwd", root,
      "--data", join(directory, "events.jsonl"),
      "--output", "json",
      "--",
      process.execPath,
      "-e",
      "process.exit(9)",
    ]);
    assert.equal(result.code, 9);
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, "failed");
    assert.equal(response.exitCode, 9);
    assert.equal(response.failureCode, "exit-nonzero");
  });
});

test("usage failures return one JSON error and exit code 2", async () => {
  const result = await runProcess(process.execPath, [main, "run", "--output", "json"]);
  assert.equal(result.code, 2);
  const response = JSON.parse(result.stdout);
  assert.equal(response.status, "error");
  assert.equal(response.error.code, "PROOFWAKE_RUN_USAGE");
});
