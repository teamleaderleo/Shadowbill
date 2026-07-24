import assert from "node:assert/strict";
import test from "node:test";
import { buildDailyReport, estimateTurnCost, resolveChatTurnRevisions } from "../src/estimate.js";

const pricing = {
  inputPerMillion: 5,
  cachedInputPerMillion: 0.5,
  cacheWritePerMillion: 6.25,
  outputPerMillion: 30,
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
};

const turn = {
  type: "chat_turn",
  id: "turn_1",
  timestamp: "2026-07-25T12:00:00-07:00",
  conversationHash: "abc",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  visibleInputTokens: 100_000,
  visibleOutputTokens: 10_000,
};

test("estimates a blended turn", () => {
  const result = estimateTurnCost(turn, pricing, {
    name: "test",
    cachedReadFraction: 0.7,
    cacheWriteFraction: 0.1,
    billableOutputMultiplier: 2,
  });

  assert.equal(result.cachedReadTokens, 70_000);
  assert.equal(result.cacheWriteTokens, 10_000);
  assert.equal(result.uncachedInputTokens, 20_000);
  assert.equal(result.billableOutputTokens, 20_000);
  assert.equal(result.longContextPricingApplied, false);
  assert.ok(Math.abs(result.totalCost - 0.7975) < 1e-10);
});

test("applies long-context multipliers to the full request", () => {
  const result = estimateTurnCost({ ...turn, visibleInputTokens: 300_000 }, pricing, {
    name: "uncached",
    cachedReadFraction: 0,
    cacheWriteFraction: 0,
    billableOutputMultiplier: 1,
  });

  assert.equal(result.longContextPricingApplied, true);
  assert.equal(result.uncachedInputCost, 3);
  assert.ok(Math.abs(result.outputCost - 0.45) < 1e-10);
});

test("builds outcome metrics from chat, commit, and GitHub events", () => {
  const events = [
    turn,
    {
      type: "git_commit", id: "git_1", timestamp: "2026-07-25T13:00:00-07:00",
      repository: "owner/repo", branch: "main", sha: "123", subject: "Ship it",
      additions: 100, deletions: 20, changedFiles: 3, addedCodeTokens: 2_000,
    },
    {
      type: "github_push", id: "push_1", timestamp: "2026-07-25T14:00:00-07:00",
      repository: "owner/repo", ref: "refs/heads/main", branch: "main", before: "1", after: "2",
      commitCount: 1, created: false, deleted: false, forced: false, deliveryId: "1",
    },
    {
      type: "github_pull_request", id: "pr_1", timestamp: "2026-07-25T15:00:00-07:00",
      repository: "owner/repo", action: "closed", number: 1, state: "closed", merged: true, draft: false,
      headSha: "2", baseSha: "1", mergeCommitSha: "3", additions: 100, deletions: 20, changedFiles: 3, deliveryId: "2",
    },
    {
      type: "github_workflow_run", id: "ci_1", timestamp: "2026-07-25T16:00:00-07:00",
      repository: "owner/repo", runId: 1, workflow: "CI", status: "completed", conclusion: "success",
      headSha: "3", runAttempt: 1, durationMs: 1000, deliveryId: "3",
    },
    {
      type: "github_deployment", id: "dep_1", timestamp: "2026-07-25T17:00:00-07:00",
      repository: "owner/repo", deploymentId: 1, state: "success", environment: "production",
      sha: "3", ref: "main", deliveryId: "4",
    },
  ];

  const report = buildDailyReport(events, "2026-07-25", pricing, undefined, "America/Los_Angeles");
  assert.equal(report.chatTurns, 1);
  assert.equal(report.chatRevisionEvents, 1);
  assert.equal(report.supersededChatRevisions, 0);
  assert.equal(report.commits, 1);
  assert.equal(report.pushes, 1);
  assert.equal(report.mergedPullRequests, 1);
  assert.equal(report.successfulWorkflowRuns, 1);
  assert.equal(report.successfulDeployments, 1);
  assert.equal(report.addedCodeTokens, 2_000);
  assert.equal(report.deliveredCodeFloor, 0.06);
  assert.equal(report.costPerMergedPullRequest, report.workingEstimate);
  assert.equal(report.costPerSuccessfulWorkflowRun, report.workingEstimate);
  assert.equal(report.costPerSuccessfulDeployment, report.workingEstimate);
  assert.ok(report.workingEstimate > report.visibleUncachedEstimate);
});

test("uses the latest capture while retaining the first turn day", () => {
  const first = {
    ...turn,
    id: "chat_111111111111111111111111",
    timestamp: "2026-07-25T23:58:00-07:00",
    capturedAt: "2026-07-26T06:58:05.000Z",
    logicalTurnHash: "aaaaaaaaaaaaaaaaaaaaaaaa",
    visibleOutputTokens: 2_000,
  };
  const revision = {
    ...first,
    id: "chat_222222222222222222222222",
    timestamp: "2026-07-26T00:03:00-07:00",
    capturedAt: "2026-07-26T07:03:05.000Z",
    visibleOutputTokens: 8_000,
  };

  const resolved = resolveChatTurnRevisions([first, revision]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].revisionCount, 2);
  assert.equal(resolved[0].turn.id, revision.id);
  assert.equal(resolved[0].turn.visibleOutputTokens, 8_000);
  assert.equal(resolved[0].turn.timestamp, "2026-07-26T06:58:00.000Z");

  const firstDay = buildDailyReport([first, revision], "2026-07-25", pricing, undefined, "America/Los_Angeles");
  assert.equal(firstDay.chatTurns, 1);
  assert.equal(firstDay.chatRevisionEvents, 2);
  assert.equal(firstDay.supersededChatRevisions, 1);
  assert.equal(firstDay.visibleOutputTokens, 8_000);

  const secondDay = buildDailyReport([first, revision], "2026-07-26", pricing, undefined, "America/Los_Angeles");
  assert.equal(secondDay.chatTurns, 0);
  assert.equal(secondDay.chatRevisionEvents, 0);
});
