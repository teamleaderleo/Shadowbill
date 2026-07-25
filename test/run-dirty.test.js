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
  await exec("git", ["-C", root, ...args], { encoding: "utf8" });
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
    assert.equal(first.dirty, true);
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
      (error) => error.code === "PROOFWAKE_RUN_REPLAY_DIRTY",
    );
    assert.equal(await readFile(marker, "utf8"), "x");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
