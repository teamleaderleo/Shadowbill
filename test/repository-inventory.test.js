import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ObservationLedger } from "../src/observation-ledger.js";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { buildRepositoryInventory } from "../src/repository-inventory.js";
import { normalizeRepositoryPolicy, repositoryPolicyDigest } from "../src/repository-policy.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { JsonlEventStore } from "../src/store.js";

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function createRepository(root) {
  await execFileAsync("git", ["init", "-b", "main", root], { encoding: "utf8" });
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "package.json"), '{"scripts":{"test":"node --test"}}\n');
  await git(root, "add", "package.json");
  await git(root, "commit", "-m", "initial");
  await git(root, "remote", "add", "origin", "https://github.com/example/project.git");
  return git(root, "rev-parse", "HEAD");
}

async function temporaryDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-inventory-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function verifyObservation(repository, revision, { status = "passed", observedAt = "2026-07-26T10:00:00.000Z", coverage = "complete" } = {}) {
  return {
    specversion: "1.0",
    id: `verify.${revision}.${status}.${observedAt.replaceAll(/\W/g, "")}`,
    source: "urn:proofwake:test:verify",
    type: "dev.proofwake.observation.verify.v1",
    subject: `repo:${repository}@sha:${revision}`,
    time: observedAt,
    dataschema: "urn:proofwake:schema:observation:v1",
    data: {
      schemaVersion: 1,
      adapter: {
        name: "test",
        version: "1.0.0",
        mappingVersion: 1,
        trust: "local-operator",
        sourceSchema: "test.verify",
        sourceSchemaVersion: "1",
      },
      kind: "verify",
      status,
      timeSource: "adapter",
      observedAt,
      ingestedAt: observedAt,
      relationships: { repository, revision },
      facts: [{ name: "test.verify.exit", value: status === "passed" ? 0 : 1 }],
      evidence: [],
      coverage: { state: coverage, redacted: false, truncated: false, omitted: [] },
    },
  };
}

test("reports unobserved then active green repository", async () => {
  await temporaryDirectory(async (directory) => {
    const root = join(directory, "repo");
    const revision = await createRepository(root);
    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    const proposal = await inspectRepositoryEnrollment(root);
    await registryStore.enroll(proposal, { now: new Date("2026-07-26T09:00:00.000Z") });

    const empty = await buildRepositoryInventory({ registryStore, eventStore, now: new Date("2026-07-26T11:00:00.000Z") });
    assert.equal(empty.repositories[0].classification, "unobserved");
    assert.equal(empty.repositories[0].health, "yellow");
    assert.equal(empty.repositories[0].latestRevision, revision);
    assert.equal(empty.repositories[0].latestRevisionSource, "checkout");
    assert.equal(empty.repositories[0].checkoutBranch, "main");
    assert.equal(empty.repositories[0].signals[0].state, "missing");

    await new ObservationLedger(eventStore).append(verifyObservation("example/project", revision));
    const active = await buildRepositoryInventory({ registryStore, eventStore, now: new Date("2026-07-26T11:00:00.000Z") });
    assert.equal(active.repositories[0].classification, "active");
    assert.equal(active.repositories[0].health, "green");
    assert.equal(active.repositories[0].latestRevision, revision);
    assert.equal(active.repositories[0].signals[0].state, "passed");
  });
});


test("checkout revision supersedes older revision evidence", async () => {
  await temporaryDirectory(async (directory) => {
    const root = join(directory, "repo");
    const firstRevision = await createRepository(root);
    const proposal = await inspectRepositoryEnrollment(root);
    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    await registryStore.enroll(proposal);
    await new ObservationLedger(eventStore).append(verifyObservation("example/project", firstRevision));

    await writeFile(join(root, "next.txt"), "next\n");
    await git(root, "add", "next.txt");
    await git(root, "commit", "-m", "next");
    const secondRevision = await git(root, "rev-parse", "HEAD");

    const report = await buildRepositoryInventory({ registryStore, eventStore, now: new Date("2026-07-26T11:00:00.000Z") });
    assert.equal(report.repositories[0].latestRevision, secondRevision);
    assert.equal(report.repositories[0].latestRevisionSource, "checkout");
    assert.equal(report.repositories[0].signals[0].state, "missing");
    assert.equal(report.repositories[0].health, "yellow");
  });
});

test("reports stale required evidence", async () => {
  await temporaryDirectory(async (directory) => {
    const root = join(directory, "repo");
    const revision = await createRepository(root);
    const proposal = await inspectRepositoryEnrollment(root);
    const policy = normalizeRepositoryPolicy({
      version: 1,
      repository: proposal.repository,
      expectedSignals: [{ kind: "verify", required: true, staleAfterHours: 1, scope: "repository" }],
      adapters: {},
    });
    proposal.policy = policy;
    proposal.configuration = { source: "autodetected", path: null, digest: repositoryPolicyDigest(policy) };
    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    await registryStore.enroll(proposal);
    await new ObservationLedger(eventStore).append(verifyObservation("example/project", revision, { observedAt: "2026-07-26T08:00:00.000Z" }));
    const report = await buildRepositoryInventory({ registryStore, eventStore, now: new Date("2026-07-26T12:00:00.000Z") });
    assert.equal(report.repositories[0].signals[0].state, "stale");
    assert.equal(report.repositories[0].health, "yellow");
  });
});

test("marks missing roots and global-committed conflicts as misconfigured", async () => {
  await temporaryDirectory(async (directory) => {
    const root = join(directory, "repo");
    await createRepository(root);
    const proposal = await inspectRepositoryEnrollment(root);
    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    await registryStore.enroll(proposal);
    await writeFile(join(root, ".proofwake.json"), JSON.stringify(proposal.policy));
    const conflict = await buildRepositoryInventory({ registryStore, eventStore });
    assert.equal(conflict.repositories[0].classification, "misconfigured");
    assert.equal(conflict.repositories[0].problems[0].code, "REPOSITORY_CONFIGURATION_CONFLICT");
    await rm(root, { recursive: true, force: true });
    const missing = await buildRepositoryInventory({ registryStore, eventStore });
    assert.equal(missing.repositories[0].classification, "misconfigured");
  });
});
