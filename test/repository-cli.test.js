import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const mainPath = resolve("src/main.js");

function policy(id) {
  return {
    version: 1,
    repository: { kind: "remote", id, provider: "github" },
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
}

async function git(root, ...args) {
  return exec("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function repository(directory, { committed = true } = {}) {
  const root = join(directory, "repo");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(root));
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Proofwake Test");
  await git(root, "config", "user.email", "proofwake@example.invalid");
  await git(root, "remote", "add", "origin", "https://github.com/acme/demo.git");
  await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
  await git(root, "add", "package.json");
  await git(root, "commit", "-qm", "Initial");
  if (committed) {
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy("acme/demo"), null, 2)}\n`);
    await git(root, "add", ".proofwake.json");
    await git(root, "commit", "-qm", "Add policy");
  }
  return root;
}

function run(arguments_) {
  return new Promise((resolvePromise, reject) => {
    const environment = { ...process.env };
    for (const name of ["PROOFWAKE_DATA", "SHADOWBILL_DATA", "PROOFWAKE_COLLECTOR_TOKEN_FILE", "SHADOWBILL_COLLECTOR_TOKEN_FILE"]) {
      delete environment[name];
    }
    const child = spawn(process.execPath, [mainPath, ...arguments_], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function absent(path) {
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
}

test("enroll is a JSON dry run unless --write is supplied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-enroll-cli-dry-"));
  const registryPath = join(directory, "repositories.json");
  const dataPath = join(directory, "events.jsonl");
  try {
    const root = await repository(directory);
    const result = await run(["enroll", root, "--registry", registryPath, "--data", dataPath, "--output", "json"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, "dry-run");
    assert.equal(response.dryRun, true);
    assert.equal(response.proposal.repository.identity, "acme/demo");
    await absent(registryPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("committed policy writes registry and repositories returns JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-enroll-cli-write-"));
  const registryPath = join(directory, "repositories.json");
  const dataPath = join(directory, "events.jsonl");
  try {
    const root = await repository(directory);
    const enrolled = await run(["enroll", root, "--write", "--registry", registryPath, "--data", dataPath, "--output", "json"]);
    assert.equal(enrolled.code, 0);
    assert.equal(JSON.parse(enrolled.stdout).status, "inserted");
    const raw = JSON.parse(await readFile(registryPath, "utf8"));
    assert.equal(raw.entries.length, 1);

    const listed = await run(["repositories", "--registry", registryPath, "--data", dataPath, "--output", "json"]);
    assert.equal(listed.code, 0);
    assert.equal(listed.stderr, "");
    const report = JSON.parse(listed.stdout);
    assert.equal(report.command, "repositories");
    assert.equal(report.summary.total, 1);
    assert.equal(report.repositories[0].repository.identity, "acme/demo");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("autodetected write requires explicit approval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-enroll-cli-approve-"));
  const registryPath = join(directory, "repositories.json");
  const dataPath = join(directory, "events.jsonl");
  try {
    const root = await repository(directory, { committed: false });
    const rejected = await run(["enroll", root, "--write", "--registry", registryPath, "--data", dataPath, "--output", "json"]);
    assert.equal(rejected.code, 1);
    assert.equal(rejected.stderr, "");
    assert.equal(JSON.parse(rejected.stdout).error.code, "REPOSITORY_APPROVAL_REQUIRED");
    await absent(registryPath);

    const accepted = await run([
      "enroll", root, "--write", "--approve-autodetected",
      "--registry", registryPath, "--data", dataPath, "--output", "json",
    ]);
    assert.equal(accepted.code, 0);
    const response = JSON.parse(accepted.stdout);
    assert.equal(response.status, "inserted");
    assert.equal(response.entry.approval.method, "autodetected");
    assert.equal(response.entry.configuration.source, "global");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
