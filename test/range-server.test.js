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

test("HTTP report endpoint returns rolling ranges and validates query parameters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-range-server-"));
  const store = new JsonlEventStore(join(directory, "events.jsonl"));
  await store.append({
    type: "chat_turn",
    id: "chat_seed",
    timestamp: "2026-03-08T20:00:00-07:00",
    conversationHash: "conversation-a",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    visibleInputTokens: 10_000,
    visibleOutputTokens: 2_000,
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
    const range = await fetch(`${base}?date=2026-03-10&days=5&timezone=America%2FLos_Angeles`);
    assert.equal(range.status, 200);
    const report = await range.json();
    assert.equal(report.startDate, "2026-03-06");
    assert.equal(report.endDate, "2026-03-10");
    assert.equal(report.calendarDays, 5);
    assert.equal(report.chatTurns, 1);

    const daily = await fetch(`${base}?date=2026-03-08&days=1&timezone=America%2FLos_Angeles`);
    assert.equal(daily.status, 200);
    assert.equal((await daily.json()).date, "2026-03-08");

    for (const query of [
      "date=2026-03-10&days=0",
      "date=2026-03-10&days=366",
      "date=2026-03-10&days=7days",
      "date=2026-02-30&days=7",
      "date=2026-03-10&days=7&timezone=Moon%2FBase",
    ]) {
      const invalid = await fetch(`${base}?${query}`);
      assert.equal(invalid.status, 400, query);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
