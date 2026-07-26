import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildFailureReport, buildRecoveryReport } from "../src/history-reports.js";
import { ObservationLedger } from "../src/observation-ledger.js";
import { JsonlEventStore } from "../src/store.js";

const repository = "acme/persistence";
const revision = "d".repeat(40);

function observation(id, status, observedAt) {
  return {
    specversion: "1.0",
    id,
    source: "urn:proofwake:adapter:local-command",
    type: "dev.proofwake.observation.verify.v1",
    subject: `repo:${repository}@sha:${revision}`,
    time: observedAt,
    dataschema: "urn:proofwake:schema:observation:v1",
    data: {
      schemaVersion: 1,
      adapter: {
        name: "local-command",
        version: "1.0.0",
        mappingVersion: 1,
        trust: "local-operator",
        sourceSchema: "proofwake.test.fixture",
        sourceSchemaVersion: "1",
      },
      kind: "verify",
      status,
      timeSource: "adapter",
      observedAt,
      ingestedAt: new Date(Date.parse(observedAt) + 1000).toISOString(),
      relationships: { repository, revision, run: id },
      facts: [],
      evidence: [],
      coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
    },
  };
}

const registryStore = {
  read: async () => ({
    version: 1,
    entries: [{
      repository: { identity: repository, label: repository },
      policy: {
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
      },
    }],
  }),
};

test("idempotent persistence preserves caller observations and stable report reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-observation-persistence-"));
  try {
    const store = new JsonlEventStore(join(directory, "events.jsonl"));
    const ledger = new ObservationLedger(store);
    const failed = observation("failed", "failed", "2026-07-26T10:00:00.000Z");
    const passed = observation("passed", "passed", "2026-07-26T10:01:00.000Z");
    const passedAdapter = structuredClone(passed.data.adapter);
    const passedIngestedAt = passed.data.ingestedAt;

    await ledger.append(failed);
    await ledger.append(passed);

    assert.deepEqual(passed.data.adapter, passedAdapter);
    assert.equal(passed.data.ingestedAt, passedIngestedAt);

    const persisted = await store.readAll();
    assert.equal(persisted[1].observation.data.adapter.name, "local-command");

    const now = new Date("2026-07-26T12:00:00.000Z");
    const firstFailures = await buildFailureReport({ registryStore, eventStore: store, days: 1, now });
    const secondFailures = await buildFailureReport({ registryStore, eventStore: store, days: 1, now });
    assert.deepEqual(secondFailures, firstFailures);
    assert.equal(firstFailures.summary.total, 1);
    assert.equal(firstFailures.summary.resolved, 1);

    const firstRecoveries = await buildRecoveryReport({ registryStore, eventStore: store, days: 1, now });
    const secondRecoveries = await buildRecoveryReport({ registryStore, eventStore: store, days: 1, now });
    assert.deepEqual(secondRecoveries, firstRecoveries);
    assert.equal(firstRecoveries.summary.total, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
