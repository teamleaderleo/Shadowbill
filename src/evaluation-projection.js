import { createHash } from "node:crypto";
import {
  REVIEW_FINDING_TYPE,
  WORK_EVALUATION_TYPE,
  validateEvaluationObservation,
} from "./evaluation-observation.js";
import { observationLedgerRecord } from "./observation-ledger.js";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RUN_REFERENCE = /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,123}$/u;
const SUPPORTED_TYPES = new Set([WORK_EVALUATION_TYPE, REVIEW_FINDING_TYPE]);
const OPEN_FINDING_DISPOSITIONS = new Set(["unresolved", "upheld-repair-required"]);
const WRAPPER_KEYS = new Set([
  "type",
  "id",
  "timestamp",
  "requestFingerprint",
  "observationIdentity",
  "observation",
]);

export class EvaluationProjectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EvaluationProjectionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new EvaluationProjectionError(code, message);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function eventDigest(event) {
  try {
    return digest(JSON.stringify(event));
  } catch {
    return digest("unserializable-evaluation-event");
  }
}

function countValues(values) {
  const counts = new Map();
  for (const value of values) {
    const key = JSON.stringify(value);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { value, count: 1 });
  }
  return [...counts.values()].sort((left, right) =>
    String(left.value).localeCompare(String(right.value))
  );
}

function groupBy(values, keyOf) {
  const groups = new Map();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

function factMap(observation) {
  return new Map(observation.data.facts.map((fact) => [fact.name, fact.value]));
}

function subjectMatchesRepository(observation, repository) {
  return typeof observation?.subject === "string"
    && observation.subject.startsWith(`repo:${repository}@sha:`);
}

function exclusionCode(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code.startsWith("EVALUATION_")) return code;
  return "EVALUATION_RECEIPT_INVALID";
}

function hasExactWrapperKeys(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const keys = Object.keys(event);
  return keys.length === WRAPPER_KEYS.size && keys.every((key) => WRAPPER_KEYS.has(key));
}

function wrapperError(event, expected) {
  if (!hasExactWrapperKeys(event)) return "EVALUATION_LEDGER_WRAPPER_MISMATCH";
  if (event.id !== expected.id) return "EVALUATION_LEDGER_IDENTITY_MISMATCH";
  if (event.timestamp !== expected.timestamp) return "EVALUATION_LEDGER_TIMESTAMP_MISMATCH";
  if (event.requestFingerprint !== expected.requestFingerprint) {
    return "EVALUATION_LEDGER_FINGERPRINT_MISMATCH";
  }
  if (
    event.observationIdentity?.source !== expected.observationIdentity.source
    || event.observationIdentity?.id !== expected.observationIdentity.id
  ) {
    return "EVALUATION_LEDGER_OBSERVATION_IDENTITY_MISMATCH";
  }
  return null;
}

function normalizedCoverage(observation) {
  return {
    state: observation.data.coverage.state,
    redacted: observation.data.coverage.redacted,
    truncated: observation.data.coverage.truncated,
    omitted: [...observation.data.coverage.omitted].sort(),
  };
}

function normalizeRecord(event, observation, facts) {
  const common = {
    receipt: {
      source: observation.source,
      id: observation.id,
      fingerprint: event.requestFingerprint,
    },
    type: observation.type,
    revision: observation.data.relationships.revision,
    observedAt: observation.data.observedAt,
    ingestedAt: observation.data.ingestedAt,
    targetRun: facts.get("proofwake.evaluation.target-run"),
    evaluatorRun: facts.get("proofwake.evaluation.evaluator-run"),
    targetCallsign: facts.get("proofwake.evaluation.target-callsign") ?? null,
    evaluatorCallsign: facts.get("proofwake.evaluation.evaluator-callsign") ?? null,
    modelProfile: facts.get("proofwake.evaluation.model-profile") ?? null,
    adapterProfile: facts.get("proofwake.evaluation.adapter-profile") ?? null,
    rubricVersion: facts.get("proofwake.evaluation.rubric-version"),
    taskClass: facts.get("proofwake.evaluation.task-class"),
    independence: facts.get("proofwake.evaluation.independence"),
    evidenceClass: facts.get("proofwake.evaluation.evidence-class"),
    confidence: facts.get("proofwake.evaluation.confidence"),
    uncertainty: facts.get("proofwake.evaluation.uncertainty"),
    coverage: normalizedCoverage(observation),
    evidenceDigests: observation.data.evidence.map((item) => item.digest).sort(),
  };

  if (observation.type === WORK_EVALUATION_TYPE) {
    return {
      ...common,
      family: "work-evaluation",
      facet: facts.get("proofwake.evaluation.facet"),
      classification: facts.get("proofwake.evaluation.classification"),
      severity: facts.get("proofwake.evaluation.severity"),
      acceptedFirstPass: facts.get("proofwake.evaluation.accepted-first-pass"),
      repairCount: facts.get("proofwake.evaluation.repair-count"),
    };
  }

  return {
    ...common,
    family: "review-finding",
    findingId: facts.get("proofwake.review.finding-id"),
    findingClass: facts.get("proofwake.review.finding-class"),
    disposition: facts.get("proofwake.review.disposition"),
    severity: facts.get("proofwake.review.severity"),
    clearingCondition: facts.get("proofwake.review.clearing-condition"),
  };
}

