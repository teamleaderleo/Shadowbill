import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseObservationJson, validateObservation } from "../src/observation.js";
import {
  EvaluationObservationError,
  REVIEW_FINDING_TYPE,
  WORK_EVALUATION_TYPE,
  validateEvaluationObservation,
} from "../src/evaluation-observation.js";

async function fixture(name) {
  const text = await readFile(new URL(`./fixtures/observations/${name}`, import.meta.url), "utf8");
  return { text, value: JSON.parse(text) };
}

function fact(value, name) {
  return value.data.facts.find((entry) => entry.name === name);
}

function removeFact(value, name) {
  value.data.facts = value.data.facts.filter((entry) => entry.name !== name);
}

function expectEvaluationError(value, code) {
  assert.throws(() => validateEvaluationObservation(value), (error) => {
    assert.equal(error instanceof EvaluationObservationError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test("evaluation fixtures are valid observation-v1 documents and specialised receipts", async () => {
  const work = await fixture("stensibly-work-evaluation-repair-v1.json");
  const review = await fixture("stensibly-review-finding-upheld-v1.json");

  assert.equal(parseObservationJson(work.text).type, WORK_EVALUATION_TYPE);
  assert.equal(parseObservationJson(review.text).type, REVIEW_FINDING_TYPE);
  assert.equal(validateObservation(work.value), work.value);
  assert.equal(validateObservation(review.value), review.value);
  assert.equal(validateEvaluationObservation(work.value), work.value);
  assert.equal(validateEvaluationObservation(review.value), review.value);
  assert.equal(
    work.value.data.relationships.run,
    fact(work.value, "proofwake.evaluation.target-run").value,
  );
  assert.notEqual(
    fact(work.value, "proofwake.evaluation.target-run").value,
    fact(work.value, "proofwake.evaluation.evaluator-run").value,
  );
});

test("specialised validation rejects missing required evaluation facts", async () => {
  const { value } = await fixture("stensibly-work-evaluation-repair-v1.json");
  removeFact(value, "proofwake.evaluation.task-class");
  expectEvaluationError(value, "EVALUATION_MISSING_FACT");
});

test("specialised validation rejects unsupported finding dispositions", async () => {
  const { value } = await fixture("stensibly-review-finding-upheld-v1.json");
  fact(value, "proofwake.review.disposition").value = "reviewer-was-right";
  expectEvaluationError(value, "EVALUATION_INVALID_FACT");
});

test("receipt-family fact allowlists reject unknown and cross-family facts", async () => {
  const workUnknown = (await fixture("stensibly-work-evaluation-repair-v1.json")).value;
  workUnknown.data.facts.push({
    name: "proofwake.evaluation.prompt",
    value: "base64url-token",
  });
  expectEvaluationError(workUnknown, "EVALUATION_UNKNOWN_FACT");

  const workReviewFact = (await fixture("stensibly-work-evaluation-repair-v1.json")).value;
  workReviewFact.data.facts.push({
    name: "proofwake.review.disposition",
    value: "upheld-and-repaired",
  });
  expectEvaluationError(workReviewFact, "EVALUATION_UNKNOWN_FACT");

  const reviewWorkFact = (await fixture("stensibly-review-finding-upheld-v1.json")).value;
  reviewWorkFact.data.facts.push({
    name: "proofwake.evaluation.repair-count",
    value: 1,
  });
  expectEvaluationError(reviewWorkFact, "EVALUATION_UNKNOWN_FACT");
});

test("exact run references are required and callsigns are display-only", async () => {
  const displayOnly = (await fixture("stensibly-work-evaluation-repair-v1.json")).value;
  removeFact(displayOnly, "proofwake.evaluation.target-run");
  removeFact(displayOnly, "proofwake.evaluation.evaluator-run");
  assert.equal(fact(displayOnly, "proofwake.evaluation.target-callsign").value, "Forge");
  assert.equal(fact(displayOnly, "proofwake.evaluation.evaluator-callsign").value, "Relay");
  expectEvaluationError(displayOnly, "EVALUATION_MISSING_FACT");

  const malformed = (await fixture("stensibly-work-evaluation-repair-v1.json")).value;
  fact(malformed, "proofwake.evaluation.evaluator-run").value = "Relay";
  expectEvaluationError(malformed, "EVALUATION_INVALID_REFERENCE");

  const mismatched = (await fixture("stensibly-work-evaluation-repair-v1.json")).value;
  mismatched.data.relationships.run = "run_different_target";
  expectEvaluationError(mismatched, "EVALUATION_RELATIONSHIP_CONFLICT");
});

test("independent evaluation requires distinct target and evaluator runs", async () => {
  const { value } = await fixture("stensibly-work-evaluation-repair-v1.json");
  fact(value, "proofwake.evaluation.evaluator-run").value =
    fact(value, "proofwake.evaluation.target-run").value;
  expectEvaluationError(value, "EVALUATION_IDENTITY_CONFLICT");
});

test("confidence and uncertainty are required bounded classes", async () => {
  const missingConfidence = (await fixture("stensibly-work-evaluation-repair-v1.json")).value;
  removeFact(missingConfidence, "proofwake.evaluation.confidence");
  expectEvaluationError(missingConfidence, "EVALUATION_MISSING_FACT");

  const invalidConfidence = (await fixture("stensibly-work-evaluation-repair-v1.json")).value;
  fact(invalidConfidence, "proofwake.evaluation.confidence").value = "certain";
  expectEvaluationError(invalidConfidence, "EVALUATION_INVALID_FACT");

  const missingUncertainty = (await fixture("stensibly-review-finding-upheld-v1.json")).value;
  removeFact(missingUncertainty, "proofwake.evaluation.uncertainty");
  expectEvaluationError(missingUncertainty, "EVALUATION_MISSING_FACT");

  const invalidUncertainty = (await fixture("stensibly-review-finding-upheld-v1.json")).value;
  fact(invalidUncertainty, "proofwake.evaluation.uncertainty").value = "perfectly-known";
  expectEvaluationError(invalidUncertainty, "EVALUATION_INVALID_FACT");
});

test("evaluation fixtures stay content-minimised", async () => {
  const work = (await fixture("stensibly-work-evaluation-repair-v1.json")).text;
  const review = (await fixture("stensibly-review-finding-upheld-v1.json")).text;
  const combined = `${work}\n${review}`;

  for (const forbidden of [
    "prompt",
    "response",
    "source patch",
    "environment",
    "credential",
    "final hard-limit cleanup repairs can roll back",
  ]) {
    assert.equal(combined.toLowerCase().includes(forbidden), false, forbidden);
  }
});
