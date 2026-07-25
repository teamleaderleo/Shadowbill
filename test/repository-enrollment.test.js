import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { REPOSITORY_POLICY_SCHEMA } from "../src/repository-policy.js";

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function createRepository(directory, { remote, commit = true } = {}) {
  await mkdir(directory, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", directory], { encoding: "utf8" });
  await git(directory, "config", "user.email", "test@example.com");
  await git(directory, "config", "user.name", "Test");
  await writeFile(join(directory, "package.json"), '{"scripts":{"test":"node --test"}}\n');
  if (commit) {
    await git(directory, "add", "package.json");
    await git(directory, "commit", "-m", "initial");
  }
  if (remote) await git(directory, "remote", "add", "origin", remote);
  return directory;
}

async function temporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-enrollment-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("detects origin identity and verification policy", async () => {
  await temporaryDirectory(async (directory) => {
    const root = await createRepository(join(directory, "repo"), { remote: "git@github.com:example/project.git" });
    const proposal = await inspectRepositoryEnrollment(root);
    assert.equal(proposal.repository, "example/project");
    assert.equal(proposal.configuration.source, "autodetected");
    assert.equal(proposal.policy.expectedSignals[0].kind, "verify");
    assert.match(proposal.revision, /^[a-f0-9]{40}$/);
    assert.equal(proposal.branch, "main");
  });
});

test("creates explicit local identity when no remote exists", async () => {
  await temporaryDirectory(async (directory) => {
    const root = await createRepository(join(directory, "Local Project"));
    const proposal = await inspectRepositoryEnrollment(root);
    assert.match(proposal.repository, /^local\/local-project-[a-f0-9]{10}$/);
    assert.equal(proposal.warnings.length, 1);
  });
});

test("rejects ambiguous canonical remotes without origin", async () => {
  await temporaryDirectory(async (directory) => {
    const root = await createRepository(join(directory, "repo"));
    await git(root, "remote", "add", "left", "https://github.com/example/left.git");
    await git(root, "remote", "add", "right", "https://github.com/example/right.git");
    await assert.rejects(inspectRepositoryEnrollment(root), (error) => error.code === "REPOSITORY_REMOTE_AMBIGUOUS");
    const proposal = await inspectRepositoryEnrollment(root, { repository: "example/selected" });
    assert.equal(proposal.repository, "example/selected");
  });
});

test("committed policy is authoritative and detached HEAD is visible", async () => {
  await temporaryDirectory(async (directory) => {
    const root = await createRepository(join(directory, "repo"), { remote: "https://github.com/example/project.git" });
    const policy = {
      $schema: REPOSITORY_POLICY_SCHEMA,
      version: 1,
      repository: "example/project",
      lifecycle: "dormant",
      expectedSignals: [],
      adapters: {},
    };
    await writeFile(join(root, ".proofwake.json"), JSON.stringify(policy));
    await git(root, "add", ".proofwake.json");
    await git(root, "commit", "-m", "policy");
    await git(root, "checkout", "--detach");
    const proposal = await inspectRepositoryEnrollment(root);
    assert.equal(proposal.configuration.source, "committed");
    assert.equal(proposal.policy.lifecycle, "dormant");
    assert.equal(proposal.branch, null);
    await assert.rejects(
      inspectRepositoryEnrollment(root, { lifecycle: "active" }),
      (error) => error.code === "REPOSITORY_LIFECYCLE_CONFLICT",
    );
  });
});

test("requires committed policy to be tracked and clean", async () => {
  await temporaryDirectory(async (directory) => {
    const root = await createRepository(join(directory, "repo"), { remote: "https://github.com/example/project.git" });
    const policy = {
      version: 1,
      repository: "example/project",
      expectedSignals: [],
      adapters: {},
    };
    await writeFile(join(root, ".proofwake.json"), JSON.stringify(policy));
    await assert.rejects(inspectRepositoryEnrollment(root), (error) => error.code === "REPOSITORY_POLICY_UNTRACKED");
    await git(root, "add", ".proofwake.json");
    await git(root, "commit", "-m", "policy");
    await writeFile(join(root, ".proofwake.json"), JSON.stringify({ ...policy, lifecycle: "dormant" }));
    await assert.rejects(inspectRepositoryEnrollment(root), (error) => error.code === "REPOSITORY_POLICY_DIRTY");
  });
});

test("rejects symlinked committed policy", { skip: process.platform === "win32" }, async () => {
  await temporaryDirectory(async (directory) => {
    const root = await createRepository(join(directory, "repo"));
    const outside = join(directory, "outside.json");
    await writeFile(outside, JSON.stringify({ version: 1, repository: "example/project", expectedSignals: [], adapters: {} }));
    await symlink(outside, join(root, ".proofwake.json"));
    await assert.rejects(inspectRepositoryEnrollment(root), (error) => error.code === "REPOSITORY_POLICY_SYMLINK");
  });
});
