#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../src/main.js", import.meta.url));
const iterations = integerArgument(process.argv[2] ?? "64", "iterations", 1, 4096);
const seed = integerArgument(process.argv[3] ?? "1337", "seed", 0, 0x7fffffff);
const directory = mkdtempSync(join(tmpdir(), "proofwake-observation-fuzz-"));

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
  (value) => compact({ ...value, privateUnknownField: "sentinel" }),
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
  });
}

function response(result, label) {
  if (result.stderr !== "") throw new Error(`${label}: machine mode wrote to stderr`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label}: machine mode returned invalid JSON`);
  }
}

try {
  const validResult = invoke(compact(baseObservation()), join(directory, "valid.jsonl"));
  const validResponse = response(validResult, "valid baseline");
  if (validResult.status !== 0 || validResponse.status !== "inserted") {
    throw new Error(`valid baseline rejected with ${validResponse.error?.code ?? validResponse.status}`);
  }

  const random = generator(seed);
  const codes = new Map();
  for (let index = 0; index < iterations; index += 1) {
    const mutationIndex = random() % mutations.length;
    const value = baseObservation(`fuzz-valid-${index}`);
    value.id = "fuzz-valid";
    const text = mutations[mutationIndex](value);
    const result = invoke(text, join(directory, `mutation-${index}.jsonl`));
    const body = response(result, `mutation ${index}`);
    if (result.status === 0 || body.status !== "error") {
      throw new Error(`mutation ${index} operator ${mutationIndex} was accepted`);
    }
    const code = body.error?.code;
    if (typeof code !== "string" || !code.startsWith("OBSERVATION_")) {
      throw new Error(`mutation ${index} returned unstable error code ${String(code)}`);
    }
    codes.set(code, (codes.get(code) ?? 0) + 1);
  }

  process.stdout.write(`${JSON.stringify({
    service: "proofwake",
    command: "fuzz-observation-cli",
    status: "passed",
    iterations,
    seed,
    distinctErrorCodes: codes.size,
    errors: Object.fromEntries([...codes].sort()),
  }, null, 2)}\n`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
