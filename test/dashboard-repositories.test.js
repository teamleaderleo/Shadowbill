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

test("dashboard includes a same-origin repository allocation view", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-dashboard-repositories-"));
  const store = new JsonlEventStore(join(directory, "events.jsonl"));
  await store.append({
    type: "chat_turn", id: "chat_dashboard_repo", timestamp: "2026-07-25T18:00:00Z",
    conversationHash: "dashboard-repo", model: "gpt-5.6-sol", reasoningEffort: "high",
    visibleInputTokens: 10_000, visibleOutputTokens: 2_000,
  });
  await store.append({
    type: "git_commit", id: "commit_dashboard_repo", timestamp: "2026-07-25T19:00:00Z",
    repository: "org/dashboard", branch: "main", sha: "abc", subject: "Ship",
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
  const url = `http://127.0.0.1:${port}`;

  try {
    const htmlResponse = await fetch(`${url}/dashboard/`);
    const html = await htmlResponse.text();
    assert.equal(htmlResponse.status, 200);
    assert.equal(htmlResponse.headers.get("access-control-allow-origin"), null);
    assert.match(html, /id="repository-heading"/);
    assert.match(html, /id="allocated-cost"/);
    assert.match(html, /id="unallocated-cost"/);
    assert.match(html, /id="allocation-coverage"/);
    assert.match(html, /id="repository-rows"/);

    const scriptResponse = await fetch(`${url}/dashboard/dashboard.js`);
    const script = await scriptResponse.text();
    assert.equal(scriptResponse.status, 200);
    assert.match(script, /fetchReport\("repository"\)/);
    assert.match(script, /params\.set\("group", group\)/);
    assert.doesNotMatch(script, /fetch\(\s*["']https?:/i);

    const reportResponse = await fetch(`${url}/v1/report?date=2026-07-25&days=1&group=repository`);
    const report = await reportResponse.json();
    assert.equal(reportResponse.status, 200);
    assert.equal(report.repositoryCount, 1);
    assert.equal(report.repositories[0].repository, "org/dashboard");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
