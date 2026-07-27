import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildEvaluationProjection } from "../src/evaluation-projection.js";
import { observationLedgerRecord } from "../src/observation-ledger.js";

const repository = "teamleaderleo/stensibly";
const taskClass = "oauth-client-lifecycle";

async function workFixture() {
  return JSON.parse(await readFile(
    new URL("./fixtures/observations/stensibly-work-evaluation-repair-v1.json", import.meta.url),
    "utf8",
  ));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setFact(observation, name, value) {
  const fact = observation.data.facts.find((candidate) => candidate.name === name);
  if (!fact) throw new Error(`Missing fixture fact ${name}`);
  fact.value = value;
}

test("a malformed record for another task class does not contaminate this task projection", async () => {
  const observation = await workFixture();
  const unrelated = observationLedgerRecord(observation);
  setFact(unrelated.observation, "proofwake.evaluation.task-class", "different-task-class");
  unrelated.hiddenPayload = "unrelated-private-sentinel";

  const report = buildEvaluationProjection({
    events: [unrelated],
    repository,
    taskClass,
  });

  assert.equal(report.receipts.selected, 0);
  assert.equal(report.receipts.excluded, 0);
  assert.equal(report.sourceCursor.includes("unrelated-private-sentinel"), false);
  assert.equal(JSON.stringify(report).includes("unrelated-private-sentinel"), false);
});

test("nested observation identity extensions are rejected as noncanonical wrapper content", async () => {
  const observation = await workFixture();
  const extended = clone(observationLedgerRecord(observation));
  extended.observationIdentity.hiddenPayload = "nested-private-sentinel";

  const report = buildEvaluationProjection({
    events: [extended],
    repository,
    taskClass,
  });

  assert.equal(report.receipts.selected, 0);
  assert.equal(report.receipts.excluded, 1);
  assert.deepEqual(report.receipts.excludedByCode, [
    { value: "EVALUATION_LEDGER_WRAPPER_MISMATCH", count: 1 },
  ]);
  assert.equal(JSON.stringify(report).includes("nested-private-sentinel"), false);
});
