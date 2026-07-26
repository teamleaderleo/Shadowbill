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

function policy() {
  return {
    version: 1,
    repository: { kind: "remote", id: "acme/demo", provider: "github" },
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

function observation(revision) {
  const observedAt = "2026-07-26T10:00:00.000Z";
  return {
    specversion: "1.0",
    id: "github-passed",
    source: "urn:proofwake:adapter:github",
    type: "dev.proofwake.observation.github-ci.v1",
    subject: `repo:acme/demo@sha:${revision}`,
    time: observedAt,
    dataschema: "urn:proofwake:schema:observation:v1",
    data: {
      schemaVersion: 1,
      adapter: {
        name: "github",
        version: "1.0.0",
        mappingVersion: 1,
        trust: "signed-provider",
        sourceSchema: "proofwake.test.fixture",
        sourceSchemaVersion: "1",
      },
      kind: "github-ci",
      status: "passed",
      timeSource: "provider",
      observedAt,
      ingestedAt: "2026-07-26T10:00:01.000Z",
      relationships: { repository: "acme/demo", revision },
      facts: [],
      evidence: [],
      coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
    },
  };
}

test("origin HEAD from a fork cannot satisfy the enrolled repository default branch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-projection-fork-origin-"));
  const root = join(directory, "repo");
  try {
    await mkdir(root);
    await exec("git", ["init", "-q", "-b", "main", root]);
    await git(root, "config", "user.name", "Proofwake Test");
    await git(root, "config", "user.email", "proofwake@example.invalid");
    await git(root, "remote", "add", "origin", "https://github.com/acme/fork.git");
    await git(root, "remote", "add", "upstream", "https://github.com/acme/demo.git");
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy(), null, 2)}\n`);
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "initial");
    const revision = await git(root, "rev-parse", "HEAD");
    await git(root, "update-ref", "refs/remotes/origin/main", revision);
    await git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    await registryStore.enroll(await inspectRepositoryEnrollment(root));
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    await new ObservationLedger(eventStore).append(observation(revision));

    const inspected = await buildRevisionProjection({
      repository: "acme/demo",
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(inspected.status, "yellow");
    assert.equal(inspected.revision.defaultBranchConfidence, "unavailable");
    assert.equal(inspected.signals[0].state, "selection-unavailable");
    assert.match(inspected.signals[0].reason, /does not belong/u);

    const fleet = await buildFleetProjection({
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(fleet.repositories[0].status, "yellow");
    assert.equal(fleet.repositories[0].requiredSignals[0].state, "selection-unavailable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
