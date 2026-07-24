import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { collectHeadCommit, installPostCommitHook, repositoryIdentifier, shellQuote } from "../src/git.js";

const exec = promisify(execFile);

async function git(repo, ...args) {
  await exec("git", ["-C", repo, ...args]);
}

async function initializeRepo(repo, remote = "https://github.com/example/demo.git") {
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "shadowbill@example.test");
  await git(repo, "config", "user.name", "Shadowbill");
  await git(repo, "remote", "add", "origin", remote);
  await writeFile(join(repo, "example.js"), "export const answer = 42;\n", "utf8");
  await git(repo, "add", "example.js");
  await git(repo, "commit", "-q", "-m", "Add answer");
}

async function waitForFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("sanitizes URL and SCP-style repository identifiers", () => {
  assert.equal(repositoryIdentifier("https://user:secret@github.com/example/demo.git?token=hidden#fragment", "fallback"), "example/demo");
  assert.equal(repositoryIdentifier("ssh://git@github.com/example/demo.git", "fallback"), "example/demo");
  assert.equal(repositoryIdentifier("git@github.com:example/demo.git", "fallback"), "example/demo");
  assert.equal(repositoryIdentifier("token@git.example.test:group/demo.git?credential=hidden", "fallback"), "git.example.test/group/demo");
  assert.equal(repositoryIdentifier("https://user:secret@git.example.test:8443/group/demo.git", "fallback"), "git.example.test/group/demo");
  assert.equal(repositoryIdentifier("file:///private/repo.git", "fallback"), "fallback");
  assert.equal(repositoryIdentifier("../private/repo.git", "fallback"), "fallback");
  assert.equal(repositoryIdentifier("", "fallback"), "fallback");
});

test("collects added-code telemetry without remote credentials", async () => {
  const repo = await mkdtemp(join(tmpdir(), "shadowbill-git-"));
  try {
    await initializeRepo(repo, "https://user:secret@github.com/example/demo.git?token=hidden");
    const event = await collectHeadCommit(repo);
    assert.equal(event.repository, "example/demo");
    assert.equal(event.additions, 1);
    assert.ok(event.addedCodeTokens > 0);
    assert.doesNotMatch(JSON.stringify(event), /secret|hidden|user:/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("preserves an existing shell hook once", async () => {
  const repo = await mkdtemp(join(tmpdir(), "shadowbill-git-hook-"));
  try {
    await initializeRepo(repo);
    const hookPath = join(repo, ".git", "hooks", "post-commit");
    await writeFile(hookPath, "#!/bin/sh\necho existing\n", { mode: 0o755 });
    await installPostCommitHook(repo, "/tmp/shadowbill.js");
    await installPostCommitHook(repo, "/tmp/shadowbill.js");
    const hook = await readFile(hookPath, "utf8");
    assert.match(hook, /echo existing/);
    assert.equal((hook.match(/# shadowbill:post-commit/g) ?? []).length, 1);
    assert.match(hook, new RegExp(shellQuote(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("hook quoting keeps substitutions inert and preserves exact paths", { skip: process.platform === "win32" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "shadowbill-hook-quote-"));
  const repo = join(parent, "repo-$(touch${IFS}PWNED)-'quoted'");
  const cli = join(parent, "dummy cli 'quoted'.js");
  const resultPath = join(parent, "hook-result.json");
  try {
    await mkdir(repo);
    await initializeRepo(repo);
    await writeFile(cli, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.SHADOWBILL_HOOK_RESULT, JSON.stringify(process.argv.slice(2)));\n`, "utf8");
    const hookPath = await installPostCommitHook(repo, cli);
    await exec(hookPath, [], { cwd: repo, env: { ...process.env, SHADOWBILL_HOOK_RESULT: resultPath } });
    const args = JSON.parse(await waitForFile(resultPath));
    assert.deepEqual(args, ["ingest-git", "--repo", repo]);
    await assert.rejects(stat(join(repo, "PWNED")), (error) => error.code === "ENOENT");
    const hook = await readFile(hookPath, "utf8");
    assert.doesNotMatch(hook, /\bnode\s/);
    assert.equal(hook.includes("'\\''"), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
