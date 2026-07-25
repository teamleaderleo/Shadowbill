import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { buildRepositoryInventory } from "../src/repository-inventory.js";
import { ObservationLedger } from "../src/observation-ledger.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);

function policy(extraSignals = []) {
  return {
    version: 1,
    repository: { kind: "remote", id: "acme/demo", provider: "github" },
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

async function fixture(callback, value = policy()) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-inventory-"));
  const root = join(directory, "repo");
  const dataPath = join(directory, "events.jsonl");
  const registryPath = join(directory, "repositories.json");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(root));
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Proofwake Test");
    await git(root, "config", "user.email", "proofwake@example.invalid");
    await git(root, "remote", "add", "origin", "https://github.com/acme/demo.git");
    await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(value, null, 2)}\n`);
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "Initial");
    const proposal = await inspectRepositoryEnrollment(root);
    const registryStore = new RepositoryRegistryStore(registryPath);
    await registryStore.enroll(proposal, { now: new Date("2026-07-26T10:00:00Z") });
    await callback({ directory, root, dataPath, registryPath, registryStore, eventStore: new JsonlEventStore(dataPath), proposal });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function observation({ id, revision, adapter = "local-command", kind = "verify", status = "passed", observedAt = "2026-07-26T11:00:00.000Z", coverage = "complete" }) {
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
        trust: "local-operator",
        sourceSchema: "proofwake.test.fixture",
        sourceSchemaVersion: "1",
      },
      kind,
      status,
      timeSource: "adapter",
      observedAt,
      ingestedAt: observedAt,
      relationships: { repository: "acme/demo", revision },
      evidence: [],
      facts: [],
      coverage: {
        state: coverage,
        redacted: false,
        truncated: false,
        omitted: [],
      },
    },
  };
}

test("inventory reports a fresh accepted current-revision signal as green", async () => {
  await fixture(async ({ proposal, registryStore, eventStore }) => {
    await new ObservationLedger(eventStore).append(observation({ id: "verify-1", revision: proposal.revision }));
    const report = await buildRepositoryInventory({
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00Z"),
    });
    assert.equal(report.summary.total, 1);
    assert.equal(report.repositories[0].classification, "active");
    assert.equal(report.repositories[0].health, "green");
    assert.equal(report.repositories[0].signals[0].state, "passed");
  });
});

test("unaccepted sources and wrong revisions do not satisfy policy", async () => {
  await fixture(async ({ proposal, registryStore, eventStore }) => {
    await new ObservationLedger(eventStore).append(observation({ id: "manual", revision: proposal.revision, adapter: "manual" }));
    await new ObservationLedger(eventStore).append(observation({ id: "wrong-revision", revision: "f".repeat(40) }));
    const report = await buildRepositoryInventory({ registryStore, eventStore, now: new Date("2026-07-26T12:00:00Z") });
    assert.equal(report.repositories[0].health, "yellow");
    assert.equal(report.repositories[0].signals[0].state, "missing");
  });
});

test("duration policy distinguishes stale and failing observations", async () => {
  const diagnostic = {
    kind: "local-diagnostic",
    requirement: "required",
    subject: "repository",
    appliesTo: "repository",
    freshness: { mode: "duration", hours: 1 },
    acceptedSources: ["local-command"],
  };
  await fixture(async ({ proposal, registryStore, eventStore }) => {
    await new ObservationLedger(eventStore).append(observation({ id: "verify", revision: proposal.revision }));
    await new ObservationLedger(eventStore).append(observation({
      id: "diagnostic-old",
      revision: proposal.revision,
      kind: "local-diagnostic",
      observedAt: "2026-07-26T09:00:00.000Z",
    }));
    let report = await buildRepositoryInventory({ registryStore, eventStore, now: new Date("2026-07-26T12:00:00Z") });
    assert.equal(report.repositories[0].signals.find((signal) => signal.kind === "local-diagnostic").state, "stale");
    await new ObservationLedger(eventStore).append(observation({
      id: "diagnostic-failed",
      revision: proposal.revision,
      kind: "local-diagnostic",
      status: "failed",
      observedAt: "2026-07-26T11:30:00.000Z",
    }));
    report = await buildRepositoryInventory({ registryStore, eventStore, now: new Date("2026-07-26T12:00:00Z") });
    assert.equal(report.repositories[0].health, "red");
  }, policy([diagnostic]));
});

test("committed policy changes are authoritative and visible", async () => {
  await fixture(async ({ root, registryStore, eventStore }) => {
    const changed = policy([{
      kind: "github-ci",
      requirement: "optional",
      subject: "revision",
      appliesTo: "default-branch",
      freshness: { mode: "revision" },
      acceptedSources: ["github"],
    }]);
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(changed, null, 2)}\n`);
    await git(root, "add", ".proofwake.json");
    await git(root, "commit", "-qm", "Update policy");
    const report = await buildRepositoryInventory({ registryStore, eventStore, now: new Date("2026-07-26T12:00:00Z") });
    assert.equal(report.repositories[0].policySource, "committed");
    assert.equal(report.repositories[0].policyChanged, true);
    assert.equal(report.repositories[0].signals.length, 2);
  });
});
