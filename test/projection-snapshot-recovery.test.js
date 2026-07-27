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
import { ObservationLedger, observationLedgerRecord } from "../src/observation-ledger.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function policy() {
  return {
    version: 1,
    repository: { kind: "remote", id: "acme/demo", provider: "github" },
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

function observation({ id, revision, status, observedAt }) {
  return {
    specversion: "1.0",
    id,
    source: "urn:proofwake:adapter:local-command",
    type: "dev.proofwake.observation.verify.v1",
    subject: `repo:acme/demo@sha:${revision}`,
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
      relationships: { repository: "acme/demo", revision },
      facts: [],
      evidence: [],
      coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
    },
  };
}

async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-projection-snapshot-"));
  const root = join(directory, "repo");
  try {
    await mkdir(root);
    await exec("git", ["init", "-q", "-b", "main", root]);
    await git(root, "config", "user.name", "Proofwake Test");
    await git(root, "config", "user.email", "proofwake@example.invalid");
    await git(root, "remote", "add", "origin", "https://github.com/acme/demo.git");
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy(), null, 2)}\n`);
    await git(root, "add", ".");
    await exec("git", ["-C", root, "commit", "-qm", "initial"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-07-26T09:00:00.000Z",
        GIT_COMMITTER_DATE: "2026-07-26T09:00:00.000Z",
      },
    });
    const revision = await git(root, "rev-parse", "HEAD");
    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    await registryStore.enroll(await inspectRepositoryEnrollment(root));
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    await callback({ revision, registryStore, eventStore });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a later failure removes current recovery claims", async () => {
  await fixture(async ({ revision, registryStore, eventStore }) => {
    const ledger = new ObservationLedger(eventStore);
    await ledger.append(observation({ id: "failed-1", revision, status: "failed", observedAt: "2026-07-26T10:00:00.000Z" }));
    await ledger.append(observation({ id: "passed-1", revision, status: "passed", observedAt: "2026-07-26T10:05:00.000Z" }));
    await ledger.append(observation({ id: "failed-2", revision, status: "failed", observedAt: "2026-07-26T10:10:00.000Z" }));

    const inspected = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(inspected.status, "red");
    assert.equal(inspected.signals[0].recovery, null);
    assert.deepEqual(inspected.signals[0].unresolvedFailures.map((entry) => entry.id), ["failed-2"]);

    const fleet = await buildFleetProjection({
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(fleet.repositories[0].status, "red");
    assert.equal(fleet.repositories[0].recentRecovery, null);
    assert.equal(fleet.repositories[0].currentFailure.observation.id, "failed-2");
  });
});

test("inspect consumes one source snapshot and cursor excludes evaluation age", async () => {
  await fixture(async ({ revision, registryStore, eventStore }) => {
    const value = observation({ id: "passed", revision, status: "passed", observedAt: "2026-07-26T10:00:00.000Z" });
    const events = [observationLedgerRecord(value)];
    let registryReads = 0;
    let eventReads = 0;
    const countedRegistry = {
      read: async () => {
        registryReads += 1;
        return registryStore.read();
      },
    };
    const changingEvents = {
      readAll: async () => {
        eventReads += 1;
        return eventReads === 1 ? events : [];
      },
    };

    const first = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore: countedRegistry,
      eventStore: changingEvents,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(first.status, "green");
    assert.equal(registryReads, 1);
    assert.equal(eventReads, 1);

    const second = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore: { readAll: async () => events },
      now: new Date("2026-07-27T12:00:00.000Z"),
    });
    assert.equal(second.status, "green");
    assert.equal(second.revision.ageMs > first.revision.ageMs, true);
    assert.equal(second.sourceCursor, first.sourceCursor);
  });
});
