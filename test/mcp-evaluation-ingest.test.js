import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DEFAULT_WORKING_PROFILE } from "../src/estimate.js";
import { runProofwakeMcpStdioServer } from "../src/proofwake-mcp.js";
import { JsonlEventStore } from "../src/store.js";

const main = new URL("../src/main.js", import.meta.url).pathname;
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
    clientInfo: { name: "proofwake-evaluation-write-test", version: "1.0.0" },
  },
});

function call(receiptJson, id = 2, extra = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "proofwake_submit_evaluation_receipt",
      arguments: { receiptJson },
      ...extra,
    },
  };
}

function options({ store, allowWrites, allowEvaluationWrites, now }) {
  return {
    store,
    registryStore: undefined,
    pricing,
    profile: DEFAULT_WORKING_PROFILE,
    timeZone: "America/Los_Angeles",
    ...(allowWrites === undefined ? {} : { allowWrites }),
    ...(allowEvaluationWrites === undefined ? {} : { allowEvaluationWrites }),
    now: now ?? (() => new Date("2026-07-28T01:00:00.000Z")),
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

function runProcess(args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        PROOFWAKE_MCP_ALLOW_WRITES: "",
        SHADOWBILL_MCP_ALLOW_WRITES: "",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function fixture(name) {
  return readFile(new URL(`./fixtures/observations/${name}`, import.meta.url), "utf8");
}

async function temporary(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-mcp-evaluation-ingest-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function toolNames(response) {
  return response.result.tools.map((tool) => tool.name);
}

function toolErrorCode(response) {
  return response.result.structuredContent.error.code;
}

test("evaluation and legacy write gates remain independent in all four discovery modes", async () => {
  const store = { readAll: async () => [], appendIdempotent: async () => ({ status: "inserted" }) };
  const modes = [
    [{}, false, false],
    [{ allowEvaluationWrites: true }, true, false],
    [{ allowWrites: true }, false, true],
    [{ allowWrites: true, allowEvaluationWrites: true }, true, true],
  ];

  for (const [flags, evaluationPresent, shadowbillPresent] of modes) {
    const responses = await exchange(options({ store, ...flags }), [
      initialize(),
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    const names = toolNames(responses[1]);
    assert.equal(names.includes("proofwake_submit_evaluation_receipt"), evaluationPresent);
    assert.equal(names.includes("shadowbill_record_chat_turn"), shadowbillPresent);
    if (evaluationPresent) {
      const evaluationIndex = names.indexOf("proofwake_submit_evaluation_receipt");
      const shadowbillIndex = names.indexOf("shadowbill_record_chat_turn");
      assert.ok(evaluationIndex > names.indexOf("proofwake_evaluation_evidence"));
      if (shadowbillPresent) assert.ok(evaluationIndex < shadowbillIndex);
      const tool = responses[1].result.tools[evaluationIndex];
      assert.deepEqual(tool.annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      assert.deepEqual(tool.execution, { taskSupport: "forbidden" });
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.deepEqual(tool.inputSchema.required, ["receiptJson"]);
      assert.match(responses[0].result.instructions, /proofwake_submit_evaluation_receipt/u);
    } else {
      assert.doesNotMatch(responses[0].result.instructions, /proofwake_submit_evaluation_receipt/u);
    }
  }
});

test("enabled MCP accepts once, replays identically, and persists one canonical event", async () => {
  await temporary(async (directory) => {
    const receiptJson = await fixture("stensibly-work-evaluation-repair-v1.json");
    const store = new JsonlEventStore(join(directory, "events.jsonl"));
    const responses = await exchange(options({ store, allowEvaluationWrites: true }), [
      initialize(),
      call(receiptJson, 2),
      call(receiptJson, 3),
    ]);

    const first = responses[1].result.structuredContent;
    const replay = responses[2].result.structuredContent;
    assert.equal(responses[1].result.isError, false);
    assert.equal(first.accepted, true);
    assert.equal(first.replayed, false);
    assert.equal(first.status, "inserted");
    assert.equal(replay.accepted, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.status, "duplicate");
    assert.equal(replay.eventId, first.eventId);
    assert.equal(replay.fingerprint, first.fingerprint);
    assert.equal(replay.ingestedAt, first.ingestedAt);
    assert.equal((await store.readAll()).length, 1);
    assert.equal(JSON.stringify(responses).includes("receiptJson"), false);
  });
});

test("changed content under one identity returns a fixed conflict without a second append", async () => {
  await temporary(async (directory) => {
    const original = JSON.parse(await fixture("stensibly-work-evaluation-repair-v1.json"));
    const changed = structuredClone(original);
    changed.data.facts.find((fact) =>
      fact.name === "proofwake.evaluation.classification"
    ).value = "rejected";
    const store = new JsonlEventStore(join(directory, "events.jsonl"));
    const responses = await exchange(options({ store, allowEvaluationWrites: true }), [
      initialize(),
      call(JSON.stringify(original), 2),
      call(JSON.stringify(changed), 3),
    ]);

    assert.equal(responses[1].result.isError, false);
    assert.equal(responses[2].result.isError, true);
    assert.equal(toolErrorCode(responses[2]), "OBSERVATION_ID_CONFLICT");
    assert.equal(
      responses[2].result.structuredContent.error.message,
      "Evaluation receipt identity conflicts with accepted evidence.",
    );
    assert.equal((await store.readAll()).length, 1);
  });
});

test("disabled and task-bearing calls cannot reach the evaluation append path", async () => {
  const receiptJson = await fixture("stensibly-review-finding-upheld-v1.json");
  let appends = 0;
  const store = {
    readAll: async () => [],
    appendIdempotent: async () => {
      appends += 1;
      throw new Error("must not append");
    },
  };
  const disabled = await exchange(options({ store }), [
    initialize(),
    call(receiptJson),
  ]);
  assert.equal(disabled[1].error.code, -32601);

  const taskBearing = await exchange(options({ store, allowEvaluationWrites: true }), [
    initialize(),
    call(receiptJson, 2, { task: { id: "task-forbidden" } }),
  ]);
  assert.equal(taskBearing[1].error.code, -32601);
  assert.equal(appends, 0);
});

test("strict argument and receipt failures are bounded and never append or echo rejected content", async () => {
  const receipt = JSON.parse(await fixture("stensibly-work-evaluation-repair-v1.json"));
  receipt.data.facts.push({
    name: "proofwake.evaluation.prompt",
    value: "private-prompt-response-patch-token-sentinel",
  });
  let appends = 0;
  const store = {
    readAll: async () => [],
    appendIdempotent: async () => {
      appends += 1;
      throw new Error("must not append");
    },
  };
  const responses = await exchange(options({ store, allowEvaluationWrites: true }), [
    initialize(),
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "proofwake_submit_evaluation_receipt",
        arguments: {},
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "proofwake_submit_evaluation_receipt",
        arguments: { receiptJson: 42 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "proofwake_submit_evaluation_receipt",
        arguments: { receiptJson: "{}", extra: "private-extra" },
      },
    },
    call(JSON.stringify(receipt), 5),
  ]);

  assert.equal(toolErrorCode(responses[1]), "PROOFWAKE_MCP_RECEIPT_REQUIRED");
  assert.equal(toolErrorCode(responses[2]), "PROOFWAKE_MCP_INVALID_RECEIPT_JSON");
  assert.equal(toolErrorCode(responses[3]), "PROOFWAKE_MCP_INVALID_ARGUMENTS");
  assert.equal(toolErrorCode(responses[4]), "EVALUATION_UNKNOWN_FACT");
  assert.equal(
    responses[4].result.structuredContent.error.message,
    "Evaluation receipt verification failed.",
  );
  assert.equal(appends, 0);
  const publicText = JSON.stringify(responses);
  assert.equal(publicText.includes("private-prompt-response-patch-token-sentinel"), false);
  assert.equal(publicText.includes("private-extra"), false);
});

test("installed --allow-evaluation-writes flag enables only the evaluation write tool", async () => {
  await temporary(async (directory) => {
    const dataPath = join(directory, "events.jsonl");
    const input = [
      initialize(),
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";

    const disabled = await runProcess([main, "mcp", "--data", dataPath], input);
    assert.equal(disabled.code, 0, disabled.stderr);
    const disabledResponses = disabled.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(toolNames(disabledResponses[1]).includes("proofwake_submit_evaluation_receipt"), false);

    const enabled = await runProcess([
      main,
      "mcp",
      "--data", dataPath,
      "--allow-evaluation-writes",
    ], input);
    assert.equal(enabled.code, 0, enabled.stderr);
    const enabledResponses = enabled.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const names = toolNames(enabledResponses[1]);
    assert.equal(names.includes("proofwake_submit_evaluation_receipt"), true);
    assert.equal(names.includes("shadowbill_record_chat_turn"), false);
  });
});
