import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateRepositoryPolicy } from "../src/repository-policy.js";

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/repository-policies/${name}.json`, import.meta.url), "utf8"));
}

test("pilot policies declare applicability for every expected signal", async () => {
  for (const name of ["proofwake", "renderprove", "smolrunner", "stensibly", "one-more-legend"]) {
    const policy = validateRepositoryPolicy(await fixture(name));
    assert.ok(policy.signals.every((signal) => typeof signal.appliesTo === "string"), name);
  }
});

test("revision signals accept revision applicability modes", async () => {
  const policy = await fixture("proofwake");
  for (const appliesTo of ["every-revision", "default-branch", "deployed-revision", "release"]) {
    const normalized = validateRepositoryPolicy({
      ...policy,
      signals: [{ ...policy.signals[0], appliesTo }],
    });
    assert.equal(normalized.signals[0].appliesTo, appliesTo);
  }
});

test("applicability must match the signal subject", async () => {
  const policy = await fixture("proofwake");
  assert.throws(
    () => validateRepositoryPolicy({
      ...policy,
      signals: [{ ...policy.signals[0], appliesTo: "service" }],
    }),
    (error) => error.code === "REPOSITORY_POLICY_APPLICABILITY_CONFLICT" && error.path.endsWith(".appliesTo"),
  );
  assert.throws(
    () => validateRepositoryPolicy({
      ...policy,
      signals: [{
        ...policy.signals[2],
        subject: "host",
        appliesTo: "repository",
      }],
    }),
    (error) => error.code === "REPOSITORY_POLICY_APPLICABILITY_CONFLICT",
  );
});

test("Renderprove policy preserves its optional pinned renderer probe as domain-check", async () => {
  const policy = validateRepositoryPolicy(await fixture("renderprove"));
  const probe = policy.signals.find((signal) => signal.kind === "domain-check");
  assert.deepEqual(probe, {
    kind: "domain-check",
    requirement: "optional",
    subject: "revision",
    appliesTo: "every-revision",
    freshness: { mode: "revision" },
    acceptedSources: ["local-command"],
  });
});
