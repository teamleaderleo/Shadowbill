import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { ObservationLedger, observationLedgerRecord } from "../src/observation-ledger.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { buildRevisionProjection } from "../src/revision-projection.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function verifySignal(requirement = "required") {
  return {
    kind: "verify",
    requirement,
    subject: "revision",
    appliesTo: "every-revision",
    freshness: { mode: "revision" },
    acceptedSources: ["local-command"],
  };
}

function githubSignal(requirement = "required") {
  return {
    kind: "github-ci",
    requirement,
    subject: "revision",
    appliesTo: "default-branch",
    freshness: { mode: "revision" },
    acceptedSources: ["github"],
  };
}

function diagnosticSignal() {
  return {
    kind: "local-diagnostic",
    requirement: "required",
    subject: "repository",
    appliesTo: "repository",
    freshness: { mode: "duration", hours: 1 },
    acceptedSources: ["local-command"],
  };
}

function policy(signals = [verifySignal()]) {
  return {
    version: 1,
    repository: { kind: "remote", id: "acme/demo", provider: "github" },
    lifecycle: { state: "active", dormantAfterDays: 30 },
    signals,
    adapters: [],
  };
}

async function fixture(callback, value = policy()) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-projection-"));
  const root = join(directory, "repo");
  const registryPath = join(directory, "repositories.json");
  const dataPath = join(directory, "events.jsonl");
  try {
    await mkdir(root);
    await exec("git", ["init", "-q", "-b", "main", root]);
    await git(root, "config", "user.name", "Proofwake Test");
    await git(root, "config", "user.email", "proofwake@example.invalid");
    await git(root, "remote", "add", "origin", "https://github.com/acme/demo.git");
    await writeFile(join(root, "package.json"), '{}\n');
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(value, null, 2)}\n`);
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "initial");
    const revision = await git(root, "rev-parse", "HEAD");
    const registryStore = new RepositoryRegistryStore(registryPath);
    await registryStore.enroll(await inspectRepositoryEnrollment(root), {
      now: new Date("2026-07-26T09:00:00.000Z"),
    });
    const eventStore = new JsonlEventStore(dataPath);
    await callback({ directory, root, revision, registryStore, eventStore });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function observation({
  id,
  revision,
  kind = "verify",
  status,
  adapter = "local-command",
  observedAt,
  repositorySubject = false,
  workflowAttempt,
  evidence = [],
}) {
  const ingestedAt = new Date(Date.parse(observedAt) + 1000).toISOString();
  const relationships = { repository: "acme/demo" };
  if (!repositorySubject) relationships.revision = revision;
  if (workflowAttempt !== undefined) relationships.workflowAttempt = workflowAttempt;
  return {
    specversion: "1.0",
    id,
    source: `urn:proofwake:adapter:${adapter}`,
    type: `dev.proofwake.observation.${kind}.v1`,
    subject: repositorySubject ? "repo:acme/demo" : `repo:acme/demo@sha:${revision}`,
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
      ingestedAt,
      relationships,
      facts: [],
      evidence,
      coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
    },
  };
}

async function append(eventStore, value) {
  await new ObservationLedger(eventStore).append(value);
}

test("missing, failing, and same-revision recovery remain explainable", async () => {
  await fixture(async ({ revision, registryStore, eventStore }) => {
    let report = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(report.status, "yellow");
    assert.equal(report.signals[0].state, "missing");

    await append(eventStore, observation({
      id: "verify-failed",
      revision,
      status: "failed",
      observedAt: "2026-07-26T10:00:00.000Z",
    }));
    report = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(report.status, "red");
    assert.equal(report.signals[0].state, "failing");
    assert.equal(report.signals[0].unresolvedFailures[0].id, "verify-failed");

    await append(eventStore, observation({
      id: "verify-passed",
      revision,
      status: "passed",
      observedAt: "2026-07-26T10:05:00.000Z",
      evidence: [{
        uri: "urn:proofwake:evidence:test",
        digest: `sha256:${"a".repeat(64)}`,
        mediaType: "application/json",
        producer: "local-command",
        schema: "proofwake.test.evidence",
        state: "verified",
        disclosure: "content-excluded",
      }],
    }));
    report = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    const signal = report.signals[0];
    assert.equal(report.status, "green");
    assert.equal(signal.state, "passed");
    assert.equal(signal.attempts, 2);
    assert.equal(signal.reruns, 1);
    assert.equal(signal.timeToPassingMs, 300_000);
    assert.equal(signal.unresolvedFailures.length, 0);
    assert.equal(signal.recovery.type, "same-revision-rerun");
    assert.equal(signal.recovery.from.id, "verify-failed");
    assert.equal(signal.recovery.to.id, "verify-passed");
    assert.equal(signal.latest.evidence[0].digest, `sha256:${"a".repeat(64)}`);
    assert.match(report.sourceCursor, /^sha256:[a-f0-9]{64}$/u);
  });
});

test("duration freshness is independent from revision freshness", async () => {
  await fixture(async ({ revision, registryStore, eventStore }) => {
    await append(eventStore, observation({
      id: "verify-passed",
      revision,
      status: "passed",
      observedAt: "2026-07-26T11:30:00.000Z",
    }));
    await append(eventStore, observation({
      id: "diagnostic-old",
      revision,
      kind: "local-diagnostic",
      status: "passed",
      repositorySubject: true,
      observedAt: "2026-07-26T09:00:00.000Z",
    }));
    const report = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(report.status, "yellow");
    assert.equal(report.signals.find((signal) => signal.policy.kind === "verify").state, "passed");
    assert.equal(report.signals.find((signal) => signal.policy.kind === "local-diagnostic").state, "stale");
  }, policy([verifySignal(), diagnosticSignal()]));
});

test("descendant correction recovery requires verified Git ancestry", async () => {
  await fixture(async ({ root, revision: ancestor, registryStore, eventStore }) => {
    await append(eventStore, observation({
      id: "ancestor-failed",
      revision: ancestor,
      status: "failed",
      observedAt: "2026-07-26T10:00:00.000Z",
    }));
    await writeFile(join(root, "change.txt"), "descendant\n");
    await git(root, "add", "change.txt");
    await git(root, "commit", "-qm", "descendant");
    const descendant = await git(root, "rev-parse", "HEAD");
    await append(eventStore, observation({
      id: "descendant-passed",
      revision: descendant,
      status: "passed",
      observedAt: "2026-07-26T11:00:00.000Z",
    }));

    const report = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(report.selectedRevision, descendant);
    assert.equal(report.status, "green");
    assert.equal(report.revision.confidence, "verified-current");
    assert.equal(report.signals[0].recovery.type, "descendant-correction");
    assert.equal(report.signals[0].recovery.relation, "verified-ancestor");
    assert.equal(report.signals[0].recovery.causality, "unproven");
    assert.equal(report.signals[0].recovery.from.relationships.revision, ancestor);
  });
});

test("delivery order and equal timestamps rebuild deterministically", async () => {
  await fixture(async ({ revision, registryStore }) => {
    const failed = observation({
      id: "a-failed",
      revision,
      status: "failed",
      observedAt: "2026-07-26T10:00:00.000Z",
    });
    const passed = observation({
      id: "b-passed",
      revision,
      status: "passed",
      observedAt: "2026-07-26T10:00:00.000Z",
    });
    const records = [observationLedgerRecord(failed), observationLedgerRecord(passed)];
    const forward = { readAll: async () => records };
    const reverse = { readAll: async () => [...records].reverse() };
    const left = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore: forward,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    const right = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore: reverse,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(left.sourceCursor, right.sourceCursor);
    assert.equal(left.status, "green");
    assert.deepEqual(left.signals[0].history.map((entry) => entry.id), ["a-failed", "b-passed"]);
    assert.deepEqual(left.signals[0].history, right.signals[0].history);
  });
});

test("legacy GitHub workflow attempts feed rerun recovery", async () => {
  await fixture(async ({ revision, registryStore }) => {
    const events = [
      {
        type: "github_workflow_run",
        id: "workflow-1",
        timestamp: "2026-07-26T10:00:00.000Z",
        repository: "acme/demo",
        runId: 42,
        workflow: "CI",
        status: "completed",
        conclusion: "failure",
        headSha: revision,
        runAttempt: 1,
        durationMs: 1000,
        deliveryId: "delivery-1",
      },
      {
        type: "github_workflow_run",
        id: "workflow-2",
        timestamp: "2026-07-26T10:05:00.000Z",
        repository: "acme/demo",
        runId: 42,
        workflow: "CI",
        status: "completed",
        conclusion: "success",
        headSha: revision,
        runAttempt: 2,
        durationMs: 1000,
        deliveryId: "delivery-2",
      },
    ];
    const report = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore: { readAll: async () => events },
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    const signal = report.signals[0];
    assert.equal(report.status, "green");
    assert.deepEqual(signal.workflowAttempts, [1, 2]);
    assert.equal(signal.recovery.type, "same-revision-rerun");
    assert.equal(signal.latest.adapter.trust, "signed-provider");
  }, policy([githubSignal()]));
});

test("unknown repositories and malformed revisions fail with stable codes", async () => {
  await fixture(async ({ registryStore, eventStore }) => {
    await assert.rejects(
      buildRevisionProjection({ repository: "acme/missing", registryStore, eventStore }),
      (error) => error.code === "PROJECTION_REPOSITORY_UNKNOWN",
    );
    await assert.rejects(
      buildRevisionProjection({ repository: "acme/demo", revision: "abc", registryStore, eventStore }),
      (error) => error.code === "PROJECTION_INVALID_REVISION",
    );
  });
});
