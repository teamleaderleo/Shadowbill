import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { discloseProofwakeProjection } from "../src/projection-mcp-disclosure.js";
import { DEFAULT_WORKING_PROFILE } from "../src/estimate.js";
import { buildEvaluationProjection } from "../src/evaluation-projection.js";
import { observationLedgerRecord } from "../src/observation-ledger.js";
import { runProofwakeMcpStdioServer } from "../src/proofwake-mcp.js";

const repository = "teamleaderleo/stensibly";
const taskClass = "oauth-client-lifecycle";
const targetRun = "run_w01_oauth_implementation_01";
const pricing = {
  inputPerMillion: 5,
  cachedInputPerMillion: 0.5,
  cacheWritePerMillion: 6.25,
  outputPerMillion: 30,
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
};

const initialize = (id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "proofwake-evaluation-mcp-test", version: "1.0.0" },
  },
});

function call(args, id = 2, extra = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "proofwake_evaluation_evidence",
      arguments: args,
      ...extra,
    },
  };
}

function options({ eventStore, registryStore, allowWrites = false }) {
  return {
    store: eventStore,
    registryStore,
    pricing,
    profile: DEFAULT_WORKING_PROFILE,
    timeZone: "America/Los_Angeles",
    allowWrites,
    now: () => new Date("2026-07-27T22:00:00.000Z"),
  };
}

async function exchange(serverOptions, messages) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  const running = runProofwakeMcpStdioServer(serverOptions, { input, output });
  for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
  input.end();
  await running;
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function fixture(name) {
  return JSON.parse(await readFile(
    new URL(`./fixtures/observations/${name}`, import.meta.url),
    "utf8",
  ));
}

async function evaluationEvents() {
  const [work, review] = await Promise.all([
    fixture("stensibly-work-evaluation-repair-v1.json"),
    fixture("stensibly-review-finding-upheld-v1.json"),
  ]);
  return [observationLedgerRecord(work), observationLedgerRecord(review)];
}

function errorCode(response) {
  return response.result.structuredContent.error.code;
}

test("evaluation evidence tool is read-only, closed-world, and task-forbidden", async () => {
  const responses = await exchange(options({
    eventStore: { readAll: async () => [] },
    registryStore: { read: async () => ({ version: 1, entries: [] }) },
  }), [
    initialize(),
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);

  const tool = responses[1].result.tools.find((candidate) =>
    candidate.name === "proofwake_evaluation_evidence"
  );
  assert.ok(tool);
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(tool.execution, { taskSupport: "forbidden" });
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ["repository", "taskClass"]);
  assert.match(responses[0].result.instructions, /proofwake_evaluation_evidence/u);
});

test("evaluation MCP output matches the disclosed merged projection from one ledger snapshot and no registry read", async () => {
  const events = await evaluationEvents();
  const counts = { ledger: 0, registry: 0, append: 0 };
  const eventStore = {
    readAll: async () => {
      counts.ledger += 1;
      return events;
    },
    append: async () => {
      counts.append += 1;
      throw new Error("evaluation MCP must not append");
    },
  };
  const registryStore = {
    read: async () => {
      counts.registry += 1;
      throw new Error("evaluation MCP must not read registry");
    },
  };
  const expected = discloseProofwakeProjection(buildEvaluationProjection({
    events,
    repository,
    taskClass,
  }));

  const responses = await exchange(options({ eventStore, registryStore }), [
    initialize(),
    call({ repository, taskClass }),
  ]);

  assert.equal(responses[1].result.isError, false);
  assert.deepEqual(responses[1].result.structuredContent, expected);
  assert.deepEqual(JSON.parse(responses[1].result.content[0].text), expected);
  assert.equal(counts.ledger, 1);
  assert.equal(counts.registry, 0);
  assert.equal(counts.append, 0);
  assert.equal(JSON.stringify(responses[1]).includes("score"), false);
});

test("optional target run preserves exact merged projection semantics", async () => {
  const events = await evaluationEvents();
  let reads = 0;
  const expected = discloseProofwakeProjection(buildEvaluationProjection({
    events,
    repository,
    taskClass,
    targetRun,
  }));
  const responses = await exchange(options({
    eventStore: {
      readAll: async () => {
        reads += 1;
        return events;
      },
    },
    registryStore: undefined,
  }), [
    initialize(),
    call({ repository, taskClass, targetRun }),
  ]);

  assert.equal(responses[1].result.isError, false);
  assert.deepEqual(responses[1].result.structuredContent, expected);
  assert.equal(responses[1].result.structuredContent.selection.targetRun, targetRun);
  assert.equal(reads, 1);
});

test("invalid evaluation arguments fail before ledger or registry reads", async () => {
  const counts = { ledger: 0, registry: 0 };
  const secret = "private-argument-sentinel";
  const responses = await exchange(options({
    eventStore: {
      readAll: async () => {
        counts.ledger += 1;
        return [];
      },
    },
    registryStore: {
      read: async () => {
        counts.registry += 1;
        return { version: 1, entries: [] };
      },
    },
  }), [
    initialize(),
    call({}, 2),
    call({ repository }, 3),
    call({ repository: "not-an-owner-name", taskClass }, 4),
    call({ repository, taskClass: "contains space" }, 5),
    call({ repository, taskClass, targetRun: "not-a-run" }, 6),
    call({ repository, taskClass, extra: secret }, 7),
  ]);

  assert.equal(errorCode(responses[1]), "PROOFWAKE_MCP_REPOSITORY_REQUIRED");
  assert.equal(errorCode(responses[2]), "PROOFWAKE_MCP_TASK_CLASS_REQUIRED");
  assert.equal(errorCode(responses[3]), "PROOFWAKE_MCP_INVALID_REPOSITORY");
  assert.equal(errorCode(responses[4]), "PROOFWAKE_MCP_INVALID_TASK_CLASS");
  assert.equal(errorCode(responses[5]), "PROOFWAKE_MCP_INVALID_TARGET_RUN");
  assert.equal(errorCode(responses[6]), "PROOFWAKE_MCP_INVALID_ARGUMENTS");
  assert.equal(counts.ledger, 0);
  assert.equal(counts.registry, 0);
  assert.equal(JSON.stringify(responses).includes(secret), false);
});

test("evaluation ledger failures are fixed and content-minimised without a registry dependency", async () => {
  const secret = "/private/ledger token prompt response patch logs environment";
  let registryReads = 0;
  const responses = await exchange(options({
    eventStore: {
      readAll: async () => {
        throw new Error(secret);
      },
    },
    registryStore: {
      read: async () => {
        registryReads += 1;
        return { version: 1, entries: [] };
      },
    },
  }), [
    initialize(),
    call({ repository, taskClass }),
  ]);

  assert.equal(errorCode(responses[1]), "PROOFWAKE_MCP_LEDGER_UNAVAILABLE");
  assert.equal(responses[1].result.structuredContent.error.message, "Proofwake ledger is unavailable.");
  assert.equal(registryReads, 0);
  assert.equal(JSON.stringify(responses).includes(secret), false);
});

test("evaluation evidence remains read-only when compatibility writes are enabled", async () => {
  const events = await evaluationEvents();
  let appendCalls = 0;
  const responses = await exchange(options({
    eventStore: {
      readAll: async () => events,
      append: async () => {
        appendCalls += 1;
        throw new Error("unexpected append");
      },
    },
    registryStore: undefined,
    allowWrites: true,
  }), [
    initialize(),
    call({ repository, taskClass }),
  ]);

  assert.equal(responses[1].result.isError, false);
  assert.equal(appendCalls, 0);
});
