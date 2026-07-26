import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  });
}

async function git(root, ...args) {
  const result = await runProcess("git", ["-C", root, ...args]);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function repository(root) {
  const policy = {
    version: 1,
    repository: { kind: "remote", id: "acme/demo", provider: "github" },
    lifecycle: { state: "active", dormantAfterDays: 30 },
    signals: [{
      kind: "verify",
      requirement: "required",
      subject: "revision",
      appliesTo: "every-revision",
      freshness: { mode: "revision" },
      acceptedSources: ["local-command"],
    }],
    adapters: [],
  };
  await mkdir(root);
  await runProcess("git", ["init", "-q", "-b", "main", root]);
  await git(root, "config", "user.name", "Proofwake Test");
  await git(root, "config", "user.email", "proofwake@example.invalid");
  await git(root, "remote", "add", "origin", "https://github.com/acme/demo.git");
  await writeFile(join(root, "package.json"), '{}\n');
  await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy, null, 2)}\n`);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "initial");
}

async function temporary(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-projection-cli-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const main = new URL("../src/main.js", import.meta.url).pathname;

test("installed CLI enrols, records, inspects, and reports a fleet", async () => {
  await temporary(async (directory) => {
    const root = join(directory, "repo");
    const dataPath = join(directory, "events.jsonl");
    const registryPath = join(directory, "repositories.json");
    await repository(root);

    let result = await runProcess(process.execPath, [
      main,
      "enroll",
      root,
      "--write",
      "--registry", registryPath,
      "--data", dataPath,
      "--output", "json",
    ]);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).status, "inserted");

    result = await runProcess(process.execPath, [
      main,
      "run",
      "--repo", "acme/demo",
      "--kind", "verify",
      "--cwd", root,
      "--run-id", "projection-cli-pass",
      "--data", dataPath,
      "--output", "json",
      "--",
      process.execPath,
      "-e",
      "",
    ]);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).status, "passed");

    result = await runProcess(process.execPath, [
      main,
      "inspect",
      "--repo", "acme/demo",
      "--registry", registryPath,
      "--data", dataPath,
      "--output", "json",
    ]);
    assert.equal(result.code, 0);
    const inspection = JSON.parse(result.stdout);
    assert.equal(inspection.command, "inspect");
    assert.equal(inspection.status, "green");
    assert.equal(inspection.signals[0].latest.id, "local-command.projection-cli-pass");

    result = await runProcess(process.execPath, [
      main,
      "fleet",
      "--registry", registryPath,
      "--data", dataPath,
      "--output", "json",
    ]);
    assert.equal(result.code, 0);
    const fleet = JSON.parse(result.stdout);
    assert.deepEqual(fleet.summary, { total: 1, green: 1, red: 0, yellow: 0, grey: 0 });
    assert.equal(fleet.repositories[0].status, "green");
  });
});

test("inspect returns a stable JSON error for an unknown repository", async () => {
  await temporary(async (directory) => {
    const result = await runProcess(process.execPath, [
      main,
      "inspect",
      "--repo", "acme/missing",
      "--registry", join(directory, "repositories.json"),
      "--data", join(directory, "events.jsonl"),
      "--output", "json",
    ]);
    assert.equal(result.code, 1);
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, "error");
    assert.equal(response.error.code, "PROJECTION_REPOSITORY_UNKNOWN");
  });
});

test("projection help is available without registry access", async () => {
  for (const command of ["inspect", "fleet"]) {
    const result = await runProcess(process.execPath, [main, command, "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Proofwake evidence projections/u);
  }
});
