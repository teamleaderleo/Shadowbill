import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { buildRepositoryInventory } from "../src/repository-inventory.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);

function policy(id) {
  return {
    version: 1,
    repository: { kind: "remote", id, provider: "github" },
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

async function git(root, ...args) {
  return exec("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function createRepository(root, id) {
  await mkdir(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Proofwake Test");
  await git(root, "config", "user.email", "proofwake@example.invalid");
  await git(root, "remote", "add", "origin", `https://github.com/${id}.git`);
  await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
  await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy(id), null, 2)}\n`);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "Initial");
}

test("one invalid committed policy does not blank the fleet report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-inventory-degrade-"));
  const goodRoot = join(directory, "good");
  const brokenRoot = join(directory, "broken");
  const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
  const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
  try {
    await createRepository(goodRoot, "acme/good");
    await createRepository(brokenRoot, "acme/broken");
    await registryStore.enroll(await inspectRepositoryEnrollment(goodRoot));
    await registryStore.enroll(await inspectRepositoryEnrollment(brokenRoot));

    await writeFile(join(brokenRoot, ".proofwake.json"), '{"version":1,"version":2}\n');

    const report = await buildRepositoryInventory({
      registryStore,
      eventStore,
      now: new Date("2026-07-26T12:00:00Z"),
    });
    assert.equal(report.summary.total, 2);
    const good = report.repositories.find((entry) => entry.repository.identity === "acme/good");
    const broken = report.repositories.find((entry) => entry.repository.identity === "acme/broken");
    assert.equal(good.classification, "unobserved");
    assert.equal(broken.classification, "misconfigured");
    assert.equal(broken.health, "yellow");
    assert.equal(broken.problems[0].code, "REPOSITORY_POLICY_DUPLICATE_KEY");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
