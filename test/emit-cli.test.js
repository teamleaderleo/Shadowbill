import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const mainPath = resolve("src/main.js");
const fixturePath = resolve("test/fixtures/observations/renderprove-browser-review-passed-v1.json");

function run(arguments_, { input = "", environment = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env, ...environment };
    for (const name of ["PROOFWAKE_DATA", "SHADOWBILL_DATA", "PROOFWAKE_COLLECTOR_TOKEN_FILE", "SHADOWBILL_COLLECTOR_TOKEN_FILE"]) {
      delete env[name];
    }
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
  const directory = await mkdtemp(join(tmpdir(), "proofwake-emit-cli-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("emits a file with machine-readable output", async () => {
  await temporaryDirectory(async (directory) => {
    const dataPath = join(directory, "events.jsonl");
    const result = await run(["emit", "--json", fixturePath, "--data", dataPath, "--output", "json"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, "inserted");
    assert.equal(response.identity.source, "urn:proofwake:adapter:renderprove");
    assert.match(response.fingerprint, /^sha256:[a-f0-9]{64}$/);
  });
});

test("returns duplicate for semantic replay", async () => {
  await temporaryDirectory(async (directory) => {
    const dataPath = join(directory, "events.jsonl");
    const first = await run(["emit", "--json", fixturePath, "--data", dataPath, "--output", "json"]);
    const second = await run(["emit", "--json", fixturePath, "--data", dataPath, "--output", "json"]);
    assert.equal(JSON.parse(first.stdout).status, "inserted");
    assert.equal(JSON.parse(second.stdout).status, "duplicate");
    assert.equal((await readFile(dataPath, "utf8")).trim().split("\n").length, 1);
  });
});

test("rejects conflicting identity reuse", async () => {
  await temporaryDirectory(async (directory) => {
    const dataPath = join(directory, "events.jsonl");
    const conflictPath = join(directory, "conflict.json");
    const conflict = JSON.parse(await readFile(fixturePath, "utf8"));
    conflict.data.status = "failed";
    await writeFile(conflictPath, JSON.stringify(conflict));
    await run(["emit", "--json", fixturePath, "--data", dataPath, "--output", "json"]);
    const result = await run(["emit", "--json", conflictPath, "--data", dataPath, "--output", "json"]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).error.code, "OBSERVATION_ID_CONFLICT");
  });
});

test("accepts stdin and rejects unknown fields", async () => {
  await temporaryDirectory(async (directory) => {
    const dataPath = join(directory, "events.jsonl");
    const value = JSON.parse(await readFile(fixturePath, "utf8"));
    const accepted = await run(["emit", "--stdin", "--data", dataPath, "--output", "json"], { input: JSON.stringify(value) });
    assert.equal(JSON.parse(accepted.stdout).status, "inserted");
    value.prompt = "secret";
    value.id = "renderprove.fixture-web-app.unknown-field";
    const rejected = await run(["emit", "--stdin", "--data", dataPath, "--output", "json"], { input: JSON.stringify(value) });
    assert.equal(rejected.code, 1);
    assert.equal(JSON.parse(rejected.stdout).error.code, "OBSERVATION_UNKNOWN_FIELD");
  });
});

test("rejects nested duplicate keys and oversized stdin", async () => {
  await temporaryDirectory(async (directory) => {
    const dataPath = join(directory, "events.jsonl");
    const text = await readFile(fixturePath, "utf8");
    const duplicate = text.replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1');
    const duplicateResult = await run(["emit", "--stdin", "--data", dataPath, "--output", "json"], { input: duplicate });
    assert.equal(JSON.parse(duplicateResult.stdout).error.code, "OBSERVATION_DUPLICATE_KEY");
    const oversizedResult = await run(["emit", "--stdin", "--data", dataPath, "--output", "json"], { input: "x".repeat(65537) });
    assert.equal(JSON.parse(oversizedResult.stdout).error.code, "OBSERVATION_TOO_LARGE");
  });
});

test("requires exactly one input source and documents emit", async () => {
  const missing = await run(["emit", "--output", "json"]);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).error.code, "PROOFWAKE_EMIT_USAGE");
  const both = await run(["emit", "--json", fixturePath, "--stdin", "--output", "json"]);
  assert.equal(JSON.parse(both.stdout).error.code, "PROOFWAKE_EMIT_USAGE");
  const helpResult = await run(["--help"]);
  assert.equal(helpResult.code, 0);
  assert.match(helpResult.stdout, /emit --json FILE/);
  assert.match(helpResult.stdout, /emit --stdin/);
});
