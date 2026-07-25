import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { COMMAND_OUTPUT_LIMIT_BYTES, executeLocalCommand } from "../src/run.js";
import { JsonlEventStore } from "../src/store.js";

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function repository(root, { remote = "example/project" } = {}) {
  await mkdir(root, { recursive: true });
  await execFileAsync("git", ["init", "-q", root]);
  await git(root, "config", "user.email", "proofwake@example.invalid");
  await git(root, "config", "user.name", "Proofwake Test");
  if (remote) await git(root, "remote", "add", "origin", `https://github.com/${remote}.git`);
  await writeFile(join(root, "package.json"), '{}\n');
  await git(root, "add", "package.json");
  await git(root, "commit", "-qm", "initial");
  return git(root, "rev-parse", "HEAD");
}

async function temporary(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-run-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("records a valid passing receipt without raw command content", async () => {
  await temporary(async (directory) => {
    const root = join(directory, "repo");
    const revision = await repository(root);
    const dataPath = join(directory, "events.jsonl");
    const result = await quiet(() => executeLocalCommand({
      repository: "example/project",
      kind: "verify",
      command: [process.execPath, "-e", 'console.log("private-output"); console.error("private-error")'],
      cwd: root,
      outputMode: "json",
      runId: "passing-fixture",
      store: new JsonlEventStore(dataPath),
    }));

    assert.equal(result.cliExitCode, 0);
    assert.equal(result.observation.data.status, "passed");
    assert.equal(result.revision, revision);
    assert.equal(result.observation.data.relationships.run, "passing-fixture");
    assert.equal(result.observation.data.coverage.state, "complete");
    assert.equal(result.stdout.lines, 1);
    assert.equal(result.stderr.lines, 1);
    const facts = factMap(result.observation);
    assert.equal(facts.get("proofwake.command.arguments-retained"), false);
    assert.equal(facts.get("proofwake.command.environment-retained"), false);
    assert.equal(facts.get("proofwake.command.repository-binding"), "remote-verified");
    const ledger = await readFile(dataPath, "utf8");
    assert.doesNotMatch(ledger, /private-output|private-error/u);
    assert.doesNotMatch(ledger, /process\.execPath|console\.log/u);
  });
});

test("preserves a nonzero child exit in the receipt and CLI contract", async () => {
  await temporary(async (directory) => {
    const root = join(directory, "repo");
    await repository(root);
    const result = await quiet(() => executeLocalCommand({
      repository: "example/project",
      kind: "verify",
      command: [process.execPath, "-e", "process.exit(7)"],
      cwd: root,
      outputMode: "json",
      store: new JsonlEventStore(join(directory, "events.jsonl")),
    }));
    assert.equal(result.cliExitCode, 7);
    assert.equal(result.failureCode, "exit-nonzero");
    assert.equal(result.observation.data.status, "failed");
    assert.equal(factMap(result.observation).get("proofwake.command.exit-code"), 7);
  });
});

test("times out and records one terminal receipt", async () => {
  await temporary(async (directory) => {
    const root = join(directory, "repo");
    await repository(root);
    const result = await quiet(() => executeLocalCommand({
      repository: "example/project",
      kind: "verify",
      command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      cwd: root,
      timeoutMs: 50,
      outputMode: "json",
      store: new JsonlEventStore(join(directory, "events.jsonl")),
    }));
    assert.equal(result.cliExitCode, 124);
    assert.equal(result.failureCode, "timeout");
    assert.equal(result.timedOut, true);
    assert.equal(result.observation.data.status, "failed");
  });
});

test("bounds visible output and marks truncated coverage", async () => {
  await temporary(async (directory) => {
    const root = join(directory, "repo");
    await repository(root);
    const result = await quiet(() => executeLocalCommand({
      repository: "example/project",
      kind: "verify",
      command: [process.execPath, "-e", `process.stdout.write("x".repeat(${COMMAND_OUTPUT_LIMIT_BYTES + 65536}))`],
      cwd: root,
      outputMode: "json",
      store: new JsonlEventStore(join(directory, "events.jsonl")),
    }));
    assert.equal(result.cliExitCode, 125);
    assert.equal(result.failureCode, "output-limit");
    assert.equal(result.outputLimited, true);
    assert.equal(result.observation.data.coverage.state, "partial");
    assert.equal(result.observation.data.coverage.truncated, true);
    assert.deepEqual(result.observation.data.coverage.omitted, ["proofwake.command.truncated.stdout"]);
  });
});

test("records spawn failure as unavailable evidence", async () => {
  await temporary(async (directory) => {
    const root = join(directory, "repo");
    await repository(root);
    const result = await quiet(() => executeLocalCommand({
      repository: "example/project",
      kind: "verify",
      command: [join(directory, "missing-executable")],
      cwd: root,
      outputMode: "json",
      store: new JsonlEventStore(join(directory, "events.jsonl")),
    }));
    assert.equal(result.cliExitCode, 127);
    assert.equal(result.failureCode, "spawn-failed");
    assert.equal(result.observation.data.status, "unavailable");
  });
});

test("an explicit run ID replays the stored result without rerunning", async () => {
  await temporary(async (directory) => {
    const root = join(directory, "repo");
    await repository(root);
    const marker = join(directory, "marker.txt");
    const command = [
      process.execPath,
      "-e",
      `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x")`,
    ];
    const store = new JsonlEventStore(join(directory, "events.jsonl"));
    const first = await quiet(() => executeLocalCommand({
      repository: "example/project",
      kind: "verify",
      command,
      cwd: root,
      runId: "replay-fixture",
      outputMode: "json",
      store,
    }));
    const second = await quiet(() => executeLocalCommand({
      repository: "example/project",
      kind: "verify",
      command,
      cwd: root,
      runId: "replay-fixture",
      outputMode: "json",
      store,
    }));
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.storageStatus, "duplicate");
    assert.equal(await readFile(marker, "utf8"), "x");
  });
});

