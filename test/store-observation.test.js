import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareObservation } from "../src/observation.js";
import { JsonlEventStore } from "../src/store.js";

const fixtureUrl = new URL("./fixtures/observation-valid.json", import.meta.url);

async function prepared() {
  return prepareObservation(await readFile(fixtureUrl, "utf8"), {
    now: new Date("2026-07-25T17:01:00Z"),
  }).event;
}

function legacyEvent(id) {
  return {
    type: "git_commit",
    id,
    timestamp: "2026-07-25T17:00:00.000Z",
    repository: "team/repo",
    branch: "main",
    sha: "0123456789012345678901234567890123456789",
    subject: "Verify",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    addedCodeTokens: 0,
  };
}

test("legacy and CloudEvents identities do not suppress each other", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-store-identities-"));
  const store = new JsonlEventStore(join(directory, "events.jsonl"));
  try {
    const observation = await prepared();
    assert.equal(await store.append(legacyEvent(observation.id)), true);
    assert.equal((await store.appendObservation(observation)).inserted, true);
    assert.equal((await store.readAll()).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy append remains idempotent after a same-id CloudEvent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-store-legacy-after-"));
  const store = new JsonlEventStore(join(directory, "events.jsonl"));
  try {
    const observation = await prepared();
    assert.equal((await store.appendObservation(observation)).inserted, true);
    assert.equal(await store.append(legacyEvent(observation.id)), true);
    assert.equal(await store.append(legacyEvent(observation.id)), false);
    assert.equal((await store.readAll()).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
