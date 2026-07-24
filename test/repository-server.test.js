import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_WORKING_PROFILE } from "../src/estimate.js";
import { createCollectorServer, listen } from "../src/server.js";
import { JsonlEventStore } from "../src/store.js";

const pricing = {
  inputPerMillion: 5,
  cachedInputPerMillion: 0.5,
  cacheWritePerMillion: 6.25,
  outputPerMillion: 30,
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
};

test("HTTP reports expose repository allocation and reject unknown groups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-repository-server-"));
  const store = new JsonlEventStore(join(directory, "events.jsonl"));
  await store.append({
    type: "chat_turn", id: "chat_repo", timestamp: "2026-07-25T18:00:00Z",
    conversationHash: "conversation-repo", model: "gpt-5.6-sol", reasoningEffort: "high",
    visibleInputTokens: 10_000, visibleOutputTokens: 2_000,
  });
  await store.append({
    type: "git_commit", id: "commit_repo", timestamp: "2026-07-25T19:00:00Z",
    repository: "org/repo", branch: "main", sha: "abc", subject: "Ship",
    additions: 100, deletions: 10, changedFiles: 2, addedCodeTokens: 250,
  });

  const server = createCollectorServer({
    store,
    pricing,
    profile: DEFAULT_WORKING_PROFILE,
    timeZone: "America/Los_Angeles",
    collectorToken: "collector-token-with-at-least-thirty-two-characters",
  });
  const port = await listen(server, 0);
  const base = `http://127.0.0.1:${port}/v1/report`;

  try {
    const response = await fetch(`${base}?date=2026-07-25&days=1&group=repository`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const report = await response.json();
    assert.equal(report.allocationBasis, "same-day-added-code-tokens");
    assert.equal(report.repositoryCount, 1);
    assert.equal(report.repositories[0].repository, "org/repo");
    assert.equal(report.allocatedWorkingEstimate, report.workingEstimate);
    assert.equal(report.unallocatedWorkingEstimate, 0);

    const invalid = await fetch(`${base}?date=2026-07-25&days=1&group=conversation`);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "group must be repository when provided" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