function compareRecords(left, right) {
  return left.observedAt.localeCompare(right.observedAt)
    || left.ingestedAt.localeCompare(right.ingestedAt)
    || left.receipt.source.localeCompare(right.receipt.source)
    || left.receipt.id.localeCompare(right.receipt.id);
}

function selectCandidate(event, selection) {
  const observation = event?.observation;
  if (event?.type !== "proofwake_observation" || !SUPPORTED_TYPES.has(observation?.type)) {
    return { state: "ignored" };
  }
  if (!subjectMatchesRepository(observation, selection.repository)) return { state: "ignored" };

  let expected;
  try {
    expected = observationLedgerRecord(observation);
  } catch (error) {
    return { state: "excluded", code: exclusionCode(error), digest: eventDigest(event) };
  }

  const facts = factMap(observation);
  const taskClass = facts.get("proofwake.evaluation.task-class");
  if (taskClass === undefined) {
    return { state: "excluded", code: "EVALUATION_MISSING_FACT", digest: eventDigest(event) };
  }
  if (taskClass !== selection.taskClass) return { state: "ignored" };

  const targetRun = facts.get("proofwake.evaluation.target-run");
  if (selection.targetRun && targetRun === undefined) {
    return { state: "excluded", code: "EVALUATION_MISSING_FACT", digest: eventDigest(event) };
  }
  if (selection.targetRun && targetRun !== selection.targetRun) return { state: "ignored" };

  const mismatch = wrapperError(event, expected);
  if (mismatch) return { state: "excluded", code: mismatch, digest: eventDigest(event) };

  try {
    validateEvaluationObservation(observation);
  } catch (error) {
    return { state: "excluded", code: exclusionCode(error), digest: eventDigest(event) };
  }

  return { state: "selected", record: normalizeRecord(event, observation, facts) };
}

function receiptSummary(record) {
  return {
    receipt: record.receipt,
    family: record.family,
    revision: record.revision,
    observedAt: record.observedAt,
    targetRun: record.targetRun,
    evaluatorRun: record.evaluatorRun,
    rubricVersion: record.rubricVersion,
  };
}

function coverageSummary(records) {
  return {
    states: countValues(records.map((record) => record.coverage.state)),
    redactedReceipts: records.filter((record) => record.coverage.redacted).length,
    truncatedReceipts: records.filter((record) => record.coverage.truncated).length,
    omissions: countValues(records.flatMap((record) => record.coverage.omitted)),
  };
}

function targetViews(records) {
  return [...groupBy(records, (record) => record.targetRun).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([targetRun, group]) => ({
      targetRun,
      callsigns: [...new Set(group.map((record) => record.targetCallsign).filter(Boolean))].sort(),
      modelProfiles: [...new Set(group.map((record) => record.modelProfile).filter(Boolean))].sort(),
      adapterProfiles: [...new Set(group.map((record) => record.adapterProfile).filter(Boolean))].sort(),
      workEvaluationCount: group.filter((record) => record.family === "work-evaluation").length,
      reviewFindingCount: group.filter((record) => record.family === "review-finding").length,
    }));
}

