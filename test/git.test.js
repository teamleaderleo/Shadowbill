import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { collectHeadCommit, installPostCommitHook } from "../src/git.js";

const exec = promisify(execFile);

async function git(repo, ...args) {
  await exec("git", ["-C", repo, ...args]);
}

test("collects added-code telemetry and preserves a shell hook", async () => {
  const repo = await mkdtemp(join(tmpdir(), "shadowbill-git-"));
  try {
    await git(repo, "init", "-q");
    await git(repo, "config", "user.email", "shadowbill@example.test");
    await git(repo, "config", "user.name", "Shadowbill");
    await git(repo, "remote", "add", "origin", "https://github.com/example/demo.git");
    await writeFile(join(repo, "example.js"), "export const answer = 42;\n", "utf8");
    await git(repo, "add", "example.js");
    await git(repo, "commit", "-q", "-m", "Add answer");

    const event = await collectHeadCommit(repo);
    assert.equal(event.repository, "example/demo");
    assert.equal(event.additions, 1);
    assert.ok(event.addedCodeTokens > 0);

    const hookPath = join(repo, ".git", "hooks", "post-commit");
    await writeFile(hookPath, "#!/bin/sh\necho existing\n", { mode: 0o755 });
    await installPostCommitHook(repo, "/tmp/shadowbill.js");
    await installPostCommitHook(repo, "/tmp/shadowbill.js");
    const hook = await readFile(hookPath, "utf8");
    assert.match(hook, /echo existing/);
    assert.equal((hook.match(/# shadowbill:post-commit/g) ?? []).length, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
