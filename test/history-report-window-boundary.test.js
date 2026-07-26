import assert from "node:assert/strict";
import test from "node:test";
import { buildFailureReport, buildRecoveryReport } from "../src/history-reports.js";

const repository = "acme/window";
const revision = "b".repeat(40);
const now = new Date("2026-07-26T12:00:00.000Z");

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

function event(id, status, observedAt) {
  return {
    type: "proofwake_observation",
    id: `ledger-${id}`,
    requestFingerprint: `sha256:${id === "failure" ? "1" : "2"}`.padEnd(71, id === "failure" ? "1" : "2"),
    observation: {
      source: "urn:proofwake:adapter:local-command",
      id,
      data: {
        kind: "verify",
        status,
        observedAt,
        ingestedAt: observedAt,
        adapter: { name: "local-command", version: "1.0.0", trust: "local-operator" },
        relationships: { repository, revision },
        coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
        evidence: [],
      },
    },
  };
}

test("future observations cannot resolve failures or create recoveries", async () => {
  const events = [
    event("failure", "failed", "2026-07-26T11:59:00.000Z"),
    event("future-pass", "passed", "2026-07-26T12:01:00.000Z"),
  ];
  const eventStore = { readAll: async () => events };
  const failures = await buildFailureReport({ registryStore, eventStore, days: 1, now });
  const recoveries = await buildRecoveryReport({ registryStore, eventStore, days: 1, now });
  assert.equal(failures.summary.total, 1);
  assert.equal(failures.failures[0].unresolved, true);
  assert.equal(failures.failures[0].resolvedBy, null);
  assert.equal(recoveries.summary.total, 0);
});
