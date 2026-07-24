import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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

async function temporaryStore(callback) {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-store-"));
  const path = join(directory, "events.jsonl");
  try {
    await callback({ directory, path });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("deduplicates concurrent writers by ID", async () => {
  await temporaryStore(async ({ path }) => {
    const left = new JsonlEventStore(path);
    const right = new JsonlEventStore(path);
    const results = await Promise.all([left.append(event), right.append(event)]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.deepEqual(await left.readAll(), [event]);
  });
});

test("serializes distinct events across store instances", async () => {
  await temporaryStore(async ({ path }) => {
    const stores = Array.from({ length: 4 }, () => new JsonlEventStore(path));
    const events = Array.from({ length: 20 }, (_, index) => ({ ...event, id: `chat_${index}` }));
    const inserted = await Promise.all(events.map((value, index) => stores[index % stores.length].append(value)));
    assert.equal(inserted.every(Boolean), true);
    const saved = await stores[0].readAll();
    assert.equal(saved.length, events.length);
    assert.deepEqual(new Set(saved.map((value) => value.id)), new Set(events.map((value) => value.id)));
  });
});

test("uses owner-only ledger permissions", async () => {
  await temporaryStore(async ({ path }) => {
    const store = new JsonlEventStore(path);
    await store.append(event);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test("preserves a valid unterminated record before appending", async () => {
  await temporaryStore(async ({ path }) => {
    await writeFile(path, JSON.stringify(event), "utf8");
    const second = { ...event, id: "chat_second" };
    const store = new JsonlEventStore(path);
    assert.equal(await store.append(second), true);
    assert.deepEqual(await store.readAll(), [event, second]);
    assert.match(await readFile(path, "utf8"), /}\n{/);
  });
});

test("archives and removes a crash-truncated final line", async () => {
  await temporaryStore(async ({ path }) => {
    await writeFile(path, `${JSON.stringify(event)}\n{"type":"chat_turn","id":`, "utf8");
    const second = { ...event, id: "chat_second" };
    const store = new JsonlEventStore(path);
    assert.deepEqual(await store.readAll(), [event]);
    assert.equal(await store.append(second), true);
    assert.deepEqual(await store.readAll(), [event, second]);
    const recovery = (await readFile(`${path}.recovery.jsonl`, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(recovery.length, 1);
    assert.equal(Buffer.from(recovery[0].bytesBase64, "base64").toString("utf8"), '{"type":"chat_turn","id":');
  });
});

test("keeps interior corruption strict and releases the lock after failure", async () => {
  await temporaryStore(async ({ path }) => {
    await writeFile(path, `${JSON.stringify(event)}\n{bad}\n${JSON.stringify({ ...event, id: "chat_second" })}\n`, "utf8");
    const store = new JsonlEventStore(path);
    await assert.rejects(store.readAll(), /Invalid JSONL at line 2/);
    await assert.rejects(store.append({ ...event, id: "chat_third" }), /Invalid JSONL at line 2/);
    await assert.rejects(stat(`${path}.lock`), (error) => error.code === "ENOENT");
  });
});

test("recovers a stale lock directory", async () => {
  await temporaryStore(async ({ path }) => {
    const lockPath = `${path}.lock`;
    await mkdir(lockPath);
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);
    const store = new JsonlEventStore(path, { staleLockMs: 10, lockTimeoutMs: 1_000, retryDelayMs: 1 });
    assert.equal(await store.append(event), true);
    assert.deepEqual(await store.readAll(), [event]);
  });
});
