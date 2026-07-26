import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildRevisionProjection } from "../src/inspect-projection.js";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { ingestRenderproveReceipt, RENDERPROVE_RECEIPT_SCHEMA } from "../src/renderprove-adapter.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function policy() {
  return {
    version: 1,
    repository: { kind: "remote", id: "acme/empty", provider: "github" },
    lifecycle: { state: "active", dormantAfterDays: 30 },
    signals: [{
      kind: "browser-review",
      requirement: "required",
      subject: "revision",
      appliesTo: "every-revision",
      freshness: { mode: "revision" },
      acceptedSources: ["adapter:renderprove"],
    }],
    adapters: [{
      name: "renderprove",
      type: "receipt-file",
      path: ".renderprove/receipt.json",
      schema: "renderprove.receipt.v1",
      trust: "verified-receipt",
    }],
  };
}

test("a valid zero-case receipt indexes unavailable coverage instead of green", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-renderprove-empty-"));
  const root = join(directory, "repo");
  try {
    await mkdir(root);
    await exec("git", ["init", "-q", "-b", "main", root]);
    await git(root, "config", "user.name", "Proofwake Test");
    await git(root, "config", "user.email", "proofwake@example.invalid");
    await git(root, "remote", "add", "origin", "https://github.com/acme/empty.git");
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy(), null, 2)}\n`);
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "initial");
    await mkdir(join(root, ".renderprove"));
    await writeFile(join(root, ".renderprove", "receipt.json"), `${JSON.stringify({
      $schema: RENDERPROVE_RECEIPT_SCHEMA,
      version: 1,
      project: "empty-project",
      source: { manifest: null },
      target: { baseUrl: "https://example.test" },
      startedAt: "2026-07-26T01:00:00.000Z",
      finishedAt: "2026-07-26T01:00:01.000Z",
      durationMs: 1000,
      status: "passed",
      summary: { cases: 0, passed: 0, failed: 0, diagnostics: 0 },
      runtime: { mode: "remote", logs: null },
      cases: [],
    }, null, 2)}\n`);

    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    const entry = (await registryStore.enroll(await inspectRepositoryEnrollment(root))).entry;
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    const result = await ingestRenderproveReceipt({
      entry,
      eventStore,
      now: new Date("2026-07-26T02:00:00.000Z"),
    });
    assert.equal(result.producerStatus, "passed");
    assert.equal(result.browserStatus, "unavailable");
    assert.equal(result.observation.data.coverage.state, "unavailable");

    const projection = await buildRevisionProjection({
      repository: "acme/empty",
      registryStore,
      eventStore,
      now: new Date("2026-07-26T02:00:00.000Z"),
    });
    assert.equal(projection.status, "yellow");
    assert.equal(projection.signals[0].state, "unavailable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
