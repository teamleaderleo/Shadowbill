import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { repositoryPolicyFingerprint } from "../src/repository-policy.js";

function policy(id = "acme/demo") {
  return {
    version: 1,
    repository: { kind: "remote", id, provider: "github" },
    lifecycle: { state: "active", dormantAfterDays: 30 },
    signals: [{
      kind: "verify",
      requirement: "required",
      subject: "revision",
      appliesTo: "every-revision",
      freshness: { mode: "revision" },
      acceptedSources: ["local-command"],
    }],
    adapters: [],
  };
}

function proposal(root, value = policy(), source = "committed") {
  return {
    repository: { identity: value.repository.id, label: value.repository.id, value: value.repository },
    root,
    rootIdentity: { device: "1", inode: "2" },
    configuration: {
      source,
      path: source === "committed" ? ".proofwake.json" : null,
      fingerprint: repositoryPolicyFingerprint(value),
    },
    policy: value,
  };
}

async function temporary(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-registry-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("registry persists committed enrolment across store restarts", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "repositories.json");
    const first = await new RepositoryRegistryStore(path).enroll(proposal(directory), {
      now: new Date("2026-07-26T12:00:00Z"),
    });
    assert.equal(first.status, "inserted");
    const registry = await new RepositoryRegistryStore(path).read();
    assert.equal(registry.entries.length, 1);
    assert.equal(registry.entries[0].repository.identity, "acme/demo");
    assert.equal(registry.entries[0].approval.method, "committed");
    assert.equal(registry.entries[0].enrolledAt, "2026-07-26T12:00:00.000Z");
    const raw = await readFile(path, "utf8");
    assert.doesNotMatch(raw, /token|secret|command/u);
  });
});

test("unchanged enrolment is idempotent and conflicting metadata requires replace", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "repositories.json");
    const store = new RepositoryRegistryStore(path);
    await store.enroll(proposal(directory));
    assert.equal((await store.enroll(proposal(directory))).status, "unchanged");
    const changed = policy("acme/renamed");
    await assert.rejects(
      store.enroll(proposal(directory, changed)),
      (error) => error.code === "REPOSITORY_ALREADY_ENROLLED",
    );
    const replaced = await store.enroll(proposal(directory, changed), { replace: true });
    assert.equal(replaced.status, "updated");
    assert.equal((await store.read()).entries[0].repository.identity, "acme/renamed");
  });
});

test("autodetected policy requires explicit approval and is stored as global policy", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "repositories.json");
    const store = new RepositoryRegistryStore(path);
    await assert.rejects(
      store.enroll(proposal(directory, policy(), "autodetected")),
      (error) => error.code === "REPOSITORY_APPROVAL_REQUIRED",
    );
    const accepted = await store.enroll(proposal(directory, policy(), "autodetected"), {
      approveAutodetected: true,
      now: new Date("2026-07-26T12:00:00Z"),
    });
    assert.equal(accepted.entry.configuration.source, "global");
    assert.equal(accepted.entry.approval.method, "autodetected");
  });
});

test("registry rejects duplicate identities and duplicate roots", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "repositories.json");
    const store = new RepositoryRegistryStore(path);
    await store.enroll(proposal(directory));
    const otherRoot = await mkdtemp(join(tmpdir(), "proofwake-registry-other-"));
    try {
      await assert.rejects(
        store.enroll(proposal(otherRoot)),
        (error) => error.code === "REPOSITORY_ALREADY_ENROLLED",
      );
      await assert.rejects(
        store.enroll(proposal(directory, policy("acme/other"))),
        (error) => error.code === "REPOSITORY_ALREADY_ENROLLED",
      );
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });
});
