import assert from "node:assert/strict";
import test from "node:test";
import { buildFailureReport, buildRecoveryReport } from "../src/history-reports.js";

const revision = "a".repeat(40);
const repository = "acme/demo";
const now = new Date("2026-07-26T12:00:00.000Z");

function policy() {
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
      {
        kind: "browser-review",
        requirement: "optional",
        subject: "revision",
        appliesTo: "every-revision",
        freshness: { mode: "revision" },
        acceptedSources: ["adapter:renderprove"],
      },
    ],
    adapters: [{
      name: "renderprove",
      type: "receipt-file",
      path: ".renderprove/receipt.json",
      schema: "renderprove.receipt.v1",
      trust: "verified-receipt",
    }],
  };
}

function registryStore() {
  return {
    read: async () => ({
      version: 1,
      entries: [{ repository: { identity: repository, label: repository }, policy: policy() }],
    }),
  };
}

function observation({ id, kind = "verify", status, observedAt, adapter = "local-command", coverage = "complete", includeRevision = true }) {
  const ingestedAt = new Date(Date.parse(observedAt) + 1000).toISOString();
  const relationships = { repository, run: id, ...(includeRevision ? { revision } : {}) };
  return {
    type: "proofwake_observation",
    id: `ledger-${id}`,
    requestFingerprint: `sha256:${id.padEnd(64, "0").slice(0, 64)}`,
    observation: {
      specversion: "1.0",
      id,
      source: `urn:proofwake:adapter:${adapter}`,
      type: `dev.proofwake.observation.${kind}.v1`,
      subject: includeRevision ? `repo:${repository}@sha:${revision}` : `repo:${repository}`,
      time: observedAt,
      dataschema: "urn:proofwake:schema:observation:v1",
      data: {
        schemaVersion: 1,
        adapter: {
          name: adapter,
          version: "1.0.0",
          mappingVersion: 1,
          trust: "local-operator",
          sourceSchema: "proofwake.test.fixture",
          sourceSchemaVersion: "1",
        },
        kind,
        status,
        timeSource: "adapter",
        observedAt,
        ingestedAt,
        relationships,
        facts: [],
        evidence: [{
          uri: `urn:test:${id}`,
          digest: `sha256:${id.padEnd(64, "a").slice(0, 64)}`,
          mediaType: "application/json",
          producer: adapter,
          schema: "test.fixture.v1",
          state: "verified",
          disclosure: "restricted-reference",
        }],
        coverage: { state: coverage, redacted: false, truncated: false, omitted: [] },
      },
    },
  };
}

function eventStore(events) {
  return { readAll: async () => events };
}

test("failure report classifies resolved and unresolved policy-matched failures", async () => {
  const events = [
    observation({ id: "fail-one", status: "failed", observedAt: "2026-07-20T10:00:00.000Z" }),
    observation({ id: "pass-one", status: "passed", observedAt: "2026-07-20T10:05:00.000Z" }),
    observation({ id: "fail-two", status: "failed", observedAt: "2026-07-21T11:00:00.000Z" }),
    observation({ id: "ignored-source", status: "failed", observedAt: "2026-07-22T11:00:00.000Z", adapter: "other" }),
    observation({ id: "optional-browser", kind: "browser-review", status: "failed", observedAt: "2026-07-23T11:00:00.000Z", adapter: "renderprove" }),
  ];
  const report = await buildFailureReport({ registryStore: registryStore(), eventStore: eventStore(events), days: 30, now });
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.resolved, 1);
  assert.equal(report.summary.unresolved, 2);
  assert.deepEqual(report.failures.map((failure) => failure.id), ["optional-browser", "fail-two", "fail-one"]);
  assert.equal(report.failures.find((failure) => failure.id === "fail-one").resolvedBy.id, "pass-one");
  assert.equal(report.failures.find((failure) => failure.id === "fail-two").unresolved, true);
  assert.equal(report.failures.find((failure) => failure.id === "optional-browser").policy.requirement, "optional");
  assert.equal(JSON.stringify(report).includes("ignored-source"), false);
});

