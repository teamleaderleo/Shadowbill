import { validateObservation } from "./observation.js";

export const WORK_EVALUATION_TYPE = "proofwake.work.evaluation.observed.v1";
export const REVIEW_FINDING_TYPE = "proofwake.review.finding.dispositioned.v1";
export const EVALUATION_SOURCE_SCHEMA = "urn:proofwake:schema:evaluation-observation:v1";

const SUPPORTED_TYPES = new Set([WORK_EVALUATION_TYPE, REVIEW_FINDING_TYPE]);
const EVIDENCE_CLASSES = new Set(["observed", "inferred", "human-annotated"]);
const INDEPENDENCE_CLASSES = new Set([
  "independent",
  "self-report",
  "deterministic-tool",
  "human-annotation",
  "conflicted",
]);
const CONFIDENCE_CLASSES = new Set(["high", "medium", "low", "unknown"]);
const UNCERTAINTY_CLASSES = new Set(["none", "bounded", "material", "disputed", "unknown"]);
const SEVERITIES = new Set(["none", "low", "medium", "high", "critical"]);
const WORK_CLASSIFICATIONS = new Set([
  "accepted",
  "repair-required",
  "rejected",
  "superseded",
  "unresolved",
  "retained-partial",
  "operator-corrected",
]);
const REVIEW_DISPOSITIONS = new Set([
  "unresolved",
  "upheld-repair-required",
  "upheld-and-repaired",
  "accepted-residual-risk",
  "rejected",
  "duplicate",
  "superseded",
  "downstream-confirmed",
]);

const RUN_REFERENCE = /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,123}$/;

const COMMON_REQUIRED_FACTS = new Set([
  "proofwake.evaluation.schema-version",
  "proofwake.evaluation.task-class",
  "proofwake.evaluation.rubric-version",
  "proofwake.evaluation.target-run",
  "proofwake.evaluation.evaluator-run",
  "proofwake.evaluation.independence",
  "proofwake.evaluation.evidence-class",
  "proofwake.evaluation.confidence",
  "proofwake.evaluation.uncertainty",
]);
const COMMON_OPTIONAL_FACTS = new Set([
  "proofwake.evaluation.target-callsign",
  "proofwake.evaluation.evaluator-callsign",
  "proofwake.evaluation.model-profile",
  "proofwake.evaluation.adapter-profile",
]);
const WORK_FACTS = new Set([
  "proofwake.evaluation.facet",
  "proofwake.evaluation.classification",
  "proofwake.evaluation.severity",
  "proofwake.evaluation.accepted-first-pass",
  "proofwake.evaluation.repair-count",
]);
const REVIEW_FACTS = new Set([
  "proofwake.review.finding-id",
  "proofwake.review.finding-class",
  "proofwake.review.disposition",
  "proofwake.review.severity",
  "proofwake.review.clearing-condition",
]);

export class EvaluationObservationError extends Error {
  constructor(code, message, path = "$") {
    super(message);
    this.name = "EvaluationObservationError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "$") {
  throw new EvaluationObservationError(code, message, path);
}

function factsByName(observation) {
  return new Map(observation.data.facts.map((fact) => [fact.name, fact.value]));
}

function allowedFactsFor(type) {
  return new Set([
    ...COMMON_REQUIRED_FACTS,
    ...COMMON_OPTIONAL_FACTS,
    ...(type === WORK_EVALUATION_TYPE ? WORK_FACTS : REVIEW_FACTS),
  ]);
}

function requireAllowedFacts(observation) {
  const allowed = allowedFactsFor(observation.type);
  for (let index = 0; index < observation.data.facts.length; index += 1) {
    const name = observation.data.facts[index].name;
    if (!allowed.has(name)) {
      fail(
        "EVALUATION_UNKNOWN_FACT",
        `Fact ${name} is not allowed for ${observation.type}.`,
        `$.data.facts[${index}].name`,
      );
    }
  }
}

function requireFact(facts, name) {
  if (!facts.has(name)) {
    fail("EVALUATION_MISSING_FACT", `Missing required evaluation fact: ${name}.`, "$.data.facts");
  }
  return facts.get(name);
}

function requireTokenFact(facts, name, allowed) {
  const value = requireFact(facts, name);
  if (typeof value !== "string") {
    fail("EVALUATION_INVALID_FACT", `${name} must be a token string.`, "$.data.facts");
  }
  if (allowed && !allowed.has(value)) {
    fail("EVALUATION_INVALID_FACT", `Unsupported ${name} value: ${value}.`, "$.data.facts");
  }
  return value;
}

function optionalTokenFact(facts, name) {
  if (!facts.has(name)) return null;
  return requireTokenFact(facts, name);
}

function requireRunFact(facts, name) {
  const value = requireTokenFact(facts, name);
  if (!RUN_REFERENCE.test(value)) {
    fail(
      "EVALUATION_INVALID_REFERENCE",
      `${name} must be an exact run_ reference.`,
      "$.data.facts",
    );
  }
  return value;
}

function requireIntegerFact(facts, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = requireFact(facts, name);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("EVALUATION_INVALID_FACT", `${name} must be an integer in range ${min}..${max}.`, "$.data.facts");
  }
  return value;
}

