import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";

const exec = promisify(execFile);

function policy(repository = "acme/demo", extraSignals = []) {
  return {
    version: 1,
    repository: { kind: "remote", id: repository, provider: "github" },
    lifecycle: { state: "active", dormantAfterDays: 30 },
    signals: [
      {
        kind: "verify",
        requirement: "required",
        subject: "revision",
        appliesTo: "every-revision",
        freshness: { mode: "revision" },
        acceptedSources: ["local-command"],
      },
      ...extraSignals,
    ],
    adapters: [],
  };
}

async function git(root, ...args) {
  return exec("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function repository(callback) {
  const root = await mkdtemp(join(tmpdir(), "proofwake-enroll-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Proofwake Test");
    await git(root, "config", "user.email", "proofwake@example.invalid");
    await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
    await git(root, "add", "package.json");
    await git(root, "commit", "-qm", "Initial");
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function commitPolicy(root, value) {
  await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(value, null, 2)}\n`);
  await git(root, "add", ".proofwake.json");
  await git(root, "commit", "-qm", "Add policy");
}

test("tracked committed policy matches a renamed remote and detached HEAD", async () => {
  await repository(async (root) => {
    await git(root, "remote", "add", "upstream", "git@github.com:acme/demo.git");
    await commitPolicy(root, policy());
    await git(root, "checkout", "--detach", "-q");
    const result = await inspectRepositoryEnrollment(root);
    assert.equal(result.repository.identity, "acme/demo");
    assert.equal(result.configuration.source, "committed");
    assert.equal(result.branch, null);
    assert.match(result.revision, /^[a-f0-9]{40}$/);
    assert.ok(result.warnings.some((warning) => /detached/u.test(warning)));
  });
});

test("multiple remotes are allowed when one matches committed policy", async () => {
  await repository(async (root) => {
    await git(root, "remote", "add", "origin", "https://github.com/other/project.git");
    await git(root, "remote", "add", "review", "https://github.com/acme/demo.git");
    await commitPolicy(root, policy());
    const result = await inspectRepositoryEnrollment(root);
    assert.equal(result.repository.identity, "acme/demo");
    assert.equal(result.remotes.length, 2);
  });
});

test("remote policy fails closed without a canonical remote or with a mismatch", async () => {
  await repository(async (root) => {
    await commitPolicy(root, policy());
    await assert.rejects(
      inspectRepositoryEnrollment(root),
      (error) => error.code === "REPOSITORY_REMOTE_MISSING",
    );
  });
  await repository(async (root) => {
    await git(root, "remote", "add", "origin", "https://github.com/other/project.git");
    await commitPolicy(root, policy());
    await assert.rejects(
      inspectRepositoryEnrollment(root),
      (error) => error.code === "REPOSITORY_REMOTE_MISMATCH",
    );
  });
});

test("committed policy must be tracked and clean", async () => {
  await repository(async (root) => {
    await git(root, "remote", "add", "origin", "https://github.com/acme/demo.git");
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy())}\n`);
    await assert.rejects(
      inspectRepositoryEnrollment(root),
      (error) => error.code === "REPOSITORY_POLICY_UNTRACKED",
    );
    await git(root, "add", ".proofwake.json");
    await git(root, "commit", "-qm", "Add policy");
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy("acme/demo", [{
      kind: "github-ci",
      requirement: "optional",
      subject: "revision",
      appliesTo: "default-branch",
      freshness: { mode: "revision" },
      acceptedSources: ["github"],
    }]))}\n`);
    await assert.rejects(
      inspectRepositoryEnrollment(root),
      (error) => error.code === "REPOSITORY_POLICY_DIRTY",
    );
  });
});

test("committed policy wins and conflicting global policy fails", async () => {
  await repository(async (root) => {
    await git(root, "remote", "add", "origin", "https://github.com/acme/demo.git");
    await commitPolicy(root, policy());
    const same = await inspectRepositoryEnrollment(root, { globalPolicy: policy() });
    assert.equal(same.configuration.source, "committed");
    await assert.rejects(
      inspectRepositoryEnrollment(root, { globalPolicy: policy("acme/demo", [{
        kind: "github-ci",
        requirement: "optional",
        subject: "revision",
        appliesTo: "default-branch",
        freshness: { mode: "revision" },
        acceptedSources: ["github"],
      }]) }),
      (error) => error.code === "REPOSITORY_CONFIGURATION_CONFLICT",
    );
  });
});

test("autodetection is a non-authoritative proposal for remote and local repositories", async () => {
  await repository(async (root) => {
    await git(root, "remote", "add", "origin", "https://github.com/acme/demo.git");
    const result = await inspectRepositoryEnrollment(root);
    assert.equal(result.configuration.source, "autodetected");
    assert.equal(result.repository.identity, "acme/demo");
    assert.ok(result.warnings.some((warning) => /proposal/u.test(warning)));
  });
  await repository(async (root) => {
    const result = await inspectRepositoryEnrollment(root);
    assert.equal(result.repository.value.kind, "local");
    assert.match(result.repository.identity, /^local:sha256:[a-f0-9]{64}$/);
  });
});
