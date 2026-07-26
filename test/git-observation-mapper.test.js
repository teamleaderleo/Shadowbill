import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mapGitCommitObservation } from "../src/git-observation.js";
import { observationFingerprint, validateObservation } from "../src/observation.js";

const fixture = async () => JSON.parse(await readFile(new URL("./fixtures/git-observation.json", import.meta.url), "utf8"));

function factValue(observation, name) {
  return observation.data.facts.find((fact) => fact.name === name)?.value;
}

test("maps a local Git commit into a valid content-minimised observation", async () => {
  const input = await fixture();
  const observation = mapGitCommitObservation(input, {
    observedAt: "2026-07-25T17:00:02.000Z",
    ingestedAt: "2026-07-25T17:00:03.000Z",
  });

  assert.equal(validateObservation(observation), observation);
  assert.equal(observation.id, `git-commit-${input.sha}`);
  assert.equal(observation.source, "urn:proofwake:adapter:git");
  assert.equal(observation.type, "dev.proofwake.git.commit.v1");
  assert.equal(observation.subject, `repo:owner/repo@sha:${input.sha}`);
  assert.equal(observation.time, "2026-07-25T17:00:00.000Z");
  assert.equal(observation.data.adapter.trust, "local-operator");
  assert.equal(observation.data.kind, "verify");
  assert.equal(observation.data.status, "passed");
  assert.deepEqual(observation.data.relationships, { repository: "owner/repo", revision: input.sha });
  assert.equal(factValue(observation, "git.commit.additions"), 12);
  assert.equal(factValue(observation, "git.commit.deletions"), 3);
  assert.equal(factValue(observation, "git.commit.changed-files"), 2);
  assert.equal(factValue(observation, "proofwake.retained-code-tokens"), 41);
  assert.equal(observation.data.coverage.state, "partial");
  assert.equal(observation.data.coverage.redacted, true);

  const text = JSON.stringify(observation);
  for (const excluded of [
    "PRIVATE_COMMIT_SUBJECT_SENTINEL",
    "PRIVATE_COMMIT_BODY_SENTINEL",
    "PRIVATE_PATCH_SENTINEL",
    "private/customer/account.js",
    "private/customer-fix",
    "PRIVATE_CREDENTIAL_SENTINEL",
  ]) {
    assert.equal(text.includes(excluded), false, `excluded Git content leaked: ${excluded}`);
  }
});

test("Git mapping is deterministic apart from ingestion time", async () => {
  const input = await fixture();
  const first = mapGitCommitObservation(input, {
    observedAt: "2026-07-25T17:00:02.000Z",
    ingestedAt: "2026-07-25T17:00:03.000Z",
  });
  const replay = mapGitCommitObservation(input, {
    observedAt: "2026-07-25T17:00:02.000Z",
    ingestedAt: "2026-07-25T17:05:00.000Z",
  });
  assert.equal(observationFingerprint(first), observationFingerprint(replay));
});

test("Git mapping rejects ambiguous identity and invalid counts with stable codes", async () => {
  const input = await fixture();
  const cases = [
    [{ ...input, repository: "repo-only" }, "GIT_OBSERVATION_INVALID_REPOSITORY"],
    [{ ...input, sha: "abc123" }, "GIT_OBSERVATION_INVALID_REVISION"],
    [{ ...input, additions: -1 }, "GIT_OBSERVATION_INVALID_COUNT"],
    [{ ...input, addedCodeTokens: -1 }, "GIT_OBSERVATION_INVALID_RETAINED_CODE"],
  ];

  for (const [value, code] of cases) {
    assert.throws(
      () => mapGitCommitObservation(value),
      (error) => error?.code === code && !String(error.stack ?? "").includes("PRIVATE_"),
    );
  }
});
