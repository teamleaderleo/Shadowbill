import assert from "node:assert/strict";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { normalizeRepositoryPolicy, repositoryPolicyDigest } from "../src/repository-policy.js";

function proposal(root, repository = "example/project") {
  const policy = normalizeRepositoryPolicy({
    version: 1,
    repository,
    expectedSignals: [{ kind: "verify", required: true, staleAfterHours: 0, scope: "revision" }],
    adapters: {},
  });
  return {
    repository,
    root,
    rootIdentity: { device: "1", inode: "2" },
    configuration: { source: "autodetected", path: null, digest: repositoryPolicyDigest(policy) },
    policy,
  };
}

async function temporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-registry-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("enrols idempotently with owner-only permissions", async () => {
  await temporaryDirectory(async (directory) => {
    const path = join(directory, "repositories.json");
    const store = new RepositoryRegistryStore(path);
    const first = await store.enroll(proposal(join(directory, "repo")), { now: new Date("2026-07-26T12:00:00.000Z") });
    const second = await store.enroll(proposal(join(directory, "repo")), { now: new Date("2026-07-26T13:00:00.000Z") });
    assert.equal(first.status, "inserted");
    assert.equal(second.status, "unchanged");
    assert.equal((await store.read()).entries.length, 1);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test("serializes concurrent registry writers", async () => {
  await temporaryDirectory(async (directory) => {
    const path = join(directory, "repositories.json");
    const left = new RepositoryRegistryStore(path);
    const right = new RepositoryRegistryStore(path);
    await Promise.all([
      left.enroll(proposal(join(directory, "left"), "example/left")),
      right.enroll(proposal(join(directory, "right"), "example/right")),
    ]);
    assert.deepEqual((await left.read()).entries.map((entry) => entry.repository), ["example/left", "example/right"]);
  });
});

test("rejects a symbolic-link registry", { skip: process.platform === "win32" }, async () => {
  await temporaryDirectory(async (directory) => {
    const target = join(directory, "target.json");
    const path = join(directory, "repositories.json");
    await writeFile(target, '{"version":1,"entries":[]}');
    await symlink(target, path);
    await assert.rejects(new RepositoryRegistryStore(path).read(), (error) => error.code === "REPOSITORY_REGISTRY_SYMLINK");
  });
});

test("rejects repository and root conflicts", async () => {
  await temporaryDirectory(async (directory) => {
    const store = new RepositoryRegistryStore(join(directory, "repositories.json"));
    await store.enroll(proposal(join(directory, "one")));
    await assert.rejects(store.enroll(proposal(join(directory, "two"))), (error) => error.code === "REPOSITORY_ENROLLMENT_CONFLICT");
    await assert.rejects(
      store.enroll(proposal(join(directory, "one"), "example/other")),
      (error) => error.code === "REPOSITORY_ROOT_CONFLICT",
    );
  });
});
