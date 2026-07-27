import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_WORKING_PROFILE } from "../src/estimate.js";
import { buildFleetProjection } from "../src/fleet-projection.js";
import { buildRevisionProjection } from "../src/inspect-projection.js";
import { runProofwakeMcpStdioServer } from "../src/proofwake-mcp.js";
import { ObservationLedger } from "../src/observation-ledger.js";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);
const NOW = "2026-07-26T14:00:00.000Z";
const pricing = {
  inputPerMillion: 5,
  cachedInputPerMillion: 0.5,
  cacheWritePerMillion: 6.25,
  outputPerMillion: 30,
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
};

const initialize = (id = 1, protocolVersion = "2025-11-25") => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "proofwake-mcp-test", version: "1.0.0" },
  },
});

async function exchange(options, messages, streams = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let text = "";
  output.on("data", (chunk) => { text += chunk; });

  const running = runProofwakeMcpStdioServer(options, { input, output, ...streams });
  for (const message of messages) {
    input.write(typeof message === "string" ? `${message}\n` : `${JSON.stringify(message)}\n`);
  }
  input.end();
  await running;
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function mcpOptions({ eventStore, registryStore, allowWrites = false }) {
  return {
    store: eventStore,
    registryStore,
    pricing,
    profile: DEFAULT_WORKING_PROFILE,
    timeZone: "America/Los_Angeles",
    allowWrites,
    now: () => new Date(NOW),
  };
}

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

async function createRepository(directory, repository, registryStore) {
  const root = join(directory, repository.replace("/", "-"));
  await mkdir(root);
  await exec("git", ["init", "-q", "-b", "main", root]);
  await git(root, "config", "user.name", "Proofwake Test");
  await git(root, "config", "user.email", "proofwake@example.invalid");
  await git(root, "remote", "add", "origin", `https://github.com/${repository}.git`);
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, ".proofwake.json"), `${JSON.stringify(policy(repository), null, 2)}\n`);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "initial");
  const revision = await git(root, "rev-parse", "HEAD");
  await registryStore.enroll(await inspectRepositoryEnrollment(root), { now: new Date("2026-07-26T12:00:00.000Z") });
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
  const directory = await mkdtemp(join(tmpdir(), "proofwake-mcp-projections-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function countedStores(registryStore, eventStore) {
  const counts = { registry: 0, ledger: 0 };
  return {
    counts,
    registryStore: {
      read: async () => {
        counts.registry += 1;
        return registryStore.read();
      },
    },
    eventStore: {
      readAll: async () => {
        counts.ledger += 1;
        return eventStore.readAll();
      },
      append: (...args) => eventStore.append(...args),
    },
  };
}

function call(name, args, id = 2) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function errorCode(response) {
  return response.result.structuredContent.error.code;
}

test("Proofwake projection tools are discovered in read-only and write-enabled modes without changing Shadowbill gating", async () => {
  const registryStore = { read: async () => ({ version: 1, entries: [] }) };
  const eventStore = { readAll: async () => [], append: async () => true };
  const readOnly = await exchange(mcpOptions({ eventStore, registryStore }), [
    initialize(),
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  const writable = await exchange(mcpOptions({ eventStore, registryStore, allowWrites: true }), [
    initialize(),
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);

  const expectedReadTools = [
    "shadowbill_daily_report",
    "shadowbill_range_report",
    "shadowbill_repository_report",
    "proofwake_fleet_status",
    "proofwake_repository_status",
    "proofwake_revision_evidence",
    "proofwake_evaluation_evidence",
  ];
  assert.deepEqual(readOnly[1].result.tools.map((tool) => tool.name), expectedReadTools);
  assert.deepEqual(writable[1].result.tools.map((tool) => tool.name), [
    ...expectedReadTools,
    "shadowbill_record_chat_turn",
  ]);
  for (const tool of readOnly[1].result.tools.slice(3)) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
  }
  assert.equal(writable[1].result.tools.at(-1).annotations.readOnlyHint, false);
});

test("fleet, repository, and explicit revision MCP outputs match the merged projections from one immutable snapshot", async () => {
  await temporary(async (directory) => {
    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    const repository = "acme/mcp-parity";
    const checkout = await createRepository(directory, repository, registryStore);
    await new ObservationLedger(eventStore).append(observation({
      id: "verify-passed",
      repository,
      revision: checkout.revision,
      status: "passed",
      observedAt: "2026-07-26T13:00:00.000Z",
    }));

    const expectedFleet = await buildFleetProjection({ registryStore, eventStore, now: new Date(NOW) });
    const expectedRepository = await buildRevisionProjection({ repository, registryStore, eventStore, now: new Date(NOW) });
    const expectedRevision = await buildRevisionProjection({
      repository,
      revision: checkout.revision,
      registryStore,
      eventStore,
      now: new Date(NOW),
    });

    for (const [name, args, expected] of [
      ["proofwake_fleet_status", {}, expectedFleet],
      ["proofwake_repository_status", { repository }, expectedRepository],
      ["proofwake_revision_evidence", { repository, revision: checkout.revision }, expectedRevision],
    ]) {
      const counted = countedStores(registryStore, eventStore);
      const responses = await exchange(mcpOptions({ eventStore: counted.eventStore, registryStore: counted.registryStore }), [
        initialize(),
        call(name, args),
      ]);
      assert.equal(responses[1].result.isError, false);
      assert.deepEqual(responses[1].result.structuredContent, expected);
      assert.equal(counted.counts.registry, 1);
      assert.equal(counted.counts.ledger, 1);
      assert.equal(JSON.stringify(responses[1]).includes(checkout.root), false);
    }
  });
});

test("Proofwake MCP validates strict allowlists, canonical identities, full revisions, and unknown repositories", async () => {
  const registryStore = { read: async () => ({ version: 1, entries: [] }) };
  const eventStore = { readAll: async () => [] };
  const responses = await exchange(mcpOptions({ eventStore, registryStore }), [
    initialize(),
    call("proofwake_fleet_status", { extra: true }, 2),
    call("proofwake_repository_status", {}, 3),
    call("proofwake_repository_status", { repository: "Acme/Repo" }, 4),
    call("proofwake_repository_status", { repository: "acme/repo", extra: "private" }, 5),
    call("proofwake_revision_evidence", { repository: "acme/repo" }, 6),
    call("proofwake_revision_evidence", { repository: "acme/repo", revision: "A".repeat(40) }, 7),
    call("proofwake_repository_status", { repository: "acme/missing" }, 8),
  ]);

  assert.equal(errorCode(responses[1]), "PROOFWAKE_MCP_INVALID_ARGUMENTS");
  assert.equal(errorCode(responses[2]), "PROOFWAKE_MCP_REPOSITORY_REQUIRED");
  assert.equal(errorCode(responses[3]), "PROOFWAKE_MCP_INVALID_REPOSITORY");
  assert.equal(errorCode(responses[4]), "PROOFWAKE_MCP_INVALID_ARGUMENTS");
  assert.equal(errorCode(responses[5]), "PROOFWAKE_MCP_REVISION_REQUIRED");
  assert.equal(errorCode(responses[6]), "PROOFWAKE_MCP_INVALID_REVISION");
  assert.equal(errorCode(responses[7]), "PROJECTION_REPOSITORY_UNKNOWN");
  assert.equal(JSON.stringify(responses).includes("private"), false);
});

test("missing, corrupt, and unreadable projection stores return bounded machine errors", async () => {
  const eventStore = { readAll: async () => [] };
  const missing = await exchange(mcpOptions({ eventStore, registryStore: undefined }), [
    initialize(),
    call("proofwake_fleet_status", {}),
  ]);
  assert.equal(errorCode(missing[1]), "PROOFWAKE_MCP_REGISTRY_UNAVAILABLE");

  const secret = "/private/checkout stdout stderr token prompt response receipt-bytes";
  const corruptError = new Error(`Unknown registry field from ${secret}`);
  corruptError.code = "REPOSITORY_REGISTRY_UNKNOWN_FIELD";
  const corrupt = await exchange(mcpOptions({
    eventStore,
    registryStore: { read: async () => { throw corruptError; } },
  }), [initialize(), call("proofwake_fleet_status", {})]);
  assert.equal(errorCode(corrupt[1]), "REPOSITORY_REGISTRY_UNKNOWN_FIELD");
  assert.equal(corrupt[1].result.structuredContent.error.message, "Repository registry is invalid.");
  assert.equal(JSON.stringify(corrupt[1]).includes(secret), false);

  const ledgerError = new Error(secret);
  const unreadableLedger = await exchange(mcpOptions({
    eventStore: { readAll: async () => { throw ledgerError; } },
    registryStore: { read: async () => ({ version: 1, entries: [] }) },
  }), [initialize(), call("proofwake_fleet_status", {})]);
  assert.equal(errorCode(unreadableLedger[1]), "PROOFWAKE_MCP_LEDGER_UNAVAILABLE");
  assert.equal(JSON.stringify(unreadableLedger[1]).includes(secret), false);
});

test("one broken checkout stays repository-local and deterministic cursors remain stable", async () => {
  await temporary(async (directory) => {
    const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
    const eventStore = new JsonlEventStore(join(directory, "events.jsonl"));
    const healthy = await createRepository(directory, "acme/healthy", registryStore);
    const broken = await createRepository(directory, "acme/broken", registryStore);
    await new ObservationLedger(eventStore).append(observation({
      id: "healthy-passed",
      repository: "acme/healthy",
      revision: healthy.revision,
      status: "passed",
      observedAt: "2026-07-26T13:00:00.000Z",
    }));
    await rm(broken.root, { recursive: true, force: true });

    const responses = await exchange(mcpOptions({ eventStore, registryStore }), [
      initialize(),
      call("proofwake_fleet_status", {}, 2),
      call("proofwake_fleet_status", {}, 3),
      call("proofwake_repository_status", { repository: "acme/healthy" }, 4),
      call("proofwake_repository_status", { repository: "acme/healthy" }, 5),
    ]);
    const firstFleet = responses[1].result.structuredContent;
    const secondFleet = responses[2].result.structuredContent;
    assert.equal(firstFleet.sourceCursor, secondFleet.sourceCursor);
    assert.deepEqual(firstFleet.repositories.map((entry) => [entry.repository.identity, entry.sourceCursor]),
      secondFleet.repositories.map((entry) => [entry.repository.identity, entry.sourceCursor]));
    const byIdentity = new Map(firstFleet.repositories.map((entry) => [entry.repository.identity, entry]));
    assert.equal(byIdentity.get("acme/healthy").status, "green");
    assert.equal(byIdentity.get("acme/broken").status, "yellow");
    assert.equal(byIdentity.get("acme/broken").classification, "misconfigured");
    assert.equal(responses[3].result.structuredContent.sourceCursor, responses[4].result.structuredContent.sourceCursor);
    assert.equal(JSON.stringify(firstFleet).includes(broken.root), false);
  });
});

test("stdio framing, limits, and negotiated protocol remain unchanged with Proofwake tools", async () => {
  const registryStore = { read: async () => ({ version: 1, entries: [] }) };
  const eventStore = { readAll: async () => [] };
  const oversized = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping", padding: "x".repeat(400) });
  const responses = await exchange(mcpOptions({ eventStore, registryStore }), [
    `${JSON.stringify(initialize(1, "2024-11-05"))}\r`,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    oversized,
    { jsonrpc: "2.0", id: 3, method: "ping" },
  ], { maximumLineBytes: 256 });

  assert.equal(responses[0].result.protocolVersion, "2024-11-05");
  assert.equal(responses[1].result.tools.some((tool) => tool.name === "proofwake_fleet_status"), true);
  assert.equal(responses[2].error.code, -32700);
  assert.equal(responses[2].error.data, "Message exceeds the stdio size limit");
  assert.deepEqual(responses[3].result, {});
});
