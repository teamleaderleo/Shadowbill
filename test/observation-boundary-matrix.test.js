import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readBoundedObservationStream } from "../src/emit.js";
import { parseObservationJson, validateObservation } from "../src/observation.js";

const main = fileURLToPath(new URL("../src/main.js", import.meta.url));
const PRIVATE_MARKER = "PRIVATE_BOUNDARY_SENTINEL";

function observation() {
  const revision = "a".repeat(40);
  return {
    specversion: "1.0",
    id: "boundary-valid",
    source: "urn:proofwake:boundary-test",
    type: "dev.proofwake.observation.verify.v1",
    subject: `repo:acme/demo@sha:${revision}`,
    time: "2026-01-01T00:00:00.000Z",
    dataschema: "urn:proofwake:schema:observation:v1",
    data: {
      schemaVersion: 1,
      adapter: {
        name: "boundary-test",
        version: "1.0.0",
        mappingVersion: 1,
        trust: "local-operator",
        sourceSchema: "boundary.fixture.v1",
        sourceSchemaVersion: "1",
      },
      kind: "verify",
      status: "passed",
      timeSource: "adapter",
      observedAt: "2026-01-01T00:00:00.000Z",
      ingestedAt: "2026-01-01T00:00:00.000Z",
      relationships: { repository: "acme/demo", revision },
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

function evidence(sizeBytes) {
  return {
    uri: "urn:proofwake:evidence:boundary",
    digest: `sha256:${"b".repeat(64)}`,
    sizeBytes,
    mediaType: "application/json",
    producer: "boundary-test",
    schema: "boundary.fixture.v1",
    state: "verified",
    disclosure: "private-metadata",
  };
}

function environment() {
  const value = { ...process.env };
  for (const key of ["PROOFWAKE_DATA", "SHADOWBILL_DATA"]) delete value[key];
  return value;
}

function runEmit(input, dataPath) {
  return spawnSync(process.execPath, [
    main,
    "emit",
    "--stdin",
    "--data",
    dataPath,
    "--output",
    "json",
  ], {
    input,
    encoding: "utf8",
    env: environment(),
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
}

async function assertMissing(path) {
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
}

function assertInvalid(mutator, path) {
  const value = observation();
  mutator(value);
  assert.throws(
    () => validateObservation(value),
    (error) => error?.code === "OBSERVATION_INVALID_VALUE" && error?.path === path,
  );
}

test("accepts every numeric field at its exact lower and upper boundary", () => {
  const values = [
    ["adapter mapping version minimum", (value) => { value.data.adapter.mappingVersion = 0; }],
    ["adapter mapping version maximum", (value) => { value.data.adapter.mappingVersion = 65_535; }],
    ["workflow attempt minimum", (value) => { value.data.relationships.workflowAttempt = 0; }],
    ["workflow attempt maximum", (value) => { value.data.relationships.workflowAttempt = 1_000_000; }],
    ["duration minimum", (value) => { value.data.durationMs = 0; }],
    ["duration maximum", (value) => { value.data.durationMs = 31_536_000_000; }],
    ["evidence size minimum", (value) => { value.data.evidence = [evidence(0)]; }],
    ["evidence size maximum", (value) => { value.data.evidence = [evidence(1_000_000_000_000)]; }],
    ["fact safe integer minimum", (value) => { value.data.facts = [{ name: "boundary.value", value: Number.MIN_SAFE_INTEGER }]; }],
    ["fact safe integer maximum", (value) => { value.data.facts = [{ name: "boundary.value", value: Number.MAX_SAFE_INTEGER }]; }],
  ];

  for (const [label, mutate] of values) {
    const value = observation();
    mutate(value);
    assert.equal(validateObservation(value), value, label);
    assert.equal(parseObservationJson(JSON.stringify(value)).data.schemaVersion, 1, label);
  }
});

test("rejects values immediately outside every bounded numeric field", () => {
  const invalid = [
    [(value) => { value.data.adapter.mappingVersion = -1; }, "$.data.adapter.mappingVersion"],
    [(value) => { value.data.adapter.mappingVersion = 65_536; }, "$.data.adapter.mappingVersion"],
    [(value) => { value.data.adapter.mappingVersion = 1.5; }, "$.data.adapter.mappingVersion"],
    [(value) => { value.data.relationships.workflowAttempt = -1; }, "$.data.relationships.workflowAttempt"],
    [(value) => { value.data.relationships.workflowAttempt = 1_000_001; }, "$.data.relationships.workflowAttempt"],
    [(value) => { value.data.relationships.workflowAttempt = 1.5; }, "$.data.relationships.workflowAttempt"],
    [(value) => { value.data.durationMs = -1; }, "$.data.durationMs"],
    [(value) => { value.data.durationMs = 31_536_000_001; }, "$.data.durationMs"],
    [(value) => { value.data.durationMs = 0.5; }, "$.data.durationMs"],
    [(value) => { value.data.evidence = [evidence(-1)]; }, "$.data.evidence[0].sizeBytes"],
    [(value) => { value.data.evidence = [evidence(1_000_000_000_001)]; }, "$.data.evidence[0].sizeBytes"],
    [(value) => { value.data.evidence = [evidence(1.5)]; }, "$.data.evidence[0].sizeBytes"],
    [(value) => { value.data.facts = [{ name: "boundary.value", value: Number.MIN_SAFE_INTEGER - 1 }]; }, "$.data.facts[0].value"],
    [(value) => { value.data.facts = [{ name: "boundary.value", value: Number.MAX_SAFE_INTEGER + 1 }]; }, "$.data.facts[0].value"],
    [(value) => { value.data.facts = [{ name: "boundary.value", value: 1.5 }]; }, "$.data.facts[0].value"],
    [(value) => { value.data.facts = [{ name: "boundary.value", value: Infinity }]; }, "$.data.facts[0].value"],
  ];

  for (const [mutate, path] of invalid) assertInvalid(mutate, path);
});

test("raw JSON numeric literals cannot bypass safe-integer validation", () => {
  const base = JSON.stringify(observation());
  const cases = [
    ["9007199254740992", "positive unsafe integer"],
    ["9007199254740993", "positive rounded unsafe integer"],
    ["-9007199254740992", "negative unsafe integer"],
    ["1e999", "non-finite exponent"],
    ["1.25", "fractional value"],
  ];

  for (const [literal, label] of cases) {
    const text = base.replace('"facts":[]', `"facts":[{"name":"boundary.value","value":${literal}}]`);
    assert.throws(
      () => parseObservationJson(text),
      (error) => error?.code === "OBSERVATION_INVALID_VALUE" && error?.path === "$.data.facts[0].value",
      label,
    );
  }
});

test("accepts valid Unicode scalar values and escaped surrogate pairs", () => {
  const value = observation();
  value.data.evidence = [{ ...evidence(1), uri: "urn:proofwake:evidence:rocket-🚀" }];
  const literal = JSON.stringify(value);
  const escaped = literal.replace("🚀", "\\ud83d\\ude80");

  assert.equal(parseObservationJson(literal).data.evidence[0].uri, "urn:proofwake:evidence:rocket-🚀");
  assert.equal(parseObservationJson(escaped).data.evidence[0].uri, "urn:proofwake:evidence:rocket-🚀");
});

test("detects duplicate keys even when one spelling uses Unicode escapes", () => {
  const text = JSON.stringify(observation()).replace(
    '"id":"boundary-valid"',
    '"id":"first","\\u0069d":"second"',
  );
  assert.throws(
    () => parseObservationJson(text),
    (error) => error?.code === "OBSERVATION_DUPLICATE_KEY" && error?.path === "$.id",
  );
});

test("stream decoding rejects representative malformed UTF-8 classes", async () => {
  const malformed = [
    ["isolated continuation", [0x80]],
    ["overlong NUL", [0xc0, 0x80]],
    ["truncated sequence", [0xe2, 0x82]],
    ["encoded surrogate", [0xed, 0xa0, 0x80]],
    ["above Unicode maximum", [0xf4, 0x90, 0x80, 0x80]],
  ];

  for (const [label, bytes] of malformed) {
    const input = Buffer.concat([
      Buffer.from(`{"marker":"${PRIVATE_MARKER}","value":"`, "utf8"),
      Buffer.from(bytes),
      Buffer.from('"}', "utf8"),
    ]);
    await assert.rejects(
      readBoundedObservationStream(Readable.from([input])),
      (error) => error?.code === "OBSERVATION_INVALID_UTF8" && !error.message.includes(PRIVATE_MARKER),
      label,
    );
  }
});

test("installed emit returns bounded JSON and no ledger effect for malformed UTF-8", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-boundary-utf8-"));
  try {
    const malformed = [
      ["isolated", [0x80]],
      ["overlong", [0xc0, 0x80]],
      ["truncated", [0xe2, 0x82]],
      ["surrogate", [0xed, 0xa0, 0x80]],
      ["too-high", [0xf4, 0x90, 0x80, 0x80]],
    ];

    for (const [name, bytes] of malformed) {
      const dataPath = join(directory, `${name}.jsonl`);
      const input = Buffer.concat([
        Buffer.from(`{"marker":"${PRIVATE_MARKER}","value":"`, "utf8"),
        Buffer.from(bytes),
        Buffer.from('"}', "utf8"),
      ]);
      const result = runEmit(input, dataPath);
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.equal(result.stderr, "", name);
      const body = JSON.parse(result.stdout);
      assert.equal(body.status, "error", name);
      assert.equal(body.error.code, "OBSERVATION_INVALID_UTF8", name);
      assert.equal(JSON.stringify(body).includes(PRIVATE_MARKER), false, name);
      await assertMissing(dataPath);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed emit preserves valid Unicode metadata through the ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-boundary-unicode-"));
  const dataPath = join(directory, "events.jsonl");
  try {
    const value = observation();
    value.data.evidence = [{ ...evidence(1), uri: "urn:proofwake:evidence:rocket-🚀" }];
    const result = runEmit(Buffer.from(JSON.stringify(value), "utf8"), dataPath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const body = JSON.parse(result.stdout);
    assert.equal(body.status, "inserted");

    const records = (await readFile(dataPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].observation.data.evidence[0].uri, "urn:proofwake:evidence:rocket-🚀");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
