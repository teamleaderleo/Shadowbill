import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
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

function policy() {
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
      {
        kind: "local-diagnostic",
        requirement: "required",
        subject: "repository",
        appliesTo: "repository",
        freshness: { mode: "duration", hours: 24 },
        acceptedSources: ["local-command"],
      },
    ],
    adapters: [],
  };
}

function observation({ id, revision, kind, status, observedAt }) {
  const repositorySubject = kind === "local-diagnostic";
  return {
    specversion: "1.0",
    id,
    source: "urn:proofwake:adapter:local-command",
    type: `dev.proofwake.observation.${kind}.v1`,
    subject: repositorySubject ? "repo:acme/demo" : `repo:acme/demo@sha:${revision}`,
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
      kind,
      status,
      timeSource: "adapter",
      observedAt,
      ingestedAt: new Date(Date.parse(observedAt) + 1000).toISOString(),
      relationships: repositorySubject ? { repository: "acme/demo" } : { repository: "acme/demo", revision },
      facts: [],
      evidence: [],
      coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
    },
  };
}

test("time to green requires all required signals to pass simultaneously", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-first-green-"));
  try {
    const root = join(directory, "repo");
    await mkdir(root);
    await exec("git", ["init", "-q", "-b", "main", root]);
    await git(root, "config", "user.name", "Proofwake Test");
    await git(root, "config", "user.email", "proofwake@example.invalid");
    await git(root, "remote", "add", "origin", "https://github.com/acme/demo.git");
    await writeFile(join(root, "package.json"), '{}\n');
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy(), null, 2)}\n`);
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "initial");
    const revision = await git(root, "rev-parse", "HEAD");

    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    await registryStore.enroll(await inspectRepositoryEnrollment(root));
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    const ledger = new ObservationLedger(eventStore);
    await ledger.append(observation({ id: "verify-pass-1", revision, kind: "verify", status: "passed", observedAt: "2026-07-26T10:00:00.000Z" }));
    await ledger.append(observation({ id: "verify-fail", revision, kind: "verify", status: "failed", observedAt: "2026-07-26T11:00:00.000Z" }));
    await ledger.append(observation({ id: "diagnostic-pass", revision, kind: "local-diagnostic", status: "passed", observedAt: "2026-07-26T12:00:00.000Z" }));

    let report = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:30:00.000Z"),
    });
    assert.equal(report.status, "red");
    assert.equal(report.firstGreenAt, null);
    assert.equal(report.timeToGreenMs, null);

    await ledger.append(observation({ id: "verify-pass-2", revision, kind: "verify", status: "passed", observedAt: "2026-07-26T13:00:00.000Z" }));
    report = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore,
      now: new Date("2026-07-26T13:30:00.000Z"),
    });
    assert.equal(report.status, "green");
    assert.equal(report.firstGreenAt, "2026-07-26T13:00:00.000Z");
    assert.equal(report.timeToGreenMs, 10_800_000);
    assert.equal(report.timeToGreenConfidence, "complete");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
