import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadTracker() {
  const source = await readFile(new URL("../extension/turn-tracker.js", import.meta.url), "utf8");
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: "turn-tracker.js" });
  return context.ShadowbillTurnTracker;
}

test("completion rules favor definitive following messages", async () => {
  const tracker = await loadTracker();
  assert.equal(tracker.shouldEmit({
    hasFollowingMessage: true,
    hasCompletionControls: false,
    isGenerating: true,
    quietForMs: 0,
  }), true);
});

test("completion rules wait during generation and accept stable completed output", async () => {
  const tracker = await loadTracker();
  assert.equal(tracker.shouldEmit({
    hasFollowingMessage: false,
    hasCompletionControls: true,
    isGenerating: true,
    quietForMs: 10_000,
  }), false);
  assert.equal(tracker.shouldEmit({
    hasFollowingMessage: false,
    hasCompletionControls: true,
    isGenerating: false,
    quietForMs: 100,
  }), true);
  assert.equal(tracker.shouldEmit({
    hasFollowingMessage: false,
    hasCompletionControls: false,
    isGenerating: false,
    quietForMs: 4_999,
  }), false);
  assert.equal(tracker.shouldEmit({
    hasFollowingMessage: false,
    hasCompletionControls: false,
    isGenerating: false,
    quietForMs: 5_000,
  }), true);
});

test("logical turn sources prefer DOM message IDs and fall back to assistant ordinals", async () => {
  const tracker = await loadTracker();
  assert.equal(tracker.turnSource({
    conversationPath: "/c/example",
    messageId: "message-123",
    ordinal: 7,
  }), "/c/example:message:message-123");
  assert.equal(tracker.turnSource({
    conversationPath: "/c/example",
    messageId: "",
    ordinal: 7,
  }), "/c/example:assistant:7");

  const messages = [
    { getAttribute: () => "user" },
    { getAttribute: () => "assistant" },
    { getAttribute: () => "assistant" },
  ];
  assert.equal(tracker.assistantOrdinal(messages, messages[2]), 1);
});
