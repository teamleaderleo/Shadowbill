import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createProofwakeProjectionMcp } from "../src/projection-mcp.js";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function policy(repository) {
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

test("repository projection tools accept an enrolled label and preserve identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-mcp-label-"));
  const root = join(directory, "checkout");
  try {
    await mkdir(root);
    await exec("git", ["init", "-q", "-b", "main", root]);
    await git(root, "config", "user.name", "Proofwake Test");
    await git(root, "config", "user.email", "proofwake@example.invalid");
    await git(root, "remote", "add", "origin", "https://github.com/acme/labelled.git");
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy("acme/labelled"), null, 2)}\n`);
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "initial");
    const revision = await git(root, "rev-parse", "HEAD");

    const storedRegistry = new RepositoryRegistryStore(join(directory, "repositories.json"));
    await storedRegistry.enroll(await inspectRepositoryEnrollment(root));
    const registry = await storedRegistry.read();
    registry.entries[0].repository.label = "pilot-label";

    const projection = createProofwakeProjectionMcp({
      registryStore: { read: async () => structuredClone(registry) },
      eventStore: new JsonlEventStore(join(directory, "events.jsonl")),
      now: () => new Date("2026-07-26T16:00:00.000Z"),
    });

    const selected = await projection.callTool("proofwake_repository_status", { repository: "pilot-label" });
    assert.equal(selected.isError, false);
    assert.equal(selected.structuredContent.repository.identity, "acme/labelled");
    assert.equal(selected.structuredContent.repository.label, "pilot-label");
    assert.equal(selected.structuredContent.selectedRevision, revision);

    const explicit = await projection.callTool("proofwake_revision_evidence", {
      repository: "pilot-label",
      revision,
    });
    assert.equal(explicit.isError, false);
    assert.equal(explicit.structuredContent.repository.identity, "acme/labelled");
    assert.equal(explicit.structuredContent.selectedRevision, revision);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository selectors remain bounded and fail closed", async () => {
  const projection = createProofwakeProjectionMcp({
    registryStore: { read: async () => ({ version: 1, entries: [] }) },
    eventStore: { readAll: async () => [] },
  });

  for (const repository of ["Pilot Label", "../private", "a".repeat(201), "acme/repo?token=private"]) {
    const result = await projection.callTool("proofwake_repository_status", { repository });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "PROOFWAKE_MCP_INVALID_REPOSITORY");
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});