function markSummary(mark) {
  return {
    ...receiptSummary(mark),
    targetCallsign: mark.targetCallsign,
    evaluatorCallsign: mark.evaluatorCallsign,
    modelProfile: mark.modelProfile,
    adapterProfile: mark.adapterProfile,
    facet: mark.facet,
    classification: mark.classification,
    severity: mark.severity,
    acceptedFirstPass: mark.acceptedFirstPass,
    repairCount: mark.repairCount,
    confidence: mark.confidence,
    uncertainty: mark.uncertainty,
    evidenceClass: mark.evidenceClass,
    independence: mark.independence,
    coverage: mark.coverage,
    evidenceDigests: mark.evidenceDigests,
  };
}

function rubricGroups(workRecords) {
  return [...groupBy(workRecords, (record) => record.rubricVersion).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rubricVersion, records]) => {
      const marks = [...records].sort(compareRecords);
      const targetRunCount = new Set(marks.map((mark) => mark.targetRun)).size;
      const facets = [...groupBy(marks, (mark) => mark.facet).entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([facet, facetMarks]) => ({
          facet,
          count: facetMarks.length,
          classifications: countValues(facetMarks.map((mark) => mark.classification)),
          severities: countValues(facetMarks.map((mark) => mark.severity)),
        }));
      return {
        rubricVersion,
        status: targetRunCount >= 2 ? "evidence_available" : "insufficient_evidence",
        comparableWorkEvaluations: marks.length,
        comparableTargetRuns: targetRunCount,
        targetRunCount,
        evaluatorRunCount: new Set(marks.map((mark) => mark.evaluatorRun)).size,
        classifications: countValues(marks.map((mark) => mark.classification)),
        severities: countValues(marks.map((mark) => mark.severity)),
        acceptedFirstPass: countValues(marks.map((mark) => mark.acceptedFirstPass)),
        repairCountTotal: marks.reduce((total, mark) => total + mark.repairCount, 0),
        confidence: countValues(marks.map((mark) => mark.confidence)),
        uncertainty: countValues(marks.map((mark) => mark.uncertainty)),
        evidenceClasses: countValues(marks.map((mark) => mark.evidenceClass)),
        independence: countValues(marks.map((mark) => mark.independence)),
        coverage: coverageSummary(marks),
        facets,
        marks: marks.map(markSummary),
      };
    });
}

function findingSummary(finding) {
  return {
    ...receiptSummary(finding),
    evaluatorCallsign: finding.evaluatorCallsign,
    findingId: finding.findingId,
    findingClass: finding.findingClass,
    disposition: finding.disposition,
    severity: finding.severity,
    clearingCondition: finding.clearingCondition,
    confidence: finding.confidence,
    uncertainty: finding.uncertainty,
    evidenceClass: finding.evidenceClass,
    independence: finding.independence,
    coverage: finding.coverage,
    evidenceDigests: finding.evidenceDigests,
  };
}

function reviewerViews(reviewRecords) {
  return [...groupBy(
    reviewRecords,
    (record) => `${record.evaluatorRun}\u0000${record.rubricVersion}`,
  ).values()]
    .map((records) => {
      const findings = [...records].sort(compareRecords);
      return {
        evaluatorRun: findings[0].evaluatorRun,
        rubricVersion: findings[0].rubricVersion,
        callsigns: [...new Set(findings.map((finding) => finding.evaluatorCallsign).filter(Boolean))].sort(),
        findingCount: findings.length,
        dispositions: countValues(findings.map((finding) => finding.disposition)),
        severities: countValues(findings.map((finding) => finding.severity)),
        confidence: countValues(findings.map((finding) => finding.confidence)),
        uncertainty: countValues(findings.map((finding) => finding.uncertainty)),
        coverage: coverageSummary(findings),
        findings: findings.map(findingSummary),
      };
    })
    .sort((left, right) => left.evaluatorRun.localeCompare(right.evaluatorRun)
      || left.rubricVersion.localeCompare(right.rubricVersion));
}

