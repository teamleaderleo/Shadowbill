import assert from "node:assert/strict";
import test from "node:test";
import { buildRepositoryAllocationReport } from "../src/repositories.js";

const pricing = {
  inputPerMillion: 5,
  cachedInputPerMillion: 0.5,
  cacheWritePerMillion: 6.25,
  outputPerMillion: 30,
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
};

function chat(id, timestamp, output = 1_000) {
  return {
    type: "chat_turn", id, timestamp, conversationHash: id,
    model: "gpt-5.6-sol", reasoningEffort: "high",
    visibleInputTokens: 10_000, visibleOutputTokens: output,
  };
}

function commit(id, timestamp, repository, tokens) {
  return {
    type: "git_commit", id, timestamp, repository, branch: "main", sha: id,
    subject: "Ship", additions: tokens, deletions: 10, changedFiles: 2, addedCodeTokens: tokens,
  };
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

function repo(report, name) {
  return report.repositories.find((entry) => entry.repository === name);
}

test("allocates each day by retained code tokens and leaves other days unallocated", () => {
  const events = [
    chat("chat-one", "2026-07-24T20:00:00Z"),
    chat("chat-two", "2026-07-25T20:00:00Z", 2_000),
    commit("a", "2026-07-24T21:00:00Z", "org/alpha", 100),
    commit("b", "2026-07-24T22:00:00Z", "org/beta", 300),
    {
      type: "github_pull_request", id: "pr1", timestamp: "2026-07-24T23:00:00Z",
      repository: "org/alpha", action: "closed", number: 7, state: "closed", merged: true,
      draft: false, headSha: "h", baseSha: "b", mergeCommitSha: "m",
      additions: 1, deletions: 0, changedFiles: 1, deliveryId: "pr1",
    },
    {
      type: "github_pull_request", id: "pr2", timestamp: "2026-07-25T00:00:00Z",
      repository: "org/alpha", action: "closed", number: 7, state: "closed", merged: true,
      draft: false, headSha: "h", baseSha: "b", mergeCommitSha: "m",
      additions: 1, deletions: 0, changedFiles: 1, deliveryId: "pr2",
    },
    {
      type: "github_workflow_run", id: "ci1", timestamp: "2026-07-24T23:10:00Z",
      repository: "org/alpha", runId: 9, workflow: "CI", status: "in_progress",
      conclusion: null, headSha: "m", runAttempt: 1, durationMs: null, deliveryId: "ci1",
    },
    {
      type: "github_workflow_run", id: "ci2", timestamp: "2026-07-25T00:10:00Z",
      repository: "org/alpha", runId: 9, workflow: "CI", status: "completed",
      conclusion: "success", headSha: "m", runAttempt: 1, durationMs: 10, deliveryId: "ci2",
    },
  ];

  const report = buildRepositoryAllocationReport(events, "2026-07-25", 2, pricing, undefined, "America/Los_Angeles");
  const alpha = repo(report, "org/alpha");
  const beta = repo(report, "org/beta");

  assert.equal(report.allocationBasis, "same-day-added-code-tokens");
  assert.equal(report.allocationDays, 1);
  assert.equal(report.unallocatedDays, 1);
  close(report.allocatedWorkingEstimate, report.daily[0].workingEstimate);
  close(report.unallocatedWorkingEstimate, report.daily[1].workingEstimate);
  close(alpha.allocatedWorkingEstimate, report.daily[0].workingEstimate * 0.25);
  close(beta.allocatedWorkingEstimate, report.daily[0].workingEstimate * 0.75);
  assert.equal(alpha.mergedPullRequests, 1);
  assert.equal(alpha.workflowRunEvents, 2);
  assert.equal(alpha.workflowRuns, 1);
  assert.equal(alpha.successfulWorkflowRuns, 1);
});

test("uses the selected timezone at day boundaries", () => {
  const events = [
    chat("night-chat", "2026-07-25T06:30:00Z"),
    commit("night-code", "2026-07-25T06:45:00Z", "org/night", 250),
  ];
  const pacific = buildRepositoryAllocationReport(events, "2026-07-24", 1, pricing, undefined, "America/Los_Angeles");
  const utc = buildRepositoryAllocationReport(events, "2026-07-24", 1, pricing, undefined, "UTC");
  close(pacific.allocatedWorkingEstimate, pacific.workingEstimate);
  assert.equal(pacific.repositories[0].repository, "org/night");
  assert.equal(utc.repositoryCount, 0);
  assert.equal(utc.workingEstimate, 0);
});

test("uses null coverage when no estimated cost exists", () => {
  const report = buildRepositoryAllocationReport(
    [commit("only-code", "2026-07-25T12:00:00Z", "org/code", 100)],
    "2026-07-25", 1, pricing, undefined, "UTC",
  );
  assert.equal(report.workingEstimate, 0);
  assert.equal(report.allocationCoverage, null);
  assert.equal(report.repositories[0].costPerCommit, 0);
  assert.equal(report.repositories[0].addedCodeTokensPerAllocatedDollar, null);
});
