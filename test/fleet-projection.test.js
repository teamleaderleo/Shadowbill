import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildFleetProjection } from "../src/fleet-projection.js";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { ObservationLedger } from "../src/observation-ledger.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function activePolicy(repository) {
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

function dormantPolicy(repository) {
  return {
    version: 1,
    repository: { kind: "remote", id: repository, provider: "github" },
    lifecycle: { state: "dormant" },
    signals: [],
    adapters: [],
  };
}

async function createRepository(directory, repository, registryStore, value = activePolicy(repository)) {
  const root = join(directory, repository.replace("/", "-"));
  await mkdir(root);
  await exec("git", ["init", "-q", "-b", "main", root]);
  await git(root, "config", "user.name", "Proofwake Test");
  await git(root, "config", "user.email", "proofwake@example.invalid");
  await git(root, "remote", "add", "origin", `https://github.com/${repository}.git`);
  await writeFile(join(root, "package.json"), '{}\n');
  await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(value, null, 2)}\n`);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "initial");
  const revision = await git(root, "rev-parse", "HEAD");
  await registryStore.enroll(await inspectRepositoryEnrollment(root), {
    now: new Date("2026-07-26T09:00:00.000Z"),
  });
  return { root, revision };
}

function observation({ id, repository, revision, status, observedAt }) {
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
      relationships: { repository, revision },
      facts: [],
      evidence: [],
      coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
    },
  };
}

async function temporary(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-fleet-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("fleet distinguishes green, red, yellow, and grey without a score", async () => {
  await temporary(async (directory) => {
    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    const ledger = new ObservationLedger(eventStore);
    const green = await createRepository(directory, "acme/green", registryStore);
    const red = await createRepository(directory, "acme/red", registryStore);
    const yellow = await createRepository(directory, "acme/yellow", registryStore);
    await createRepository(directory, "acme/grey", registryStore, dormantPolicy("acme/grey"));

    await ledger.append(observation({
      id: "green-passed",
      repository: "acme/green",
      revision: green.revision,
      status: "passed",
      observedAt: "2026-07-26T10:00:00.000Z",
    }));
    await ledger.append(observation({
      id: "red-failed",
      repository: "acme/red",
      revision: red.revision,
      status: "failed",
      observedAt: "2026-07-26T10:01:00.000Z",
    }));
    await ledger.append(observation({
      id: "yellow-old-passed",
      repository: "acme/yellow",
      revision: yellow.revision,
      status: "passed",
      observedAt: "2026-07-26T10:02:00.000Z",
    }));
    await writeFile(join(yellow.root, "next.txt"), "next\n");
    await git(yellow.root, "add", "next.txt");
    await git(yellow.root, "commit", "-qm", "next");

    const report = await buildFleetProjection({
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.deepEqual(report.summary, { total: 4, green: 1, red: 1, yellow: 1, grey: 1 });
    const byId = new Map(report.repositories.map((entry) => [entry.repository.identity, entry]));
    assert.equal(byId.get("acme/green").status, "green");
    assert.equal(byId.get("acme/red").status, "red");
    assert.equal(byId.get("acme/red").currentFailure.signal, "verify");
    assert.equal(byId.get("acme/yellow").status, "yellow");
    assert.equal(byId.get("acme/yellow").missingOrStale.state, "missing");
    assert.equal(byId.get("acme/grey").status, "grey");
    assert.deepEqual(report.attentionOrder, ["acme/red", "acme/yellow", "acme/grey"]);
    assert.equal("score" in report, false);
    assert.equal(report.repositories.some((entry) => "score" in entry), false);
  });
});

test("one missing checkout cannot blank unrelated fleet state", async () => {
  await temporary(async (directory) => {
    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    const healthy = await createRepository(directory, "acme/healthy", registryStore);
    const missing = await createRepository(directory, "acme/missing", registryStore);
    await new ObservationLedger(eventStore).append(observation({
      id: "healthy-passed",
      repository: "acme/healthy",
      revision: healthy.revision,
      status: "passed",
      observedAt: "2026-07-26T10:00:00.000Z",
    }));
    await rm(missing.root, { recursive: true, force: true });

    const report = await buildFleetProjection({
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(report.repositories.length, 2);
    const byId = new Map(report.repositories.map((entry) => [entry.repository.identity, entry]));
    assert.equal(byId.get("acme/healthy").status, "green");
    assert.equal(byId.get("acme/missing").status, "yellow");
    assert.equal(byId.get("acme/missing").classification, "misconfigured");
    assert.match(byId.get("acme/missing").attention.reason, /root is missing/u);
  });
});
