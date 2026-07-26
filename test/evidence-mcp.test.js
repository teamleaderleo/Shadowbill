import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { createProofwakeMcpSession } from "../src/evidence-mcp.js";
import { DEFAULT_WORKING_PROFILE } from "../src/estimate.js";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { ObservationLedger } from "../src/observation-ledger.js";
import { loadPricingCatalog } from "../src/pricing.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const repository = "acme/mcp-evidence";

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function policy() {
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

function observation({ id, status, revision, observedAt }) {
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
      relationships: { repository, revision, run: id },
      facts: [],
      evidence: [],
      coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
    },
  };
}

function initialize(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "proofwake-test", version: "1.0.0" },
    },
  };
}

function call(id, name, args = {}) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-evidence-mcp-"));
  const root = join(directory, "checkout");
  const dataPath = join(directory, "events.jsonl");
  const registryPath = join(directory, "repositories.json");
  try {
    await mkdir(root);
    await exec("git", ["init", "-q", "-b", "main", root]);
    await git(root, "config", "user.name", "Proofwake Test");
    await git(root, "config", "user.email", "proofwake@example.invalid");
    await git(root, "remote", "add", "origin", `https://github.com/${repository}.git`);
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy(), null, 2)}\n`);
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "initial");
    const revision = await git(root, "rev-parse", "HEAD");

    const registryStore = new RepositoryRegistryStore(registryPath);
    await registryStore.enroll(await inspectRepositoryEnrollment(root));
    const eventStore = new JsonlEventStore(dataPath);
    const ledger = new ObservationLedger(eventStore);
    const base = Date.now() - 60_000;
    await ledger.append(observation({ id: "failed", status: "failed", revision, observedAt: new Date(base).toISOString() }));
    await ledger.append(observation({ id: "passed", status: "passed", revision, observedAt: new Date(base + 10_000).toISOString() }));

    const catalog = await loadPricingCatalog();
    const pricing = catalog.models["gpt-5.6-sol"];
    await callback({ directory, root, dataPath, registryPath, revision, registryStore, eventStore, pricing });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Proofwake MCP lists evidence first and returns shared projection contracts", async () => {
  await fixture(async ({ directory, root, dataPath, registryPath, revision, registryStore, eventStore, pricing }) => {
    const session = createProofwakeMcpSession({
      store: eventStore,
      registryStore,
      pricing,
      profile: DEFAULT_WORKING_PROFILE,
      timeZone: "UTC",
      allowWrites: false,
    });

    const initialized = await session.handle(initialize());
    assert.equal(initialized.result.serverInfo.name, "proofwake");
    assert.match(initialized.result.instructions, /proofwake_fleet_status/);

    const listed = await session.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = listed.result.tools.map((tool) => tool.name);
    assert.deepEqual(names.slice(0, 5), [
      "proofwake_fleet_status",
      "proofwake_repository_status",
      "proofwake_revision_evidence",
      "proofwake_recent_failures",
      "proofwake_recovery_report",
    ]);
    assert.equal(listed.result.tools.slice(0, 5).every((tool) => tool.annotations.readOnlyHint === true), true);
    assert.equal(names.includes("shadowbill_daily_report"), true);
    assert.equal(names.includes("shadowbill_record_chat_turn"), false);

    const fleet = await session.handle(call(3, "proofwake_fleet_status"));
    assert.equal(fleet.result.structuredContent.summary.green, 1);
    const repositoryReport = await session.handle(call(4, "proofwake_repository_status", { repository }));
    assert.equal(repositoryReport.result.structuredContent.status, "green");
    assert.equal(repositoryReport.result.structuredContent.selectedRevision, revision);
    const revisionReport = await session.handle(call(5, "proofwake_revision_evidence", { repository, revision }));
    assert.equal(revisionReport.result.structuredContent.sourceCursor, repositoryReport.result.structuredContent.sourceCursor);
    const failures = await session.handle(call(6, "proofwake_recent_failures", { days: 1 }));
    assert.equal(failures.result.structuredContent.summary.total, 1);
    assert.equal(failures.result.structuredContent.summary.resolved, 1);
    const recoveries = await session.handle(call(7, "proofwake_recovery_report", { days: 1 }));
    assert.equal(recoveries.result.structuredContent.summary.total, 1);
    assert.equal(recoveries.result.structuredContent.recoveries[0].from.id, "failed");
    assert.equal(recoveries.result.structuredContent.recoveries[0].to.id, "passed");

    const invalid = await session.handle(call(8, "proofwake_recent_failures", { days: 0 }));
    assert.equal(invalid.result.isError, true);
    assert.equal(invalid.result.structuredContent.error.code, "PROOFWAKE_INVALID_ARGUMENTS");
    const missing = await session.handle(call(9, "proofwake_repository_status", { repository: "acme/missing" }));
    assert.equal(missing.result.isError, true);
    assert.equal(missing.result.structuredContent.error.code, "PROJECTION_REPOSITORY_UNKNOWN");
    assert.equal(missing.result.structuredContent.error.message, "Repository is not enrolled.");

    const serialized = JSON.stringify([fleet, repositoryReport, revisionReport, failures, recoveries]);
    for (const privateValue of [directory, root, dataPath, registryPath, "checkout", "events.jsonl", "repositories.json"]) {
      assert.equal(serialized.includes(privateValue), false, privateValue);
    }
  });
});

test("Proofwake MCP keeps evidence read-only while preserving opt-in Shadowbill writes", async () => {
  await fixture(async ({ registryStore, eventStore, pricing }) => {
    const session = createProofwakeMcpSession({
      store: eventStore,
      registryStore,
      pricing,
      profile: DEFAULT_WORKING_PROFILE,
      timeZone: "UTC",
      allowWrites: true,
    });
    await session.handle(initialize());
    const listed = await session.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = listed.result.tools;
    assert.equal(tools.find((tool) => tool.name === "shadowbill_record_chat_turn").annotations.readOnlyHint, false);
    assert.equal(tools.filter((tool) => tool.name.startsWith("proofwake_")).every((tool) => tool.annotations.readOnlyHint), true);
    const task = await session.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "proofwake_fleet_status", arguments: {}, task: { ttl: 1000 } },
    });
    assert.equal(task.error.code, -32601);
  });
});

test("live proofwake mcp command exposes evidence tools and an empty first-run fleet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-evidence-mcp-cli-"));
  const dataPath = join(directory, "events.jsonl");
  try {
    const messages = [
      initialize(),
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      call(3, "proofwake_fleet_status"),
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";
    const result = spawnSync(process.execPath, [cli, "mcp", "--data", dataPath], {
      encoding: "utf8",
      input: messages,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const responses = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(responses[0].result.serverInfo.name, "proofwake");
    assert.equal(responses[1].result.tools[0].name, "proofwake_fleet_status");
    assert.equal(responses[2].result.structuredContent.summary.total, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
