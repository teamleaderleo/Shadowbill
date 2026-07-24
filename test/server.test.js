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

function chatEvent() {
  return {
    type: "chat_turn",
    id: "chat_abcdef0123456789",
    timestamp: "2026-07-25T19:00:00Z",
    conversationHash: "abcdef0123456789abcdef01",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    visibleInputTokens: 25_000,
    visibleOutputTokens: 4_000,
    collectorVersion: "0.2.0",
    rawPrompt: "this field must never reach disk",
  };
}

test("browser events require authentication and persist only whitelisted fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-server-"));
  const store = new JsonlEventStore(join(directory, "events.jsonl"));
  const collectorToken = "collector-token-with-at-least-thirty-two-characters";
  const server = createCollectorServer({
    store,
    pricing,
    profile: DEFAULT_WORKING_PROFILE,
    timeZone: "America/Los_Angeles",
    collectorToken,
  });
  const port = await listen(server, 0);
  const url = `http://127.0.0.1:${port}`;

  try {
    const unauthorized = await fetch(`${url}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatEvent()),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal((await store.readAll()).length, 0);

    const authCheck = await fetch(`${url}/v1/auth/check`, {
      headers: { authorization: `Bearer ${collectorToken}` },
    });
    assert.equal(authCheck.status, 200);
    assert.deepEqual(await authCheck.json(), { authenticated: true });

    const send = () => fetch(`${url}/v1/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${collectorToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(chatEvent()),
    });

    const first = await send();
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { accepted: true, duplicate: false, id: chatEvent().id });

    const second = await send();
    assert.equal(second.status, 202);
    assert.deepEqual(await second.json(), { accepted: true, duplicate: true, id: chatEvent().id });

    const events = await store.readAll();
    assert.equal(events.length, 1);
    assert.equal(events[0].conversationHash, chatEvent().conversationHash);
    assert.equal("rawPrompt" in events[0], false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser event ingestion rejects unsupported event types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-server-type-"));
  const store = new JsonlEventStore(join(directory, "events.jsonl"));
  const collectorToken = "collector-token-with-at-least-thirty-two-characters";
  const server = createCollectorServer({
    store,
    pricing,
    profile: DEFAULT_WORKING_PROFILE,
    timeZone: "America/Los_Angeles",
    collectorToken,
  });
  const port = await listen(server, 0);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${collectorToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...chatEvent(), type: "git_commit" }),
    });
    assert.equal(response.status, 400);
    assert.equal((await store.readAll()).length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
