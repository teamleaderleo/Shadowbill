import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canonicalJson,
  normalizeObservation,
  parseStrictJson,
  prepareObservation,
} from "../src/observation.js";

const fixtureUrl = new URL("./fixtures/observation-valid.json", import.meta.url);

async function fixture() {
  return readFile(fixtureUrl, "utf8");
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseKeys(nested)]));
  }
  return value;
}

test("strict JSON rejects duplicate keys at nested levels", () => {
  assert.throws(
    () => parseStrictJson('{"data":{"status":"passed","status":"failed"}}'),
    (error) => error?.code === "PW_JSON_DUPLICATE_KEY" && /status/.test(error.message),
  );
});

test("strict JSON rejects excessive nesting and non-finite numbers", () => {
  const nested = `${"[".repeat(14)}0${"]".repeat(14)}`;
  assert.throws(() => parseStrictJson(nested), (error) => error?.code === "PW_JSON_DEPTH");
  assert.throws(() => parseStrictJson('{"value":1e999}'), (error) => error?.code === "PW_JSON_NON_FINITE");
});

test("observation normalization is bounded, explicit, and deterministic", async () => {
  const source = await fixture();
  const prepared = prepareObservation(source, { now: new Date("2026-07-25T17:01:00Z") });

  assert.equal(prepared.event.specversion, "1.0");
  assert.equal(prepared.event.time, "2026-07-25T17:00:00.000Z");
  assert.equal(prepared.event.data.repository.id, "team/repo");
  assert.equal(prepared.event.data.evidence.length, 0);
  assert.equal(prepared.event.proofwakeingestedat, "2026-07-25T17:01:00.000Z");
  assert.match(prepared.fingerprint, /^[0-9a-f]{64}$/);

  const parsed = JSON.parse(source);
  const reordered = JSON.stringify(reverseKeys(parsed));
  assert.notEqual(reordered, JSON.stringify(parsed));
  assert.equal(prepared.fingerprint, prepareObservation(reordered).fingerprint);
  assert.equal(prepared.fingerprint, prepareObservation(canonicalJson(normalizeObservation(parsed))).fingerprint);
});

test("source and type identity stay source-defined while timestamps are strict", async () => {
  const valid = JSON.parse(await fixture());
  valid.source = "urn:Example:Case-Sensitive-Source";
  valid.type = "Dev.Proofwake.Verify.Finished.V1";
  const normalized = normalizeObservation(valid);
  assert.equal(normalized.source, valid.source);
  assert.equal(normalized.type, valid.type);

  assert.throws(
    () => normalizeObservation({ ...valid, time: "2026-07-25" }),
    (error) => error?.code === "PW_SCHEMA_INVALID" && /RFC 3339/.test(error.message),
  );
});

test("unknown envelope, data, and attribute fields fail closed", async () => {
  const valid = JSON.parse(await fixture());
  assert.throws(
    () => normalizeObservation({ ...valid, prompt: "private" }),
    (error) => error?.code === "PW_SCHEMA_UNKNOWN_FIELD",
  );
  assert.throws(
    () => normalizeObservation({ ...valid, data: { ...valid.data, log: "private" } }),
    (error) => error?.code === "PW_SCHEMA_UNKNOWN_FIELD",
  );
  assert.throws(
    () => normalizeObservation({
      ...valid,
      data: { ...valid.data, attributes: { "proofwake.prompt": "private" } },
    }),
    (error) => error?.code === "PW_SCHEMA_UNKNOWN_FIELD",
  );
});

test("repository identity variants reject contradictory fields", async () => {
  const valid = JSON.parse(await fixture());
  const localId = `sha256:${"a".repeat(64)}`;
  const local = normalizeObservation({
    ...valid,
    data: {
      ...valid.data,
      repository: { kind: "local", localId },
    },
  });
  assert.deepEqual(local.data.repository, { kind: "local", localId });

  assert.throws(
    () => normalizeObservation({
      ...valid,
      data: { ...valid.data, repository: { ...valid.data.repository, localId } },
    }),
    (error) => error?.code === "PW_SCHEMA_INVALID" && /must not include localId/.test(error.message),
  );
  assert.throws(
    () => normalizeObservation({
      ...valid,
      data: { ...valid.data, repository: { kind: "local", localId, id: "team/repo" } },
    }),
    (error) => error?.code === "PW_SCHEMA_INVALID" && /remote repository fields/.test(error.message),
  );
});