test("run ID reuse with different command semantics fails closed", async () => {
  await temporary(async (directory) => {
    const root = join(directory, "repo");
    await repository(root);
    const store = new JsonlEventStore(join(directory, "events.jsonl"));
    await quiet(() => executeLocalCommand({
      repository: "example/project",
      kind: "verify",
      command: [process.execPath, "-e", ""],
      cwd: root,
      runId: "conflict-fixture",
      outputMode: "json",
      store,
    }));
    await assert.rejects(
      quiet(() => executeLocalCommand({
        repository: "example/project",
        kind: "verify",
        command: [process.execPath, "-e", "process.exit(1)"],
        cwd: root,
        runId: "conflict-fixture",
        outputMode: "json",
        store,
      })),
      (error) => error.code === "PROOFWAKE_RUN_ID_CONFLICT",
    );
  });
});

test("rejects repository mismatch when canonical remotes exist", async () => {
  await temporary(async (directory) => {
    const root = join(directory, "repo");
    await repository(root);
    await assert.rejects(
      executeLocalCommand({
        repository: "other/project",
        kind: "verify",
        command: [process.execPath, "-e", ""],
        cwd: root,
        store: new JsonlEventStore(join(directory, "events.jsonl")),
      }),
      (error) => error.code === "PROOFWAKE_RUN_REPOSITORY_MISMATCH",
    );
  });
});

test("rejects a symbolic-link working directory", { skip: process.platform === "win32" }, async () => {
  await temporary(async (directory) => {
    const root = join(directory, "repo");
    await repository(root);
    const linked = join(directory, "linked-repo");
    await symlink(root, linked, "dir");
    await assert.rejects(
      executeLocalCommand({
        repository: "example/project",
        kind: "verify",
        command: [process.execPath, "-e", ""],
        cwd: linked,
        store: new JsonlEventStore(join(directory, "events.jsonl")),
      }),
      (error) => error.code === "PROOFWAKE_RUN_CWD_SYMLINK",
    );
  });
});

test("rejects nested invocation marker", async () => {
  await temporary(async (directory) => {
    const root = join(directory, "repo");
    await repository(root);
    const prior = process.env.PROOFWAKE_RUN_ACTIVE;
    process.env.PROOFWAKE_RUN_ACTIVE = "parent";
    try {
      await assert.rejects(
        executeLocalCommand({
          repository: "example/project",
          kind: "verify",
          command: [process.execPath, "-e", ""],
          cwd: root,
          store: new JsonlEventStore(join(directory, "events.jsonl")),
        }),
        (error) => error.code === "PROOFWAKE_RUN_NESTED",
      );
    } finally {
      if (prior === undefined) delete process.env.PROOFWAKE_RUN_ACTIVE;
      else process.env.PROOFWAKE_RUN_ACTIVE = prior;
    }
  });
});