function limitations(records, groups, openFindings, excludedCount) {
  const result = [];
  const evaluatorCount = new Set(records.map((record) => record.evaluatorRun)).size;
  const coverage = coverageSummary(records);
  if (!groups.some((group) => group.status === "evidence_available")) {
    result.push({ code: "SMALL_SAMPLE", message: "No rubric group contains two distinct target runs." });
  }
  if (records.length > 0 && evaluatorCount <= 1) {
    result.push({ code: "SINGLE_EVALUATOR", message: "Evidence is concentrated in one evaluator run." });
  }
  if (groups.length > 1) {
    result.push({ code: "MIXED_RUBRICS", message: "Rubric versions are reported separately and are not averaged." });
  }
  if (openFindings.length > 0) {
    result.push({ code: "OPEN_FINDINGS", message: "One or more findings remain unresolved or repair-required." });
  }
  if (coverage.omissions.length > 0) {
    result.push({ code: "MISSING_EVIDENCE", message: "Coverage declares missing evidence; omissions are not negative evidence." });
  }
  if (coverage.states.some((entry) => entry.value !== "complete")) {
    result.push({ code: "PARTIAL_COVERAGE", message: "At least one receipt has partial or unavailable coverage." });
  }
  if (excludedCount > 0) {
    result.push({ code: "INVALID_RECEIPTS_EXCLUDED", message: "Invalid evaluation-looking ledger records were excluded from evidence." });
  }
  if (records.length > 0) {
    result.push({ code: "TASK_SELECTION_BIAS_UNKNOWN", message: "The selected receipts do not prove that the task sample is representative." });
  }
  return result;
}

function validateSelection({ repository, taskClass, targetRun }) {
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) {
    fail("EVALUATION_REPOSITORY_INVALID", "Repository must be an exact owner/name identity.");
  }
  if (typeof taskClass !== "string" || !TOKEN.test(taskClass)) {
    fail("EVALUATION_TASK_CLASS_INVALID", "Task class must be a bounded token.");
  }
  if (targetRun !== undefined && (typeof targetRun !== "string" || !RUN_REFERENCE.test(targetRun))) {
    fail("EVALUATION_TARGET_RUN_INVALID", "Target run must be an exact run_ reference.");
  }
}

export function buildEvaluationProjection({ events, repository, taskClass, targetRun }) {
  validateSelection({ repository, taskClass, targetRun });
  if (!Array.isArray(events)) fail("EVALUATION_LEDGER_INVALID", "Evaluation projection requires an event array.");

  const selection = { repository, taskClass, targetRun: targetRun ?? null };
  const selected = [];
  const exclusions = [];
  const selectedReceipts = new Set();
  for (const event of events) {
    const candidate = selectCandidate(event, selection);
    if (candidate.state === "selected") {
      const receiptKey = `${candidate.record.receipt.source}\u0000${candidate.record.receipt.id}`;
      if (selectedReceipts.has(receiptKey)) {
        exclusions.push({ code: "EVALUATION_LEDGER_DUPLICATE_RECORD", digest: eventDigest(event) });
      } else {
        selectedReceipts.add(receiptKey);
        selected.push(candidate.record);
      }
    } else if (candidate.state === "excluded") {
      exclusions.push({ code: candidate.code, digest: candidate.digest });
    }
  }
  selected.sort(compareRecords);
  exclusions.sort((left, right) => left.code.localeCompare(right.code) || left.digest.localeCompare(right.digest));

  const workRecords = selected.filter((record) => record.family === "work-evaluation");
  const reviewRecords = selected.filter((record) => record.family === "review-finding");
  const groups = rubricGroups(workRecords);
  const openFindings = reviewRecords
    .filter((record) => OPEN_FINDING_DISPOSITIONS.has(record.disposition))
    .sort(compareRecords)
    .map(findingSummary);
  const status = groups.some((group) => group.status === "evidence_available")
    ? "evidence_available"
    : "insufficient_evidence";
  const cursorPayload = {
    selection,
    selected: selected.map((record) => [
      record.receipt.source,
      record.receipt.id,
      record.receipt.fingerprint,
    ]),
    exclusions,
  };

  return {
    schemaVersion: 1,
    projection: "evaluation-evidence-v1",
    status,
    selection,
    sourceCursor: digest(JSON.stringify(cursorPayload)),
    receipts: {
      selected: selected.length,
      workEvaluations: workRecords.length,
      reviewFindings: reviewRecords.length,
      excluded: exclusions.length,
      excludedByCode: countValues(exclusions.map((item) => item.code)),
      identities: selected.map(receiptSummary),
    },
    targets: targetViews(selected),
    rubricGroups: groups,
    reviewerCalibration: reviewerViews(reviewRecords),
    openFindings,
    coverage: coverageSummary(selected),
    limitations: limitations(selected, groups, openFindings, exclusions.length),
  };
}
