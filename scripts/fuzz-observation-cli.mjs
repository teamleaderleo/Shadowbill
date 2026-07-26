#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../src/main.js", import.meta.url));
const iterations = integerArgument(process.argv[2] ?? "64", "iterations", 1, 4096);
const seed = integerArgument(process.argv[3] ?? "1337", "seed", 0, 0xffffffff);
const directory = mkdtempSync(join(tmpdir(), "proofwake-observation-fuzz-"));
const PRIVATE_MARKER = "proofwake-secret-sentinel";

function integerArgument(value, name, minimum, maximum) {
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function generator(initial) {
  let state = initial >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function baseObservation(id = "fuzz-valid") {
  const revision = "a".repeat(40);
  return {
    specversion: "1.0",
    id,
    source: "urn:proofwake:fuzz-harness",
    type: "dev.proofwake.observation.verify.v1",
    subject: `repo:acme/demo@sha:${revision}`,
    time: "2026-01-01T00:00:00.000Z",
    dataschema: "urn:proofwake:schema:observation:v1",
    data: {
      schemaVersion: 1,
      adapter: {
        name: "fuzz-harness",
        version: "1.0.0",
        mappingVersion: 1,
        trust: "local-operator",
        sourceSchema: "proofwake.fuzz.fixture",
        sourceSchemaVersion: "1",
      },
      kind: "verify",
      status: "passed",
      timeSource: "adapter",
      observedAt: "2026-01-01T00:00:00.000Z",
      ingestedAt: "2026-01-01T00:00:00.000Z",
      relationships: {
        repository: "acme/demo",
        revision,
      },
      facts: [],
      evidence: [],
      coverage: {
        state: "complete",
        redacted: false,
        truncated: false,
        omitted: [],
      },
    },
  };
}

function compact(value) {
  return JSON.stringify(value);
}

const mutations = [
  (value) => compact(value).replace('"id":"fuzz-valid"', '"id":"first","id":"fuzz-valid"'),
  (value) => compact(value).replace('"name":"fuzz-harness"', '"name":"first","name":"fuzz-harness"'),
  (value) => compact({ ...value, [PRIVATE_MARKER]: "sentinel-value" }),
  (value) => compact({ ...value, data: { ...value.data, privateUnknownField: "sentinel" } }),
  (value) => `${compact(value)} trailing`,
  (value) => compact(value).replace('"id":"fuzz-valid"', '"id":"\\x"'),
  (value) => {
    let nested = "sentinel";
    for (let index = 0; index < 32; index += 1) nested = { nested };
    return compact({ ...value, data: { ...value.data, privateUnknownField: nested } });
  },
  (value) => compact({ ...value, privateUnknownField: "x".repeat(70_000) }),
  (value) => compact({
    ...value,
    subject: `repo:acme/demo@sha:${"b".repeat(40)}`,
  }),
  (value) => compact({ ...value, data: { ...value.data, status: "success" } }),
  (value) => compact({ ...value, source: "source with spaces" }),
  (value) => compact({
    ...value,
    data: {
      ...value.data,
      facts: [
        { name: "fuzz.result", value: "one" },
        { name: "fuzz.result", value: "two" },
      ],
    },
  }),
  (value) => compact({
    ...value,
    data: {
      ...value.data,
      evidence: [{
        uri: "urn:fuzz:evidence",
        digest: "sha256:invalid",
        sizeBytes: 1,
        mediaType: "application/json",
        producer: "fuzz-harness",
        schema: "fuzz.fixture.v1",
        state: "verified",
        disclosure: "private-metadata",
      }],
    },
  }),
  (value) => compact({
    ...value,
    data: {
      ...value.data,
      coverage: { ...value.data.coverage, privateUnknownField: true },
    },
  }),
  (value) => compact({ ...value, id: "x".repeat(1024) }),
  (value) => compact({ ...value, time: "not-a-time" }),
  (value) => compact({ ...value, data: { ...value.data, facts: {} } }),
  (value) => compact(value).replace('"schemaVersion":1', '"schemaVersion":1e999'),
  (value) => {
    const copy = structuredClone(value);
    delete copy.source;
    return compact(copy);
  },
  (value) => compact({ ...value, subject: "repo:bad subject" }),
];

function invoke(text, dataPath) {
  return spawnSync(process.execPath, [
    main,
    "emit",
    "--stdin",
    "--data",
    dataPath,
    "--output",
    "json",
  ], {
    encoding: "utf8",
    input: text,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
}

function response(result, label) {
  if (result.error) throw new Error(`${label}: process failed with ${result.error.code ?? result.error.message}`);
  if (result.signal) throw new Error(`${label}: process ended with ${result.signal}`);
  if (result.stderr !== "") throw new Error(`${label}: machine mode wrote to stderr`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label}: machine mode returned invalid JSON`);
  }
}

function ledgerEntries(dataPath) {
  if (!existsSync(dataPath)) return 0;
  return readFileSync(dataPath, "utf8").split("\n").filter((line) => line.trim().length > 0).length;
}

try {
  const validPath = join(directory, "valid.jsonl");
  const validResult = invoke(compact(baseObservation()), validPath);
  const validResponse = response(validResult, "valid baseline");
  if (validResult.status !== 0 || validResponse.status !== "inserted") {
    throw new Error(`valid baseline rejected with ${validResponse.error?.code ?? validResponse.status}`);
  }
  if (ledgerEntries(validPath) !== 1) throw new Error("valid baseline did not create exactly one ledger entry");

  const random = generator(seed);
  const codes = new Map();
  const operatorHits = Array.from({ length: mutations.length }, () => 0);
  for (let index = 0; index < iterations; index += 1) {
    const mutationIndex = index < mutations.length ? index : random() % mutations.length;
    operatorHits[mutationIndex] += 1;
    const value = baseObservation();
    const text = mutations[mutationIndex](value);
    const dataPath = join(directory, `mutation-${index}.jsonl`);
    const result = invoke(text, dataPath);
    const body = response(result, `mutation ${index}`);
    if (result.status === 0 || body.status !== "error") {
      throw new Error(`mutation ${index} operator ${mutationIndex} was accepted`);
    }
    if (ledgerEntries(dataPath) !== 0) {
      throw new Error(`mutation ${index} operator ${mutationIndex} changed the accepted ledger`);
    }
    const serialized = JSON.stringify(body);
    if (serialized.includes(PRIVATE_MARKER) || serialized.includes("sentinel-value")) {
      throw new Error(`mutation ${index} disclosed attacker-controlled content`);
    }
    const code = body.error?.code;
    if (typeof code !== "string" || !code.startsWith("OBSERVATION_")) {
      throw new Error(`mutation ${index} returned unstable error code ${String(code)}`);
    }
    codes.set(code, (codes.get(code) ?? 0) + 1);
  }

  const exercisedOperators = operatorHits.filter((count) => count > 0).length;
  if (iterations >= mutations.length && exercisedOperators !== mutations.length) {
    throw new Error(`only ${exercisedOperators}/${mutations.length} mutation operators were exercised`);
  }

  process.stdout.write(`${JSON.stringify({
    service: "proofwake",
    command: "fuzz-observation-cli",
    status: "passed",
    iterations,
    seed,
    operatorCount: mutations.length,
    exercisedOperators,
    operatorHits,
    distinctErrorCodes: codes.size,
    errors: Object.fromEntries([...codes].sort()),
  }, null, 2)}\n`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
