import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ObservationError,
  canonicalizeObservation,
  observationFingerprint,
  parseObservationJson,
  parseObservationSubject,
  validateObservation,
} from "../src/observation.js";

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/observations/${name}`, import.meta.url), "utf8"));
}

test("accepts unlike repository and host observations", async () => {
  const renderprove = await fixture("renderprove-browser-review-passed-v1.json");
  const smolrunner = await fixture("smolrunner-host-warning-v1.json");
  assert.equal(validateObservation(renderprove), renderprove);
  assert.equal(validateObservation(smolrunner), smolrunner);
  assert.deepEqual(parseObservationSubject(renderprove.subject), {
    kind: "repository-revision",
    repository: "teamleaderleo/renderprove",
    revision: "1111111111111111111111111111111111111111",
  });
  assert.deepEqual(parseObservationSubject(smolrunner.subject), {
    kind: "host",
    identity: "fixture-linux-runner",
  });
});

test("strict parser rejects duplicate keys at any depth", async () => {
  const value = await fixture("renderprove-browser-review-passed-v1.json");
  const text = JSON.stringify(value).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
  assert.throws(() => parseObservationJson(text), (error) => {
    assert.equal(error instanceof ObservationError, true);
    assert.equal(error.code, "OBSERVATION_DUPLICATE_KEY");
    assert.equal(error.path, "$.data.schemaVersion");
    return true;
  });
});

test("rejects unknown fields and content-bearing fact strings", async () => {
  const value = await fixture("smolrunner-host-warning-v1.json");
  assert.throws(() => validateObservation({ ...value, prompt: "secret" }), (error) => error.code === "OBSERVATION_UNKNOWN_FIELD");
  const withText = structuredClone(value);
  withText.data.facts[0].value = "systemctl exists but the host is not booted";
  assert.throws(() => validateObservation(withText), (error) => error.code === "OBSERVATION_INVALID_VALUE");
});

test("mapped fixtures exclude producer free text and raw locations", async () => {
  const renderprove = JSON.stringify(await fixture("renderprove-browser-review-passed-v1.json"));
  const smolrunner = JSON.stringify(await fixture("smolrunner-host-warning-v1.json"));
  for (const forbidden of ["Fixture application", "https://fixture.example", ".renderprove/artifacts", "requestedUrl", "finalUrl"]) {
    assert.equal(renderprove.includes(forbidden), false, forbidden);
  }
  for (const forbidden of ["systemctl exists", "executable path", "fixture detail intentionally", "git is available"]) {
    assert.equal(smolrunner.includes(forbidden), false, forbidden);
  }
});

test("canonical form is stable across object insertion order", async () => {
  const value = await fixture("renderprove-browser-review-passed-v1.json");
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(canonicalizeObservation(value), canonicalizeObservation(reordered));
});

test("fingerprint ignores ingestion time and detects semantic changes", async () => {
  const value = await fixture("renderprove-browser-review-passed-v1.json");
  const reingested = structuredClone(value);
  reingested.data.ingestedAt = "2026-07-25T17:00:00.000Z";
  assert.equal(observationFingerprint(value), observationFingerprint(reingested));
  const failed = structuredClone(value);
  failed.data.status = "failed";
  assert.notEqual(observationFingerprint(value), observationFingerprint(failed));
});

test("repository-revision subject must match explicit relationships", async () => {
  const value = await fixture("renderprove-browser-review-passed-v1.json");
  value.data.relationships.revision = "2222222222222222222222222222222222222222";
  assert.throws(() => validateObservation(value), (error) => error.code === "OBSERVATION_RELATIONSHIP_CONFLICT");
});