test("revision-scoped signals ignore observations without revisions", async () => {
  const events = [observation({ id: "repository-only", status: "failed", observedAt: "2026-07-23T11:00:00.000Z", includeRevision: false })];
  const report = await buildFailureReport({ registryStore: registryStore(), eventStore: eventStore(events), days: 30, now });
  assert.equal(report.summary.total, 0);
});

test("partial producer passes do not resolve failures", async () => {
  const events = [
    observation({ id: "failure", status: "failed", observedAt: "2026-07-24T10:00:00.000Z" }),
    observation({ id: "partial-pass", status: "passed", coverage: "partial", observedAt: "2026-07-24T10:01:00.000Z" }),
  ];
  const failures = await buildFailureReport({ registryStore: registryStore(), eventStore: eventStore(events), days: 30, now });
  const recoveries = await buildRecoveryReport({ registryStore: registryStore(), eventStore: eventStore(events), days: 30, now });
  assert.equal(failures.failures[0].unresolved, true);
  assert.equal(recoveries.summary.total, 0);
});

test("recovery report pairs the latest terminal failure with a complete same-revision pass", async () => {
  const events = [
    observation({ id: "old-failure", status: "failed", observedAt: "2026-07-24T09:00:00.000Z" }),
    observation({ id: "latest-failure", status: "cancelled", observedAt: "2026-07-24T09:01:00.000Z" }),
    observation({ id: "passing", status: "passed", observedAt: "2026-07-24T09:04:00.000Z" }),
    observation({ id: "later-failure", status: "failed", observedAt: "2026-07-25T09:00:00.000Z" }),
  ];
  const report = await buildRecoveryReport({ registryStore: registryStore(), eventStore: eventStore(events), days: 30, now });
  assert.equal(report.summary.total, 1);
  assert.equal(report.recoveries[0].type, "same-revision-rerun");
  assert.equal(report.recoveries[0].from.id, "latest-failure");
  assert.equal(report.recoveries[0].to.id, "passing");
  assert.equal(report.recoveries[0].sourceIntervalMs, 180_000);
});

test("window filtering uses recovery completion time and source cursor ignores delivery order", async () => {
  const events = [
    observation({ id: "outside-failure", status: "failed", observedAt: "2026-06-01T09:00:00.000Z" }),
    observation({ id: "outside-pass", status: "passed", observedAt: "2026-06-01T09:01:00.000Z" }),
    observation({ id: "inside-failure", status: "failed", observedAt: "2026-07-25T09:00:00.000Z" }),
    observation({ id: "inside-pass", status: "passed", observedAt: "2026-07-25T09:01:00.000Z" }),
  ];
  const first = await buildRecoveryReport({ registryStore: registryStore(), eventStore: eventStore(events), days: 7, now });
  const second = await buildRecoveryReport({ registryStore: registryStore(), eventStore: eventStore([...events].reverse()), days: 7, now });
  assert.equal(first.summary.total, 1);
  assert.equal(first.recoveries[0].to.id, "inside-pass");
  assert.equal(first.sourceCursor, second.sourceCursor);
  assert.deepEqual(first.recoveries, second.recoveries);
});

test("irrelevant observations do not change the source cursor", async () => {
  const accepted = observation({ id: "accepted", status: "failed", observedAt: "2026-07-25T09:00:00.000Z" });
  const ignored = observation({ id: "ignored", status: "failed", observedAt: "2026-07-25T10:00:00.000Z", adapter: "other" });
  const first = await buildFailureReport({ registryStore: registryStore(), eventStore: eventStore([accepted]), days: 7, now });
  const second = await buildFailureReport({ registryStore: registryStore(), eventStore: eventStore([accepted, ignored]), days: 7, now });
  assert.equal(first.sourceCursor, second.sourceCursor);
});

test("invalid day ranges fail with a stable code", async () => {
  await assert.rejects(
    buildFailureReport({ registryStore: registryStore(), eventStore: eventStore([]), days: 0, now }),
    (error) => error.code === "HISTORY_REPORT_INVALID_DAYS" && error.path === "$.days",
  );
});