function requireBooleanFact(facts, name) {
  const value = requireFact(facts, name);
  if (typeof value !== "boolean") {
    fail("EVALUATION_INVALID_FACT", `${name} must be a boolean.`, "$.data.facts");
  }
  return value;
}

function validateCommon(observation, facts) {
  if (observation.data.kind !== "domain-check") {
    fail("EVALUATION_INVALID_KIND", "Evaluation observations must use the domain-check projection kind.", "$.data.kind");
  }
  if (!/^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@sha:[a-f0-9]{40}$/.test(observation.subject)) {
    fail("EVALUATION_INVALID_SUBJECT", "Evaluation observations must target one exact repository revision.", "$.subject");
  }
  if (!observation.data.relationships.run) {
    fail("EVALUATION_MISSING_RELATIONSHIP", "Evaluation observations require an exact target run relationship.", "$.data.relationships.run");
  }
  if (observation.data.evidence.length === 0) {
    fail("EVALUATION_MISSING_EVIDENCE", "Evaluation observations require at least one evidence reference.", "$.data.evidence");
  }

  for (const name of COMMON_REQUIRED_FACTS) requireFact(facts, name);
  requireIntegerFact(facts, "proofwake.evaluation.schema-version", { min: 1, max: 1 });
  requireTokenFact(facts, "proofwake.evaluation.task-class");
  requireTokenFact(facts, "proofwake.evaluation.rubric-version");
  const targetRun = requireRunFact(facts, "proofwake.evaluation.target-run");
  const evaluatorRun = requireRunFact(facts, "proofwake.evaluation.evaluator-run");
  const independence = requireTokenFact(
    facts,
    "proofwake.evaluation.independence",
    INDEPENDENCE_CLASSES,
  );
  requireTokenFact(facts, "proofwake.evaluation.evidence-class", EVIDENCE_CLASSES);
  requireTokenFact(facts, "proofwake.evaluation.confidence", CONFIDENCE_CLASSES);
  requireTokenFact(facts, "proofwake.evaluation.uncertainty", UNCERTAINTY_CLASSES);

  for (const name of COMMON_OPTIONAL_FACTS) optionalTokenFact(facts, name);

  if (observation.data.relationships.run !== targetRun) {
    fail(
      "EVALUATION_RELATIONSHIP_CONFLICT",
      "The run relationship must equal proofwake.evaluation.target-run.",
      "$.data.relationships.run",
    );
  }
  if (independence === "independent" && targetRun === evaluatorRun) {
    fail(
      "EVALUATION_IDENTITY_CONFLICT",
      "Independent evaluation requires distinct target and evaluator runs.",
      "$.data.facts",
    );
  }
}

function validateWorkEvaluation(facts) {
  requireTokenFact(facts, "proofwake.evaluation.facet");
  requireTokenFact(facts, "proofwake.evaluation.classification", WORK_CLASSIFICATIONS);
  requireTokenFact(facts, "proofwake.evaluation.severity", SEVERITIES);
  requireBooleanFact(facts, "proofwake.evaluation.accepted-first-pass");
  requireIntegerFact(facts, "proofwake.evaluation.repair-count", { min: 0, max: 1000 });
}

function validateReviewFinding(facts) {
  requireTokenFact(facts, "proofwake.review.finding-id");
  requireTokenFact(facts, "proofwake.review.finding-class");
  requireTokenFact(facts, "proofwake.review.disposition", REVIEW_DISPOSITIONS);
  requireTokenFact(facts, "proofwake.review.severity", SEVERITIES);
  requireTokenFact(facts, "proofwake.review.clearing-condition");
}

export function validateEvaluationObservation(observation) {
  validateObservation(observation);
  if (!SUPPORTED_TYPES.has(observation.type)) {
    fail("EVALUATION_UNSUPPORTED_TYPE", `Unsupported evaluation observation type: ${observation.type}.`, "$.type");
  }

  requireAllowedFacts(observation);
  const facts = factsByName(observation);
  validateCommon(observation, facts);
  if (observation.type === WORK_EVALUATION_TYPE) validateWorkEvaluation(facts);
  else validateReviewFinding(facts);
  return observation;
}
