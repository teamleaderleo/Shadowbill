import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ObservationLedger, observationLedgerRecord } from "../src/observation-ledger.js";
import { JsonlEventStore } from "../src/store.js";

async function fixture() {
  return JSON.parse(await readFile(new URL("./fixtures/observations/renderprove-browser-review-passed-v1.json", import.meta.url), "utf8"));
}

async function temporaryLedger(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-observation-ledger-"));
  const path = join(directory, "events.jsonl");
  try {
    await callback({ path });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("stores an observation in a rebuildable ledger record", async () => {
  await temporaryLedger(async ({ path }) => {
    const observation = await fixture();
    const ledger = new ObservationLedger(new JsonlEventStore(path));
    const result = await ledger.append(observation);
    assert.equal(result.status, "inserted");
    assert.equal(result.observation, observation);
    const [record] = await new JsonlEventStore(path).readAll();
    assert.deepEqual(record, observationLedgerRecord(observation));
  });
});

test("returns the original accepted effect for semantic replay", async () => {
  await temporaryLedger(async ({ path }) => {
    const observation = await fixture();
    const left = new ObservationLedger(new JsonlEventStore(path));
    const right = new ObservationLedger(new JsonlEventStore(path));
    const replay = structuredClone(observation);
    replay.data.ingestedAt = "2026-07-25T17:00:00.000Z";
    const results = await Promise.all([left.append(observation), right.append(replay)]);
    assert.deepEqual(results.map((value) => value.status).sort(), ["duplicate", "inserted"]);
    const duplicate = results.find((value) => value.status === "duplicate");
    assert.equal(duplicate.observation.data.ingestedAt, observation.data.ingestedAt);
    assert.equal((await new JsonlEventStore(path).readAll()).length, 1);
  });
});

test("rejects conflicting reuse atomically", async () => {
  await temporaryLedger(async ({ path }) => {
    const observation = await fixture();
    const ledger = new ObservationLedger(new JsonlEventStore(path));
    await ledger.append(observation);
    const conflict = structuredClone(observation);
    conflict.data.status = "failed";
    await assert.rejects(ledger.append(conflict), (error) => {
      assert.equal(error.code, "OBSERVATION_ID_CONFLICT");
      assert.equal(error.path, "$.id");
      return true;
    });
    assert.equal((await new JsonlEventStore(path).readAll()).length, 1);
  });
});
