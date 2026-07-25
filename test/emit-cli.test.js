import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cliPath = resolve("src/proofwake-cli.js");
const fixturePath = resolve("test/fixtures/observation-valid.json");

function runEmit(arguments_, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, "emit", ...arguments_], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

test("emit stores one effect, replays exactly, and rejects semantic conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-emit-"));
  const dataPath = join(directory, "events.jsonl");
  const conflictPath = join(directory, "conflict.json");
  try {
    const first = await runEmit(["--json", fixturePath, "--data", dataPath]);
    assert.equal(first.code, 0);
    assert.equal(first.stderr, "");
    const firstResult = JSON.parse(first.stdout);
    assert.equal(firstResult.accepted, true);
    assert.equal(firstResult.duplicate, false);
    assert.equal(firstResult.source, "urn:proofwake:adapter:local-cli");
    assert.equal(firstResult.id, "local-verify-1");

    const replay = await runEmit(["--json", fixturePath, "--data", dataPath]);
    assert.equal(replay.code, 0);
    assert.equal(replay.stderr, "");
    const replayResult = JSON.parse(replay.stdout);
    assert.equal(replayResult.duplicate, true);
    assert.equal(replayResult.fingerprint, firstResult.fingerprint);
    assert.equal(replayResult.ingestedAt, firstResult.ingestedAt);

    const conflicting = JSON.parse(await readFile(fixturePath, "utf8"));
    conflicting.data.status = "failed";
    await writeFile(conflictPath, JSON.stringify(conflicting));
    const conflict = await runEmit(["--json", conflictPath, "--data", dataPath]);
    assert.equal(conflict.code, 1);
    assert.equal(conflict.stdout, "");
    assert.match(conflict.stderr, /^PW_IDEMPOTENCY_CONFLICT:/);

    const lines = (await readFile(dataPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const stored = JSON.parse(lines[0]);
    assert.equal(stored.proofwakefingerprint, firstResult.fingerprint);
    assert.equal(stored.proofwakeschema, "1");
    assert.equal(stored.data.status, "passed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("emit accepts bounded UTF-8 on stdin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-emit-stdin-"));
  const dataPath = join(directory, "events.jsonl");
  try {
    const input = await readFile(fixturePath, "utf8");
    const result = await runEmit(["--stdin", "--data", dataPath], input);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).duplicate, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("emit rejects ambiguous input and duplicate JSON keys with stable codes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-emit-errors-"));
  const dataPath = join(directory, "events.jsonl");
  try {
    const missing = await runEmit(["--data", dataPath]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /^PW_INPUT_REQUIRED:/);

    const duplicate = await runEmit(["--stdin", "--data", dataPath], '{"id":"one","id":"two"}');
    assert.equal(duplicate.code, 1);
    assert.match(duplicate.stderr, /^PW_JSON_DUPLICATE_KEY:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
