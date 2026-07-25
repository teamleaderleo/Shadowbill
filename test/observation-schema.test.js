import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaUrl = new URL("../schema/observation-v1.schema.json", import.meta.url);
const fixtureUrl = new URL("./fixtures/observation-valid.json", import.meta.url);

async function json(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

test("published schema and valid fixture share the v1 contract identifiers", async () => {
  const [schema, fixture] = await Promise.all([json(schemaUrl), json(fixtureUrl)]);
  assert.equal(schema.$id, "urn:proofwake:schema:observation:1");
  assert.equal(fixture.specversion, schema.properties.specversion.const);
  assert.equal(fixture.dataschema, schema.properties.dataschema.const);
  assert.equal(fixture.datacontenttype, schema.properties.datacontenttype.const);
  assert.equal(fixture.data.schemaVersion, schema.$defs.data.properties.schemaVersion.const);
});

test("published schema fails closed at every extensible object boundary", async () => {
  const schema = await json(schemaUrl);
  assert.equal(schema.additionalProperties, false);
  for (const definition of ["adapter", "repository", "revision", "eventReference", "relationships", "producer", "evidence", "attributes", "data"]) {
    const value = schema.$defs[definition];
    if (definition === "repository") {
      assert.ok(value.oneOf.every((variant) => variant.additionalProperties === false));
    } else {
      assert.equal(value.additionalProperties, false, definition);
    }
  }
});

test("schema publishes the same trust, status, and privacy vocabulary", async () => {
  const schema = await json(schemaUrl);
  assert.deepEqual(schema.$defs.adapter.properties.trust.enum, [
    "local-operator",
    "signed-provider",
    "verified-receipt",
    "authenticated-client",
    "untrusted-observation",
  ]);
  assert.deepEqual(schema.$defs.data.properties.status.enum, [
    "started",
    "passed",
    "failed",
    "cancelled",
    "timed_out",
    "skipped",
    "unknown",
  ]);
  assert.deepEqual(schema.$defs.evidence.properties.disclosure.enum, [
    "public-metadata",
    "private-metadata",
    "restricted-reference",
    "content-excluded",
  ]);
});
