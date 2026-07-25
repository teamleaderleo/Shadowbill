import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const mainPath = resolve("src/main.js");

async function git(root, ...args) {
  await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function createRepository(root) {
  await execFileAsync("git", ["init", "-b", "main", root], { encoding: "utf8" });
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "package.json"), '{"scripts":{"test":"node --test"}}\n');
  await git(root, "add", "package.json");
  await git(root, "commit", "-m", "initial");
  await git(root, "remote", "add", "origin", "https://github.com/example/project.git");
}

function run(arguments_, { input = "" } = {}) {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env };
    for (const name of ["PROOFWAKE_DATA", "SHADOWBILL_DATA", "PROOFWAKE_COLLECTOR_TOKEN_FILE", "SHADOWBILL_COLLECTOR_TOKEN_FILE"]) delete env[name];
    const child = spawn(process.execPath, [mainPath, ...arguments_], { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function temporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-repository-cli-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("dry-run proposes without writing registry", async () => {
  await temporaryDirectory(async (directory) => {
    const root = join(directory, "repo");
    const dataPath = join(directory, "state", "events.jsonl");
    const registryPath = join(directory, "state", "repositories.json");
    await createRepository(root);
    const result = await run(["enroll", root, "--dry-run", "--data", dataPath, "--output", "json"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, "proposal");
    assert.equal(response.proposal.repository, "example/project");
    await assert.rejects(access(registryPath), (error) => error.code === "ENOENT");
  });
});

test("enrols and reports repository inventory", async () => {
  await temporaryDirectory(async (directory) => {
    const root = join(directory, "repo");
    const dataPath = join(directory, "state", "events.jsonl");
    await createRepository(root);
    const enrolled = await run(["enroll", root, "--data", dataPath, "--output", "json"]);
    assert.equal(JSON.parse(enrolled.stdout).status, "inserted");
    const repeated = await run(["enroll", root, "--data", dataPath, "--output", "json"]);
    assert.equal(JSON.parse(repeated.stdout).status, "unchanged");
    const inventory = await run(["repositories", "--data", dataPath, "--output", "json"]);
    assert.equal(inventory.code, 0);
    assert.equal(inventory.stderr, "");
    const report = JSON.parse(inventory.stdout);
    assert.equal(report.summary.total, 1);
    assert.equal(report.repositories[0].repository, "example/project");
    assert.equal(report.repositories[0].classification, "unobserved");
  });
});

test("returns machine-readable usage failures and help", async () => {
  const missing = await run(["enroll", "--output", "json"]);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).error.code, "PROOFWAKE_REPOSITORY_USAGE");
  const extra = await run(["repositories", "unexpected", "--output", "json"]);
  assert.equal(JSON.parse(extra.stdout).error.code, "PROOFWAKE_REPOSITORY_USAGE");
  const help = await run(["--help"]);
  assert.match(help.stdout, /enroll PATH/);
  assert.match(help.stdout, /repositories/);
});
