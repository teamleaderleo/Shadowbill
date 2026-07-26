import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createProofwakeProjectionMcp, PROOFWAKE_PROJECTION_TOOLS } from "../src/projection-mcp.js";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);
const NOW = new Date("2026-07-26T14:00:00.000Z");

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function initializeRepository(root) {
  await mkdir(root);
  await exec("git", ["init", "-q", "-b", "main", root]);
  await git(root, "config", "user.name", "Proofwake Test");
  await git(root, "config", "user.email", "proofwake@example.invalid");
  await writeFile(join(root, "package.json"), "{}\n");
}

function remotePolicy(repository) {
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

async function enrollRemote(directory, registryStore) {
  const repository = "acme/mcp-selector";
  const root = join(directory, "remote-selector");
  await initializeRepository(root);
  await git(root, "remote", "add", "origin", `https://github.com/${repository}.git`);
  await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(remotePolicy(repository), null, 2)}\n`);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "initial");
  const revision = await git(root, "rev-parse", "HEAD");
  await registryStore.enroll(await inspectRepositoryEnrollment(root), { now: NOW });
  return { repository, revision };
}

async function enrollLocal(directory, registryStore) {
  const root = join(directory, "Local Display Repo");
  await initializeRepository(root);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "initial");
  const revision = await git(root, "rev-parse", "HEAD");
  const inspection = await inspectRepositoryEnrollment(root);
  assert.equal(inspection.repository.label, "local-display-repo");
  await registryStore.enroll(inspection, { approveAutodetected: true, now: NOW });
  return { label: inspection.repository.label, identity: inspection.repository.identity, revision };
}

function selectorSchema(toolName) {
  return PROOFWAKE_PROJECTION_TOOLS.find((tool) => tool.name === toolName).inputSchema.properties.repository;
}

test("repository tools expose bounded selector schemas", () => {
  for (const name of ["proofwake_repository_status", "proofwake_revision_evidence"]) {
    const schema = selectorSchema(name);
    assert.equal(schema.minLength, 1);
    assert.equal(schema.maxLength, 200);
    assert.equal(schema.pattern, "^[a-z0-9][a-z0-9._/-]{0,199}$");
    assert.match(schema.description, /identity or local display label/u);
  }
});

test("repository tools resolve remote identities and local display labels through the shared projection resolver", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-mcp-selectors-"));
  try {
    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    const remote = await enrollRemote(directory, registryStore);
    const local = await enrollLocal(directory, registryStore);
    const mcp = createProofwakeProjectionMcp({ registryStore, eventStore, now: () => NOW });

    for (const [selector, revision, expectedIdentity, expectedLabel] of [
      [remote.repository, remote.revision, remote.repository, remote.repository],
      [local.label, local.revision, local.identity, local.label],
    ]) {
      const status = await mcp.callTool("proofwake_repository_status", { repository: selector });
      assert.equal(status.isError, false);
      assert.equal(status.structuredContent.repository.identity, expectedIdentity);
      assert.equal(status.structuredContent.repository.label, expectedLabel);

      const evidence = await mcp.callTool("proofwake_revision_evidence", { repository: selector, revision });
      assert.equal(evidence.isError, false);
      assert.equal(evidence.structuredContent.repository.identity, expectedIdentity);
      assert.equal(evidence.structuredContent.repository.label, expectedLabel);
      assert.equal(evidence.structuredContent.selectedRevision, revision);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
