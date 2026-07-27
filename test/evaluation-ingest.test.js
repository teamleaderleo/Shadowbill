import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emitObservation } from "../src/emit.js";
import { ingestEvaluationReceipt, parseEvaluationReceiptJson } from "../src/evaluation-ingest.js";
import { JsonlEventStore } from "../src/store.js";

async function fixture(name) {
  return readFile(new URL(`./fixtures/observations/${name}`, import.meta.url), "utf8");
}

async function temporary(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-evaluation-ingest-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("evaluation ingestion uses the same canonical append result as generic emit", async () => {
  await temporary(async (directory) => {
    const receiptJson = await fixture("stensibly-work-evaluation-repair-v1.json");
    const now = new Date("2026-07-28T01:00:00.000Z");
    const genericStore = new JsonlEventStore(join(directory, "generic.jsonl"));
    const evaluationStore = new JsonlEventStore(join(directory, "evaluation.jsonl"));

    const generic = await emitObservation({ store: genericStore, text: receiptJson, now });
    const evaluation = await ingestEvaluationReceipt({ store: evaluationStore, receiptJson, now });
    const [genericRecord] = await genericStore.readAll();
    const [evaluationRecord] = await evaluationStore.readAll();

    assert.equal(evaluation.accepted, true);
    assert.equal(evaluation.replayed, false);
    assert.equal(evaluation.status, "inserted");
    assert.equal(evaluation.fingerprint, generic.fingerprint);
    assert.equal(evaluation.eventId, genericRecord.id);
    assert.deepEqual(evaluationRecord, genericRecord);
  });
});

test("identical replay returns the original accepted result across ingestion times", async () => {
  await temporary(async (directory) => {
    const receiptJson = await fixture("stensibly-review-finding-upheld-v1.json");
    const store = new JsonlEventStore(join(directory, "events.jsonl"));
    const first = await ingestEvaluationReceipt({
      store,
      receiptJson,
      now: new Date("2026-07-28T01:00:00.000Z"),
    });
    const replay = await ingestEvaluationReceipt({
      store,
      receiptJson,
      now: new Date("2026-07-28T02:00:00.000Z"),
    });

    assert.equal(first.status, "inserted");
    assert.equal(replay.status, "duplicate");
    assert.equal(replay.replayed, true);
    assert.equal(replay.eventId, first.eventId);
    assert.equal(replay.fingerprint, first.fingerprint);
    assert.equal(replay.ingestedAt, first.ingestedAt);
    assert.equal((await store.readAll()).length, 1);
  });
});

test("same evaluation identity with changed content conflicts without a second append", async () => {
  await temporary(async (directory) => {
    const original = JSON.parse(await fixture("stensibly-work-evaluation-repair-v1.json"));
    const changed = structuredClone(original);
    const classification = changed.data.facts.find((fact) =>
      fact.name === "proofwake.evaluation.classification"
    );
    classification.value = "rejected";
    const store = new JsonlEventStore(join(directory, "events.jsonl"));
    await ingestEvaluationReceipt({
      store,
      receiptJson: JSON.stringify(original),
      now: new Date("2026-07-28T01:00:00.000Z"),
    });

    await assert.rejects(
      ingestEvaluationReceipt({
        store,
        receiptJson: JSON.stringify(changed),
        now: new Date("2026-07-28T02:00:00.000Z"),
      }),
      (error) => error?.code === "OBSERVATION_ID_CONFLICT",
    );
    assert.equal((await store.readAll()).length, 1);
  });
});

test("only strict evaluation families can enter the evaluation ingestion path", async () => {
  const work = JSON.parse(await fixture("stensibly-work-evaluation-repair-v1.json"));
  const unsupported = structuredClone(work);
  unsupported.type = "dev.proofwake.observation.verify.v1";
  const unknownFact = structuredClone(work);
  unknownFact.data.facts.push({
    name: "proofwake.evaluation.prompt",
    value: "private-prompt-sentinel",
  });

  assert.throws(
    () => parseEvaluationReceiptJson(JSON.stringify(unsupported)),
    (error) => error?.code === "EVALUATION_UNSUPPORTED_TYPE",
  );
  assert.throws(
    () => parseEvaluationReceiptJson(JSON.stringify(unknownFact)),
    (error) => error?.code === "EVALUATION_UNKNOWN_FACT",
  );
});

test("exact JSON parsing preserves duplicate-key, depth, and total-byte bounds", async () => {
  const receiptJson = await fixture("stensibly-work-evaluation-repair-v1.json");
  const duplicateKey = receiptJson.replace(
    '"specversion": "1.0",',
    '"specversion": "1.0", "specversion": "1.0",',
  );
  assert.throws(
    () => parseEvaluationReceiptJson(duplicateKey),
    (error) => error?.code === "OBSERVATION_DUPLICATE_KEY",
  );

  const observation = JSON.parse(receiptJson);
  let nested = "leaf";
  for (let index = 0; index < 20; index += 1) nested = { nested };
  observation.data.facts.push({ name: "proofwake.evaluation.extra-depth", value: nested });
  assert.throws(
    () => parseEvaluationReceiptJson(JSON.stringify(observation)),
    (error) => error?.code === "OBSERVATION_TOO_DEEP",
  );

  const oversized = `${receiptJson.slice(0, -2)}, "padding": "${"x".repeat(70_000)}"\n}`;
  assert.throws(
    () => parseEvaluationReceiptJson(oversized),
    (error) => error?.code === "OBSERVATION_TOO_LARGE",
  );
});
