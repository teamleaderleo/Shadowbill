import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mapGitHubWebhookObservation } from "../src/github-observation.js";
import { observationFingerprint, validateObservation } from "../src/observation.js";

const fixtures = async () => JSON.parse(await readFile(new URL("./fixtures/github-observations.json", import.meta.url), "utf8"));

function map(entry, overrides = {}) {
  return mapGitHubWebhookObservation(entry.eventName, entry.deliveryId, entry.payload, {
    signatureVerified: true,
    receivedAt: entry.receivedAt,
    ...overrides,
  });
}

function factValue(observation, name) {
  return observation.data.facts.find((fact) => fact.name === name)?.value;
}

function assertPrivateContentExcluded(observation) {
  const text = JSON.stringify(observation);
  assert.equal(/PRIVATE_[A-Z0-9_]+_SENTINEL/u.test(text), false);
  assert.equal(text.includes("private.example.test"), false);
  assert.equal(text.includes(".github/workflows/private-ci.yml"), false);
  assert.equal(text.includes("refs/heads/private/customer-fix"), false);
}

test("maps signed push and merged pull request deliveries", async () => {
  const data = await fixtures();
  const push = map(data.push, { retainedCodeTokens: 73 });
  const pullRequest = map(data.pullRequest, { retainedCodeTokens: 211 });

  for (const observation of [push, pullRequest]) {
    assert.equal(validateObservation(observation), observation);
    assert.equal(observation.data.adapter.trust, "signed-provider");
    assert.equal(observation.data.coverage.state, "partial");
    assert.equal(observation.data.coverage.redacted, true);
    assert.equal(observation.data.evidence.length, 1);
    assert.match(observation.data.evidence[0].digest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(observation.data.evidence[0].disclosure, "content-excluded");
    assertPrivateContentExcluded(observation);
  }

  assert.equal(push.id, "github-push-delivery-push-1");
  assert.equal(push.subject, `repo:owner/repo@sha:${"b".repeat(40)}`);
  assert.equal(push.data.kind, "verify");
  assert.equal(push.data.status, "passed");
  assert.deepEqual(push.data.relationships, { repository: "owner/repo", revision: "b".repeat(40) });
  assert.equal(factValue(push, "github.push.commit-count"), 2);
  assert.equal(factValue(push, "github.push.forced"), true);
  assert.equal(factValue(push, "proofwake.retained-code-tokens"), 73);

  assert.equal(pullRequest.id, "github-pull_request-delivery-pr-1");
  assert.equal(pullRequest.subject, `repo:owner/repo@sha:${"c".repeat(40)}`);
  assert.equal(pullRequest.data.status, "passed");
  assert.deepEqual(pullRequest.data.relationships, {
    repository: "owner/repo",
    revision: "c".repeat(40),
    correlations: ["github-pull-request-42"],
  });
  assert.equal(factValue(pullRequest, "github.pull-request.number"), 42);
  assert.equal(factValue(pullRequest, "github.pull-request.changed-files"), 5);
  assert.equal(factValue(pullRequest, "proofwake.retained-code-tokens"), 211);
});

test("maps workflow outcomes and preserves rerun lineage", async () => {
  const data = await fixtures();
  const success = map(data.workflowSuccess);
  const failure = map(data.workflowFailure);
  const cancelled = map(data.workflowCancelled);
  const rerun = map(data.workflowRerun);

  assert.equal(success.data.status, "passed");
  assert.equal(failure.data.status, "failed");
  assert.equal(cancelled.data.status, "cancelled");
  assert.equal(rerun.data.status, "passed");
  assert.equal(success.data.durationMs, 210_000);

  assert.equal(failure.data.relationships.run, "github-workflow-9002");
  assert.equal(failure.data.relationships.workflowAttempt, 1);
  assert.equal(rerun.data.relationships.run, "github-workflow-9002");
  assert.equal(rerun.data.relationships.workflowAttempt, 2);
  assert.equal(factValue(failure, "github.workflow.rerun"), false);
  assert.equal(factValue(rerun, "github.workflow.rerun"), true);
  assert.notEqual(failure.id, rerun.id);

  for (const observation of [success, failure, cancelled, rerun]) {
    assert.equal(validateObservation(observation), observation);
    assert.equal(observation.data.kind, "github-ci");
    assertPrivateContentExcluded(observation);
  }
});

test("maps successful and failed deployments without environments or URLs", async () => {
  const data = await fixtures();
  const success = map(data.deploymentSuccess);
  const failure = map(data.deploymentFailure);

  assert.equal(success.data.kind, "deployment");
  assert.equal(success.data.status, "passed");
  assert.equal(success.data.relationships.deployment, "github-deployment-777");
  assert.equal(success.data.relationships.revision, "c".repeat(40));
  assert.equal(failure.data.status, "failed");
  assert.equal(failure.data.relationships.deployment, "github-deployment-778");
  assert.equal(failure.data.relationships.revision, "d".repeat(40));
  assertPrivateContentExcluded(success);
  assertPrivateContentExcluded(failure);
});

test("maps published releases only when the payload identifies a full revision", async () => {
  const data = await fixtures();
  const release = map(data.release);
  assert.equal(validateObservation(release), release);
  assert.equal(release.type, "dev.proofwake.github.release-published.v1");
  assert.equal(release.data.kind, "verify");
  assert.equal(release.data.status, "passed");
  assert.equal(release.data.relationships.revision, "d".repeat(40));
  assert.deepEqual(release.data.relationships.correlations, ["github-release-501"]);
  assert.equal(factValue(release, "github.release.id"), 501);
  assert.equal(factValue(release, "github.release.prerelease"), false);
  assertPrivateContentExcluded(release);

  assert.equal(map(data.releaseWithoutRevisionAuthority), null);
  const unpublished = structuredClone(data.release);
  unpublished.payload.action = "edited";
  assert.equal(map(unpublished), null);
});

test("requires verified delivery authority and bounded exact identities", async () => {
  const data = await fixtures();
  assert.throws(
    () => mapGitHubWebhookObservation(data.push.eventName, data.push.deliveryId, data.push.payload, {
      signatureVerified: false,
      receivedAt: data.push.receivedAt,
    }),
    (error) => error?.code === "GITHUB_OBSERVATION_UNVERIFIED_DELIVERY",
  );
  assert.throws(
    () => mapGitHubWebhookObservation(data.push.eventName, "bad delivery id", data.push.payload, {
      signatureVerified: true,
      receivedAt: data.push.receivedAt,
    }),
    (error) => error?.code === "GITHUB_OBSERVATION_INVALID_DELIVERY",
  );

  const invalidRevision = structuredClone(data.workflowSuccess);
  invalidRevision.payload.workflow_run.head_sha = "abc123";
  assert.throws(
    () => map(invalidRevision),
    (error) => error?.code === "GITHUB_OBSERVATION_INVALID_REVISION",
  );
  assert.equal(mapGitHubWebhookObservation("ping", "delivery-ping", {}, {}), null);
});

test("delivery replay fingerprints ignore ingestion time and detect payload conflicts", async () => {
  const data = await fixtures();
  const first = map(data.push, { ingestedAt: "2026-07-25T17:00:06.000Z" });
  const replay = map(data.push, { ingestedAt: "2026-07-25T17:05:00.000Z" });
  assert.equal(observationFingerprint(first), observationFingerprint(replay));

  const changed = structuredClone(data.push);
  changed.payload.forced = false;
  const conflict = map(changed, { ingestedAt: "2026-07-25T17:05:00.000Z" });
  assert.notEqual(observationFingerprint(first), observationFingerprint(conflict));
});

test("unmerged pull requests remain outside this mapper slice", async () => {
  const data = await fixtures();
  const unmerged = structuredClone(data.pullRequest);
  unmerged.payload.pull_request.merged = false;
  assert.equal(map(unmerged), null);
});
