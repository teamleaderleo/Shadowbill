import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { executeLocalCommand } from "../src/run.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function repository(root) {
  await mkdir(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Proofwake Test");
  await git(root, "config", "user.email", "proofwake@example.invalid");
  await git(root, "remote", "add", "origin", "https://github.com/example/project.git");
  await writeFile(join(root, "package.json"), '{}\n');
  await git(root, "add", "package.json");
  await git(root, "commit", "-qm", "initial");
}

async function quiet(callback) {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return await callback();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

function factMap(observation) {
  return new Map(observation.data.facts.map((entry) => [entry.name, entry.value]));
}

test("passing dirty worktree evidence is warning and cannot replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-run-dirty-"));
  try {
    const root = join(directory, "repo");
    const marker = join(directory, "marker.txt");
    const store = new JsonlEventStore(join(directory, "events.jsonl"));
    await repository(root);
    await writeFile(join(root, "uncommitted.txt"), "dirty\n");
    const command = [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x")`];

    const first = await quiet(() => executeLocalCommand({
      repository: "example/project",
      kind: "verify",
      command,
      cwd: root,
      runId: "dirty-fixture",
      outputMode: "json",
      store,
    }));
    assert.equal(first.cliExitCode, 0);
    assert.equal(first.dirtyBefore, true);
    assert.equal(first.observation.data.status, "warning");

    await assert.rejects(
      quiet(() => executeLocalCommand({
        repository: "example/project",
        kind: "verify",
        command,
        cwd: root,
        runId: "dirty-fixture",
        outputMode: "json",
        store,
      })),
      (error) => error.code === "PROOFWAKE_RUN_REPLAY_UNSTABLE",
    );
    assert.equal(await readFile(marker, "utf8"), "x");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a command that dirties the checkout produces warning evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-run-dirty-after-"));
  try {
    const root = join(directory, "repo");
    await repository(root);
    const generated = join(root, "generated.txt");
    const result = await quiet(() => executeLocalCommand({
      repository: "example/project",
      kind: "verify",
      command: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(generated)}, "generated")`],
      cwd: root,
      outputMode: "json",
      store: new JsonlEventStore(join(directory, "events.jsonl")),
    }));
    assert.equal(result.dirtyBefore, false);
    assert.equal(result.dirtyAfter, true);
    assert.equal(result.observation.data.status, "warning");
    const facts = factMap(result.observation);
    assert.equal(facts.get("proofwake.command.dirty-worktree-before"), false);
    assert.equal(facts.get("proofwake.command.dirty-worktree-after"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a command that changes HEAD remains bound to the starting revision and warns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-run-revision-change-"));
  try {
    const root = join(directory, "repo");
    await repository(root);
    const startingRevision = await git(root, "rev-parse", "HEAD");
    const result = await quiet(() => executeLocalCommand({
      repository: "example/project",
      kind: "verify",
      command: ["git", "commit", "--allow-empty", "-m", "generated"],
      cwd: root,
      outputMode: "json",
      store: new JsonlEventStore(join(directory, "events.jsonl")),
    }));
    assert.equal(result.revision, startingRevision);
    assert.equal(result.revisionChanged, true);
    assert.notEqual(result.revisionAfter, startingRevision);
    assert.equal(result.observation.data.relationships.revision, startingRevision);
    assert.equal(result.observation.data.status, "warning");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("post-run Git inspection failure still leaves a warning receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-run-post-inspection-"));
  try {
    const root = join(directory, "repo");
    await repository(root);
    const gitDirectory = join(root, ".git");
    const result = await quiet(() => executeLocalCommand({
      repository: "example/project",
      kind: "verify",
      command: [process.execPath, "-e", `require("node:fs").rmSync(${JSON.stringify(gitDirectory)}, { recursive: true, force: true })`],
      cwd: root,
      outputMode: "json",
      store: new JsonlEventStore(join(directory, "events.jsonl")),
    }));
    assert.equal(result.postInspectionUnavailable, true);
    assert.equal(result.observation.data.status, "warning");
    assert.equal(factMap(result.observation).get("proofwake.command.post-inspection-unavailable"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
