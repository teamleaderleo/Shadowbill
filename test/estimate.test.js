import assert from "node:assert/strict";
import test from "node:test";
import { buildDailyReport, estimateTurnCost } from "../src/estimate.js";

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

test("builds a daily report across chat and commit events", () => {
  const events = [
    turn,
    {
      type: "git_commit",
      id: "git_1",
      timestamp: "2026-07-25T13:00:00-07:00",
      repository: "owner/repo",
      branch: "main",
      sha: "123",
      subject: "Ship it",
      additions: 100,
      deletions: 20,
      changedFiles: 3,
      addedCodeTokens: 2_000,
    },
  ];

  const report = buildDailyReport(events, "2026-07-25", pricing);
  assert.equal(report.chatTurns, 1);
  assert.equal(report.commits, 1);
  assert.equal(report.addedCodeTokens, 2_000);
  assert.equal(report.deliveredCodeFloor, 0.06);
  assert.ok(report.workingEstimate > report.visibleUncachedEstimate);
});
