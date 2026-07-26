import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateRepositoryPolicy } from "../src/repository-policy.js";

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/repository-policies/${name}.json`, import.meta.url), "utf8"));
}

function dormantPolicy(repository) {
  return {
    version: 1,
    repository,
    lifecycle: { state: "dormant" },
    signals: [],
    adapters: [],
  };
}

test("repository identity variants report missing fields with stable paths", () => {
  assert.throws(
    () => validateRepositoryPolicy(dormantPolicy({ kind: "remote" })),
    (error) => error.code === "REPOSITORY_POLICY_MISSING_FIELD" && error.path === "$.repository.id",
  );
  assert.throws(
    () => validateRepositoryPolicy(dormantPolicy({ kind: "remote", id: "team/repo" })),
    (error) => error.code === "REPOSITORY_POLICY_MISSING_FIELD" && error.path === "$.repository.provider",
  );
  assert.throws(
    () => validateRepositoryPolicy(dormantPolicy({ kind: "local" })),
    (error) => error.code === "REPOSITORY_POLICY_MISSING_FIELD" && error.path === "$.repository.localId",
  );
  assert.throws(
    () => validateRepositoryPolicy(dormantPolicy({ kind: "local", localId: `sha256:${"a".repeat(64)}` })),
    (error) => error.code === "REPOSITORY_POLICY_MISSING_FIELD" && error.path === "$.repository.displayName",
  );
});

test("adapter schema identifiers reject local paths, credentials, and invalid URI syntax", async () => {
  const policy = await fixture("renderprove");
  for (const schema of [
    "file:///home/operator/private/schema.json",
    "https://operator:secret@example.com/schema.json",
    "http://example.com/schema.json",
    "https://schemas.example.com/schema file.json",
    "urn:",
  ]) {
    assert.throws(
      () => validateRepositoryPolicy({
        ...policy,
        adapters: [{ ...policy.adapters[0], schema }],
      }),
      (error) => error.code === "REPOSITORY_POLICY_INVALID_VALUE" && error.path === "$.adapters[0].schema",
      schema,
    );
  }
});

test("adapter schema identifiers accept stable tokens, HTTPS URLs, and URNs", async () => {
  const policy = await fixture("renderprove");
  for (const schema of [
    "renderprove.receipt.v1",
    "https://schemas.example.com/renderprove/receipt-v1.json",
    "urn:renderprove:schema:receipt:v1",
  ]) {
    const normalized = validateRepositoryPolicy({
      ...policy,
      adapters: [{ ...policy.adapters[0], schema }],
    });
    assert.equal(normalized.adapters[0].schema, schema);
  }

  const normalizedHttps = validateRepositoryPolicy({
    ...policy,
    adapters: [{ ...policy.adapters[0], schema: "HTTPS://Schemas.Example.com/renderprove/receipt-v1.json" }],
  });
  assert.equal(normalizedHttps.adapters[0].schema, "https://schemas.example.com/renderprove/receipt-v1.json");

  const normalizedUrn = validateRepositoryPolicy({
    ...policy,
    adapters: [{ ...policy.adapters[0], schema: "URN:renderprove:schema:receipt:v1" }],
  });
  assert.equal(normalizedUrn.adapters[0].schema, "urn:renderprove:schema:receipt:v1");
});

test("published schema mirrors the runtime URI allowlist", async () => {
  const published = JSON.parse(await readFile(new URL("../schema/repository-policy-v1.schema.json", import.meta.url), "utf8"));
  const schemaRule = published.$defs.adapter.properties.schema;
  assert.equal(schemaRule.oneOf[0].$ref, "#/$defs/slug");

  const uriPattern = new RegExp(schemaRule.oneOf[1].pattern, "u");
  assert.match("https://schemas.example.com/receipt-v1.json", uriPattern);
  assert.match("urn:renderprove:schema:receipt:v1", uriPattern);
  assert.match("HTTPS://Schemas.Example.com/receipt-v1.json", uriPattern);
  assert.match("URN:renderprove:schema:receipt:v1", uriPattern);
  assert.doesNotMatch("file:///home/operator/private/schema.json", uriPattern);
  assert.doesNotMatch("http://example.com/schema.json", uriPattern);
  assert.doesNotMatch("https://operator:secret@example.com/schema.json", uriPattern);
  assert.doesNotMatch("https://schemas.example.com/schema file.json", uriPattern);
  assert.doesNotMatch("urn:", uriPattern);
});
