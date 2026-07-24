import assert from "node:assert/strict";
import test from "node:test";
import { buildRangeReport, calendarDateRange, shiftCalendarDate } from "../src/range.js";

const pricing = {
  inputPerMillion: 5,
  cachedInputPerMillion: 0.5,
  cacheWritePerMillion: 6.25,
  outputPerMillion: 30,
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
};

function chat(id, timestamp, conversationHash, outputTokens) {
  return {
    type: "chat_turn",
    id,
    timestamp,
    conversationHash,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    visibleInputTokens: 10_000,
    visibleOutputTokens: outputTokens,
  };
}

test("calendar ranges cross month and daylight-saving boundaries as calendar dates", () => {
  assert.equal(shiftCalendarDate("2026-02-28", 1), "2026-03-01");
  assert.equal(shiftCalendarDate("2026-03-08", 1), "2026-03-09");
  assert.deepEqual(calendarDateRange("2026-03-10", 5), [
    "2026-03-06",
    "2026-03-07",
    "2026-03-08",
    "2026-03-09",
    "2026-03-10",
  ]);
  assert.throws(() => calendarDateRange("2026-02-30", 7), /real calendar date/);
  assert.throws(() => calendarDateRange("2026-03-10", 366), /between 1 and 365/);
});

test("range reports aggregate daily usage and deduplicate cross-day outcomes", () => {
  const events = [
    chat("chat_1", "2026-03-07T20:00:00-08:00", "conversation-a", 1_000),
    chat("chat_2", "2026-03-08T20:00:00-07:00", "conversation-b", 4_000),
    {
      type: "git_commit", id: "git_1", timestamp: "2026-03-08T12:00:00-07:00",
      repository: "owner/repo", branch: "main", sha: "abc", subject: "Ship",
      additions: 100, deletions: 20, changedFiles: 2, addedCodeTokens: 2_000,
    },
    {
      type: "github_pull_request", id: "pr_1", timestamp: "2026-03-08T23:59:00-07:00",
      repository: "owner/repo", action: "closed", number: 7, state: "closed", merged: true, draft: false,
      headSha: "abc", baseSha: "base", mergeCommitSha: "merge", additions: 100, deletions: 20, changedFiles: 2, deliveryId: "pr-1",
    },
    {
      type: "github_workflow_run", id: "ci_running", timestamp: "2026-03-08T23:59:30-07:00",
      repository: "owner/repo", runId: 99, workflow: "CI", status: "in_progress", conclusion: null,
      headSha: "merge", runAttempt: 1, durationMs: null, deliveryId: "ci-1",
    },
    {
      type: "github_workflow_run", id: "ci_success", timestamp: "2026-03-09T00:02:00-07:00",
      repository: "owner/repo", runId: 99, workflow: "CI", status: "completed", conclusion: "success",
      headSha: "merge", runAttempt: 1, durationMs: 150_000, deliveryId: "ci-2",
    },
    {
      type: "github_deployment", id: "dep_running", timestamp: "2026-03-08T23:59:40-07:00",
      repository: "owner/repo", deploymentId: 5, state: "in_progress", environment: "production",
      sha: "merge", ref: "main", deliveryId: "dep-1",
    },
    {
      type: "github_deployment", id: "dep_success", timestamp: "2026-03-09T00:03:00-07:00",
      repository: "owner/repo", deploymentId: 5, state: "success", environment: "production",
      sha: "merge", ref: "main", deliveryId: "dep-2",
    },
  ];

  const report = buildRangeReport(events, "2026-03-10", 5, pricing, undefined, "America/Los_Angeles");
  assert.equal(report.startDate, "2026-03-06");
  assert.equal(report.endDate, "2026-03-10");
  assert.equal(report.calendarDays, 5);
  assert.equal(report.activeDays, 3);
  assert.equal(report.chatTurns, 2);
  assert.equal(report.conversations, 2);
  assert.equal(report.visibleOutputTokens, 5_000);
  assert.equal(report.commits, 1);
  assert.equal(report.mergedPullRequests, 1);
  assert.equal(report.workflowRunEvents, 2);
  assert.equal(report.workflowRuns, 1);
  assert.equal(report.successfulWorkflowRuns, 1);
  assert.equal(report.deploymentStatusEvents, 2);
  assert.equal(report.deployments, 1);
  assert.equal(report.successfulDeployments, 1);
  assert.equal(report.repositories, 1);
  assert.equal(report.addedCodeTokens, 2_000);
  assert.equal(report.costPerCommit, report.workingEstimate);
  assert.equal(report.costPerMergedPullRequest, report.workingEstimate);
  assert.equal(report.peakChatTurnDay.date, "2026-03-07");
  assert.equal(report.peakWorkingCostDay.date, "2026-03-08");
  assert.equal(report.daily.length, 5);
});
