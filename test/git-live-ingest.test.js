import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { canonicalRemoteRepositoryIdentity, collectHeadCommit } from "../src/git.js";

const exec = promisify(execFile);

async function git(repo, ...args) {
  await exec("git", ["-C", repo, ...args], { encoding: "utf8" });
}

test("canonical observation identity requires a bounded GitHub owner/name remote", () => {
  assert.equal(canonicalRemoteRepositoryIdentity("https://github.com/Owner/Repo.git"), "owner/repo");
  assert.equal(canonicalRemoteRepositoryIdentity("git@github.com:Owner/Repo.git"), "owner/repo");
  assert.equal(canonicalRemoteRepositoryIdentity("ssh://git@github.com/Owner/Repo.git"), "owner/repo");
  assert.equal(canonicalRemoteRepositoryIdentity("https://git.example.test/owner/repo.git"), null);
  assert.equal(canonicalRemoteRepositoryIdentity("https://git.example.test/repo.git"), null);
  assert.equal(canonicalRemoteRepositoryIdentity("git@git.example.test:Owner/Repo.git"), null);
  assert.equal(canonicalRemoteRepositoryIdentity("file://github.com/private/repo.git"), null);
  assert.equal(canonicalRemoteRepositoryIdentity(""), null);
});

test("collectHeadCommit remains the legacy compatibility API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-git-compatibility-api-"));
  const repo = join(directory, "checkout");
  try {
    await mkdir(repo);
    await git(repo, "init", "-q");
    await git(repo, "config", "user.email", "proofwake@example.test");
    await git(repo, "config", "user.name", "Proofwake Test");
    await git(repo, "remote", "add", "origin", "https://github.com/Owner/Repo.git");
    await writeFile(join(repo, "private-file.js"), "export const answer = 42;\n", "utf8");
    await git(repo, "add", "private-file.js");
    await git(repo, "commit", "-q", "-m", "Legacy subject remains available to compatibility callers");

    const event = await collectHeadCommit(repo);
    assert.equal(event.type, "git_commit");
    assert.equal(event.repository, "Owner/Repo");
    assert.equal(event.subject, "Legacy subject remains available to compatibility callers");
    assert.match(event.sha, /^[a-f0-9]{40}$/u);
    assert.ok(event.addedCodeTokens > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
