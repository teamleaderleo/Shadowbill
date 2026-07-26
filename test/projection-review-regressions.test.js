import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildFleetProjection } from "../src/fleet-projection.js";
import { buildRevisionProjection } from "../src/inspect-projection.js";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { ObservationLedger } from "../src/observation-ledger.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function verifyPolicy(repository = "acme/demo") {
  return {
    version: 1,
    repository: { kind: "remote", id: repository, provider: "github" },
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

function githubPolicy(repository = "acme/demo") {
  return {
    version: 1,
    repository: { kind: "remote", id: repository, provider: "github" },
    lifecycle: { state: "active", dormantAfterDays: 30 },
    signals: [{
      kind: "github-ci",
      requirement: "required",
      subject: "revision",
      appliesTo: "default-branch",
      freshness: { mode: "revision" },
      acceptedSources: ["github"],
    }],
    adapters: [],
  };
}

function dormantPolicy(repository = "acme/demo") {
  return {
    version: 1,
    repository: { kind: "remote", id: repository, provider: "github" },
    lifecycle: { state: "dormant" },
    signals: [],
    adapters: [],
  };
}

function observation({ id, revision, kind = "verify", status = "passed", adapter = "local-command", observedAt = "2026-07-26T10:00:00.000Z" }) {
  return {
    specversion: "1.0",
    id,
    source: `urn:proofwake:adapter:${adapter}`,
    type: `dev.proofwake.observation.${kind}.v1`,
    subject: `repo:acme/demo@sha:${revision}`,
    time: observedAt,
    dataschema: "urn:proofwake:schema:observation:v1",
    data: {
      schemaVersion: 1,
      adapter: {
        name: adapter,
        version: "1.0.0",
        mappingVersion: 1,
        trust: adapter === "github" ? "signed-provider" : "local-operator",
        sourceSchema: "proofwake.test.fixture",
        sourceSchemaVersion: "1",
      },
      kind,
      status,
      timeSource: adapter === "github" ? "provider" : "adapter",
      observedAt,
      ingestedAt: new Date(Date.parse(observedAt) + 1000).toISOString(),
      relationships: { repository: "acme/demo", revision },
      facts: [],
      evidence: [],
      coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
    },
  };
}

async function fixture(value, callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-projection-review-"));
  const root = join(directory, "repo");
  try {
    await mkdir(root);
    await exec("git", ["init", "-q", "-b", "main", root]);
    await git(root, "config", "user.name", "Proofwake Test");
    await git(root, "config", "user.email", "proofwake@example.invalid");
    await git(root, "remote", "add", "origin", "https://github.com/acme/demo.git");
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(value, null, 2)}\n`);
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "initial");
    const revision = await git(root, "rev-parse", "HEAD");
    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    await registryStore.enroll(await inspectRepositoryEnrollment(root));
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    await callback({ root, revision, registryStore, eventStore });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("inspect reports grey for wholly unobserved and declared-dormant repositories", async () => {
  await fixture(verifyPolicy(), async ({ registryStore, eventStore }) => {
    const report = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(report.repositoryState, "unobserved");
    assert.equal(report.status, "grey");
    assert.equal(report.attention.type, "unobserved");
  });

  await fixture(dormantPolicy(), async ({ revision, registryStore, eventStore }) => {
    const report = await buildRevisionProjection({
      repository: "acme/demo",
      revision,
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(report.repositoryState, "dormant");
    assert.equal(report.status, "grey");
    assert.equal(report.attention.type, "dormant");
  });
});

test("configuration problems override otherwise green evidence", async () => {
  await fixture(verifyPolicy(), async ({ root, revision, registryStore, eventStore }) => {
    await new ObservationLedger(eventStore).append(observation({ id: "verify-passed", revision }));
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(verifyPolicy(), null, 2)}\n\n`);
    const report = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(report.signals[0].state, "passed");
    assert.equal(report.repositoryState, "misconfigured");
    assert.equal(report.status, "yellow");
    assert.equal(report.attention.type, "configuration");
  });
});

test("default-branch evidence requires an explicit remote HEAD and changes cursors", async () => {
  await fixture(githubPolicy(), async ({ root, revision, registryStore, eventStore }) => {
    await new ObservationLedger(eventStore).append(observation({
      id: "github-passed",
      revision,
      kind: "github-ci",
      adapter: "github",
    }));

    const beforeInspect = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    const beforeFleet = await buildFleetProjection({
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(beforeInspect.status, "yellow");
    assert.equal(beforeInspect.revision.defaultBranchConfidence, "unavailable");
    assert.equal(beforeInspect.signals[0].state, "selection-unavailable");
    assert.equal(beforeFleet.repositories[0].status, "yellow");
    assert.equal(beforeFleet.repositories[0].requiredSignals[0].state, "selection-unavailable");

    await git(root, "update-ref", "refs/remotes/origin/main", revision);
    await git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    const afterInspect = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    const afterFleet = await buildFleetProjection({
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(afterInspect.status, "green");
    assert.equal(afterInspect.revision.defaultBranchConfidence, "remote-head");
    assert.equal(afterInspect.signals[0].state, "passed");
    assert.notEqual(afterInspect.sourceCursor, beforeInspect.sourceCursor);
    assert.equal(afterFleet.repositories[0].status, "green");
    assert.notEqual(afterFleet.sourceCursor, beforeFleet.sourceCursor);
  });
});
