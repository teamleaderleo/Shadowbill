import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  REPOSITORY_POLICY_SCHEMA,
  repositoryPolicyFingerprint,
  validateRepositoryPolicy,
} from "../src/repository-policy.js";

const FIXTURES = [
  "proofwake",
  "renderprove",
  "smolrunner",
  "stensibly",
  "one-more-legend",
];

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/repository-policies/${name}.json`, import.meta.url), "utf8"));
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reverseKeys(nested)]));
  }
  return value;
}

test("five pilot repository policies validate and have stable fingerprints", async () => {
  const policies = await Promise.all(FIXTURES.map(fixture));
  const identities = new Set();
  for (const policy of policies) {
    const normalized = validateRepositoryPolicy(policy);
    assert.equal(normalized.version, 1);
    assert.equal(normalized.lifecycle.state, "active");
    assert.ok(normalized.signals.some((signal) => signal.requirement === "required"));
    assert.match(repositoryPolicyFingerprint(policy), /^sha256:[a-f0-9]{64}$/);
    assert.equal(repositoryPolicyFingerprint(policy), repositoryPolicyFingerprint(reverseKeys(policy)));
    identities.add(normalized.repository.id);
  }
  assert.equal(identities.size, 5);
});

test("remote and local repository identities remain mutually exclusive", async () => {
  const policy = await fixture("proofwake");
  assert.throws(
    () => validateRepositoryPolicy({
      ...policy,
      repository: { ...policy.repository, localId: `sha256:${"a".repeat(64)}` },
    }),
    (error) => error.code === "REPOSITORY_POLICY_IDENTITY_CONFLICT",
  );

  const local = validateRepositoryPolicy({
    version: 1,
    repository: {
      kind: "local",
      localId: `sha256:${"b".repeat(64)}`,
      displayName: "private-experiment",
    },
    lifecycle: { state: "dormant" },
    signals: [],
    adapters: [],
  });
  assert.deepEqual(local.repository, {
    kind: "local",
    localId: `sha256:${"b".repeat(64)}`,
    displayName: "private-experiment",
  });
});

test("signal kinds, sources, and adapter names must be unique and resolved", async () => {
  const policy = await fixture("renderprove");
  assert.throws(
    () => validateRepositoryPolicy({ ...policy, signals: [...policy.signals, policy.signals[0]] }),
    (error) => error.code === "REPOSITORY_POLICY_DUPLICATE_VALUE" && error.path.endsWith(".kind"),
  );
  assert.throws(
    () => validateRepositoryPolicy({
      ...policy,
      signals: [{
        ...policy.signals[0],
        acceptedSources: ["local-command", "local-command"],
      }],
    }),
    (error) => error.code === "REPOSITORY_POLICY_DUPLICATE_VALUE" && error.path.includes("acceptedSources"),
  );
  assert.throws(
    () => validateRepositoryPolicy({ ...policy, adapters: [] }),
    (error) => error.code === "REPOSITORY_POLICY_ADAPTER_MISSING",
  );
  assert.throws(
    () => validateRepositoryPolicy({ ...policy, adapters: [...policy.adapters, policy.adapters[0]] }),
    (error) => error.code === "REPOSITORY_POLICY_DUPLICATE_VALUE" && error.path.endsWith(".name"),
  );
});

test("receipt adapters reject path escape, absolute paths, globs, and backslashes", async () => {
  const policy = await fixture("renderprove");
  for (const path of [
    "../private.json",
    "/tmp/receipt.json",
    "C:/private/receipt.json",
    ".proofwake//receipt.json",
    ".proofwake/*.json",
    ".proofwake\\receipt.json",
  ]) {
    assert.throws(
      () => validateRepositoryPolicy({
        ...policy,
        adapters: [{ ...policy.adapters[0], path }],
      }),
      (error) => error.code === "REPOSITORY_POLICY_PATH_ESCAPE" && error.path.endsWith(".path"),
      path,
    );
  }
});

test("lifecycle and freshness contradictions fail closed", async () => {
  const policy = await fixture("proofwake");
  assert.throws(
    () => validateRepositoryPolicy({ ...policy, lifecycle: { state: "dormant" } }),
    (error) => error.code === "REPOSITORY_POLICY_LIFECYCLE_CONFLICT",
  );
  assert.throws(
    () => validateRepositoryPolicy({
      ...policy,
      signals: [{
        ...policy.signals[0],
        freshness: { mode: "duration", hours: 24 },
      }],
    }),
    (error) => error.code === "REPOSITORY_POLICY_FRESHNESS_CONFLICT",
  );
  assert.throws(
    () => validateRepositoryPolicy({
      ...policy,
      signals: [{
        ...policy.signals[0],
        subject: "repository",
        freshness: { mode: "revision" },
      }],
    }),
    (error) => error.code === "REPOSITORY_POLICY_FRESHNESS_CONFLICT",
  );
  assert.throws(
    () => validateRepositoryPolicy({
      ...policy,
      signals: [{
        ...policy.signals[0],
        freshness: { mode: "none" },
      }],
    }),
    (error) => error.code === "REPOSITORY_POLICY_FRESHNESS_CONFLICT",
  );
});

test("unknown fields and unsupported versions fail with stable paths", async () => {
  const policy = await fixture("proofwake");
  assert.throws(
    () => validateRepositoryPolicy({ ...policy, commands: ["npm test"] }),
    (error) => error.code === "REPOSITORY_POLICY_UNKNOWN_FIELD" && error.path === "$.commands",
  );
  assert.throws(
    () => validateRepositoryPolicy({ ...policy, version: 2 }),
    (error) => error.code === "REPOSITORY_POLICY_INVALID_VERSION" && error.path === "$.version",
  );
});

test("published schema identifies repository policy v1 and fails closed", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/repository-policy-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$id, REPOSITORY_POLICY_SCHEMA);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.version.const, 1);
  assert.equal(schema.properties.signals.maxItems, 32);
  assert.equal(schema.properties.adapters.maxItems, 16);
  assert.ok(schema.$defs.repository.oneOf.every((variant) => variant.additionalProperties === false));
  assert.ok(schema.$defs.freshness.oneOf.every((variant) => variant.additionalProperties === false));
  assert.equal(schema.$defs.signal.additionalProperties, false);
  assert.equal(schema.$defs.adapter.additionalProperties, false);
});
