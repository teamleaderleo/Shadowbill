import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVITY_OBSERVATION_TYPES } from "../src/activity-view.js";
import { buildDailyReport } from "../src/estimate.js";
import { buildRepositoryAllocationReport } from "../src/repositories.js";

const REVISION = "a".repeat(40);
const pricing = {
  inputPerMillion: 5,
  cachedInputPerMillion: 0.5,
  cacheWritePerMillion: 6.25,
  outputPerMillion: 30,
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
};

function observationRecord({ id, type, kind, status = "passed", facts, relationships = {} }) {
  const repository = "acme/repo";
  return {
    type: "proofwake_observation",
    id: `record-${id}`,
    timestamp: "2026-07-26T13:00:01.000Z",
    observation: {
      specversion: "1.0",
      id,
      source: type.includes("github") ? "https://api.github.com/hooks/proofwake" : "urn:proofwake:adapter:git",
      type,
      subject: `repo:${repository}@sha:${REVISION}`,
      time: "2026-07-26T13:00:00.000Z",
      dataschema: "urn:proofwake:schema:observation:v1",
      data: {
        schemaVersion: 1,
        adapter: {
          name: type.includes("github") ? "github" : "git",
          version: "1.0.0",
          mappingVersion: 1,
          trust: type.includes("github") ? "signed-provider" : "local-operator",
          sourceSchema: "activity.test",
          sourceSchemaVersion: "1",
        },
        kind,
        status,
        timeSource: type.includes("github") ? "provider" : "adapter",
        observedAt: "2026-07-26T13:00:00.000Z",
        ingestedAt: "2026-07-26T13:00:01.000Z",
        relationships: { repository, revision: REVISION, ...relationships },
        facts: facts.map(([name, value]) => ({ name, value })),
        evidence: [],
        coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
      },
    },
  };
}

test("daily and repository reports count legacy-plus-observation activity once", () => {
  const chat = {
    type: "chat_turn",
    id: "chat",
    timestamp: "2026-07-26T12:00:00.000Z",
    conversationHash: "conversation",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    visibleInputTokens: 10_000,
    visibleOutputTokens: 1_000,
  };
  const legacyCommit = {
    type: "git_commit",
    id: "legacy-commit",
    timestamp: "2026-07-26T13:00:00.000Z",
    repository: "acme/repo",
    branch: "main",
    sha: REVISION,
    subject: "private commit subject",
    additions: 100,
    deletions: 20,
    changedFiles: 3,
    addedCodeTokens: 500,
  };
  const commitObservation = observationRecord({
    id: "local-commit",
    type: ACTIVITY_OBSERVATION_TYPES.gitCommit,
    kind: "verify",
    facts: [
      ["git.additions", 100],
      ["git.deletions", 20],
      ["git.changed-files", 3],
      ["git.added-code-tokens", 500],
    ],
  });
  const legacyWorkflow = {
    type: "github_workflow_run",
    id: "legacy-workflow",
    timestamp: "2026-07-26T13:00:00.000Z",
    repository: "acme/repo",
    runId: 9,
    workflow: "private workflow name",
    status: "completed",
    conclusion: "success",
    headSha: REVISION,
    runAttempt: 2,
    durationMs: 1000,
    deliveryId: "workflow-delivery",
  };
  const workflowObservation = observationRecord({
    id: "workflow-delivery",
    type: ACTIVITY_OBSERVATION_TYPES.githubWorkflowRun,
    kind: "github-ci",
    relationships: { workflowAttempt: 2 },
    facts: [
      ["github.workflow-run.id", 9],
      ["github.workflow-run.head-sha", REVISION],
      ["github.workflow-run.duration-ms", 1000],
    ],
  });
  const events = [chat, legacyCommit, commitObservation, legacyWorkflow, workflowObservation];

  const daily = buildDailyReport(events, "2026-07-26", pricing, undefined, "UTC");
  assert.equal(daily.commits, 1);
  assert.equal(daily.workflowRunEvents, 1);
  assert.equal(daily.workflowRuns, 1);
  assert.equal(daily.successfulWorkflowRuns, 1);
  assert.equal(daily.addedCodeTokens, 500);

  const allocation = buildRepositoryAllocationReport(events, "2026-07-26", 1, pricing, undefined, "UTC");
  assert.equal(allocation.repositoryCount, 1);
  assert.equal(allocation.repositories[0].commits, 1);
  assert.equal(allocation.repositories[0].workflowRunEvents, 1);
  assert.equal(allocation.repositories[0].workflowRuns, 1);
  assert.equal(allocation.repositories[0].successfulWorkflowRuns, 1);
  assert.equal(allocation.repositories[0].addedCodeTokens, 500);
  assert.equal(JSON.stringify(allocation).includes("private workflow name"), false);
  assert.equal(JSON.stringify(allocation).includes("private commit subject"), false);
});
