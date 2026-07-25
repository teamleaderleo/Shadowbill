import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function runProcess(command, args, options = {}) {
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
    options.onSpawn?.(child);
  });
}

async function git(root, ...args) {
  const result = await runProcess("git", ["-C", root, ...args]);
  if (result.code !== 0) throw new Error(result.stderr);
}

async function repository(root) {
  await mkdir(root);
  await runProcess("git", ["init", "-q", root]);
  await git(root, "config", "user.name", "Proofwake Test");
  await git(root, "config", "user.email", "proofwake@example.invalid");
  await git(root, "remote", "add", "origin", "https://github.com/example/project.git");
  await writeFile(join(root, "package.json"), '{}\n');
  await git(root, "add", "package.json");
  await git(root, "commit", "-qm", "initial");
}

const main = new URL("../src/main.js", import.meta.url).pathname;

test("operator cancellation is forwarded and persisted", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-run-cancel-"));
  try {
    const root = join(directory, "repo");
    const dataPath = join(directory, "events.jsonl");
    await repository(root);
    const result = await runProcess(process.execPath, [
      main,
      "run",
      "--repo", "example/project",
      "--kind", "verify",
      "--cwd", root,
      "--data", dataPath,
      "--output", "json",
      "--",
      process.execPath,
      "-e",
      "setInterval(() => {}, 1000)",
    ], {
      onSpawn(child) {
        setTimeout(() => child.kill("SIGINT"), 200);
      },
    });

    assert.equal(result.code, 130);
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, "cancelled");
    assert.equal(response.failureCode, "cancelled");
    assert.equal(response.cancelled, true);
    const ledger = await readFile(dataPath, "utf8");
    assert.match(ledger, /proofwake_observation/u);
    assert.doesNotMatch(ledger, /setInterval/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
