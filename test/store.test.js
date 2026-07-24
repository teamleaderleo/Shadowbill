import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlEventStore } from "../src/store.js";

const event = {
  type: "chat_turn",
  id: "chat_same",
  timestamp: "2026-07-25T12:00:00-07:00",
  conversationHash: "abc",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  visibleInputTokens: 100,
  visibleOutputTokens: 20,
};

test("deduplicates events by ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-store-"));
  try {
    const store = new JsonlEventStore(join(directory, "events.jsonl"));
    assert.equal(await store.append(event), true);
    assert.equal(await store.append(event), false);
    assert.equal((await store.readAll()).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
