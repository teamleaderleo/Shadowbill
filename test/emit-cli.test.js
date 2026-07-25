import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cliPath = resolve("src/proofwake-cli.js");
const fixturePath = resolve("test/fixtures/observations/renderprove-browser-review-passed-v1.json");

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
    child.stdin.end(input);
  });
}

test("emit inserts once, replays exactly, and rejects changed semantics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-emit-"));
  const dataPath = join(directory, "events.jsonl");
  const conflictingPath = join(directory, "conflicting.json");
  try {
    const first = await runEmit(["--json", fixturePath, "--data", dataPath]);
    assert.equal(first.code, 0);
    assert.equal(first.stderr, "");
    const firstResult = JSON.parse(first.stdout);
    assert.equal(firstResult.accepted, true);
    assert.equal(firstResult.duplicate, false);
    assert.equal(firstResult.source, "urn:proofwake:adapter:renderprove");
    assert.equal(firstResult.id, "renderprove.fixture-web-app.aaaaaaaaaaaaaaaa");
    assert.match(firstResult.fingerprint, /^sha256:[a-f0-9]{64}$/);

    const replay = await runEmit(["--json", fixturePath, "--data", dataPath]);
    assert.equal(replay.code, 0);
    assert.equal(replay.stderr, "");
    const replayResult = JSON.parse(replay.stdout);
    assert.equal(replayResult.duplicate, true);
    assert.equal(replayResult.fingerprint, firstResult.fingerprint);
    assert.equal(replayResult.ingestedAt, firstResult.ingestedAt);

    const conflicting = JSON.parse(await readFile(fixturePath, "utf8"));
    conflicting.data.status = "failed";
    await writeFile(conflictingPath, JSON.stringify(conflicting));
    const conflict = await runEmit(["--json", conflictingPath, "--data", dataPath]);
    assert.equal(conflict.code, 1);
    assert.equal(conflict.stdout, "");
    assert.match(conflict.stderr, /^OBSERVATION_ID_CONFLICT:/);

    const rows = (await readFile(dataPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, "proofwake_observation");
    assert.equal(rows[0].observation.data.status, "passed");
    assert.equal(rows[0].observation.data.ingestedAt, firstResult.ingestedAt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("emit accepts stdin and replaces the input ingestion timestamp", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-emit-stdin-"));
  const dataPath = join(directory, "events.jsonl");
  try {
    const source = await readFile(fixturePath);
    const inputIngestedAt = JSON.parse(source.toString("utf8")).data.ingestedAt;
    const result = await runEmit(["--stdin", "--data", dataPath], source);
    assert.equal(result.code, 0);
    const response = JSON.parse(result.stdout);
    assert.notEqual(response.ingestedAt, inputIngestedAt);
    const stored = JSON.parse((await readFile(dataPath, "utf8")).trim());
    assert.equal(stored.observation.data.ingestedAt, response.ingestedAt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("emit keeps legacy and observation identity domains independent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-emit-legacy-"));
  const dataPath = join(directory, "events.jsonl");
  const observation = JSON.parse(await readFile(fixturePath, "utf8"));
  try {
    await writeFile(dataPath, `${JSON.stringify({
      type: "git_commit",
      id: observation.id,
      timestamp: observation.time,
      repository: "teamleaderleo/renderprove",
    })}\n`);
    const result = await runEmit(["--json", fixturePath, "--data", dataPath]);
    assert.equal(result.code, 0);
    const rows = (await readFile(dataPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, observation.id);
    assert.match(rows[1].id, /^proofwake_observation_[a-f0-9]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("emit rejects ambiguous, oversized, and invalid UTF-8 stdin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-emit-input-"));
  const dataPath = join(directory, "events.jsonl");
  try {
    const missing = await runEmit(["--data", dataPath]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /^OBSERVATION_INPUT_REQUIRED:/);

    const oversized = await runEmit(["--stdin", "--data", dataPath], Buffer.alloc(65_537, 0x20));
    assert.equal(oversized.code, 1);
    assert.match(oversized.stderr, /^OBSERVATION_TOO_LARGE:/);

    const invalidUtf8 = await runEmit(["--stdin", "--data", dataPath], Buffer.from([0xff]));
    assert.equal(invalidUtf8.code, 1);
    assert.match(invalidUtf8.stderr, /^OBSERVATION_INVALID_UTF8:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("emit rejects symbolic-link files and never echoes rejected values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-emit-file-"));
  const dataPath = join(directory, "events.jsonl");
  const privatePath = join(directory, "private.json");
  const linkPath = join(directory, "linked.json");
  const privateValue = "private-value-that-must-not-be-echoed";
  try {
    await writeFile(privatePath, JSON.stringify({ prompt: privateValue }));
    await symlink(privatePath, linkPath);
    const linked = await runEmit(["--json", linkPath, "--data", dataPath]);
    assert.equal(linked.code, 1);
    assert.match(linked.stderr, /^OBSERVATION_INPUT_UNSAFE:/);
    assert.doesNotMatch(linked.stderr, new RegExp(privateValue));

    const rejected = await runEmit(["--json", privatePath, "--data", dataPath]);
    assert.equal(rejected.code, 1);
    assert.equal(rejected.stdout, "");
    assert.doesNotMatch(rejected.stderr, new RegExp(privateValue));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
