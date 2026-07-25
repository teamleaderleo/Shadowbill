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

  const reordered = JSON.stringify(JSON.parse(source), Object.keys(JSON.parse(source)).reverse());
  assert.notEqual(reordered, source);
  const normalized = normalizeObservation(JSON.parse(source));
  assert.equal(prepared.fingerprint, prepareObservation(canonicalJson(normalized)).fingerprint);
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

test("local repository identity uses a privacy-preserving digest", async () => {
  const valid = JSON.parse(await fixture());
  const local = normalizeObservation({
    ...valid,
    data: {
      ...valid.data,
      repository: {
        kind: "local",
        localId: `sha256:${"a".repeat(64)}`,
      },
    },
  });
  assert.deepEqual(local.data.repository, {
    kind: "local",
    localId: `sha256:${"a".repeat(64)}`,
  });
});
