import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildEvaluationProjection } from "../src/evaluation-projection.js";
import { observationLedgerRecord } from "../src/observation-ledger.js";

const repository = "teamleaderleo/stensibly";
const taskClass = "oauth-client-lifecycle";
const main = new URL("../src/main.js", import.meta.url).pathname;

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/observations/${name}`, import.meta.url), "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fact(observation, name) {
  return observation.data.facts.find((entry) => entry.name === name);
}

function setFact(observation, name, value) {
  const entry = fact(observation, name);
  if (!entry) throw new Error(`Missing fixture fact ${name}`);
  entry.value = value;
}

function nextWork(base, {
  id = "stensibly.pr304.work-evaluation.accepted.v1",
  targetRun = "run_w01_oauth_implementation_02",
  evaluatorRun = "run_w01_oauth_review_02",
  rubricVersion = "stensibly-review-v1",
} = {}) {
  const observation = clone(base);
  observation.id = id;
  observation.time = "2026-07-27T12:14:00.000Z";
  observation.data.observedAt = "2026-07-27T12:15:00.000Z";
  observation.data.ingestedAt = "2026-07-27T12:31:00.000Z";
  observation.data.relationships.run = targetRun;
  observation.data.relationships.correlations = ["item_220", "pr_304"];
  setFact(observation, "proofwake.evaluation.target-run", targetRun);
  setFact(observation, "proofwake.evaluation.evaluator-run", evaluatorRun);
  setFact(observation, "proofwake.evaluation.rubric-version", rubricVersion);
  setFact(observation, "proofwake.evaluation.classification", "accepted");
  setFact(observation, "proofwake.evaluation.severity", "none");
  setFact(observation, "proofwake.evaluation.accepted-first-pass", true);
  setFact(observation, "proofwake.evaluation.repair-count", 0);
  setFact(observation, "proofwake.evaluation.uncertainty", "none");
  return observation;
}

function nextFinding(base, disposition, index) {
  const observation = clone(base);
  observation.id = `stensibly.pr308.review-finding.${disposition}.${index}.v1`;
  observation.time = `2026-07-27T12:${20 + index}:00.000Z`;
  observation.data.observedAt = `2026-07-27T12:${21 + index}:00.000Z`;
  observation.data.ingestedAt = `2026-07-27T12:${40 + index}:00.000Z`;
  setFact(observation, "proofwake.review.finding-id", `finding-${index}`);
  setFact(observation, "proofwake.review.disposition", disposition);
  return observation;
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function temporary(callback) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-evaluation-projection-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("merged fixtures produce a sparse task-specific evidence view", async () => {
  const work = await fixture("stensibly-work-evaluation-repair-v1.json");
  const review = await fixture("stensibly-review-finding-upheld-v1.json");
  const report = buildEvaluationProjection({
    events: [observationLedgerRecord(work), observationLedgerRecord(review)],
    repository,
    taskClass,
  });

  assert.equal(report.status, "insufficient_evidence");
  assert.deepEqual(report.receipts, {
    selected: 2,
    workEvaluations: 1,
    reviewFindings: 1,
    currentWorkMarks: 1,
    currentReviewFindings: 1,
    excluded: 0,
    excludedByCode: [],
    identities: report.receipts.identities,
  });
  assert.equal(report.rubricGroups.length, 1);
  assert.equal(report.rubricGroups[0].workEvaluationReceipts, 1);
  assert.equal(report.rubricGroups[0].currentWorkMarks, 1);
  assert.equal(report.rubricGroups[0].comparableWorkEvaluations, 1);
  assert.equal(report.rubricGroups[0].comparableTargetRuns, 1);
  assert.equal(report.rubricGroups[0].repairCountTotal, 1);
  assert.equal(report.openFindings.length, 1);
  assert.equal(report.openFindings[0].disposition, "upheld-repair-required");
  assert.ok(report.coverage.currentEvidence.omissions.some((entry) => entry.value === "proofwake.evaluation.cost"));
  assert.ok(report.limitations.some((entry) => entry.code === "SMALL_SAMPLE"));
  assert.ok(report.limitations.some((entry) => entry.code === "MISSING_EVIDENCE"));
  assert.equal(JSON.stringify(report).includes('"score"'), false);
});

test("two same-rubric target runs become evidence-available while target filtering remains sparse", async () => {
  const first = await fixture("stensibly-work-evaluation-repair-v1.json");
  const second = nextWork(first);
  const events = [observationLedgerRecord(second), observationLedgerRecord(first)];
  const report = buildEvaluationProjection({ events, repository, taskClass });

  assert.equal(report.status, "evidence_available");
  assert.equal(report.rubricGroups.length, 1);
  assert.equal(report.rubricGroups[0].comparableWorkEvaluations, 2);
  assert.equal(report.rubricGroups[0].comparableTargetRuns, 2);
  assert.equal(report.rubricGroups[0].targetRunCount, 2);
  assert.deepEqual(report.rubricGroups[0].acceptedFirstPass, [
    { value: false, count: 1 },
    { value: true, count: 1 },
  ]);

  const selected = buildEvaluationProjection({
    events,
    repository,
    taskClass,
    targetRun: "run_w01_oauth_implementation_01",
  });
  assert.equal(selected.status, "insufficient_evidence");
  assert.equal(selected.receipts.selected, 1);
});

test("multiple current marks for one target run do not satisfy the sample gate", async () => {
  const first = await fixture("stensibly-work-evaluation-repair-v1.json");
  const second = nextWork(first, {
    id: "stensibly.pr308.work-evaluation.second-review.v1",
    targetRun: "run_w01_oauth_implementation_01",
    evaluatorRun: "run_w01_oauth_review_03",
  });
  const report = buildEvaluationProjection({
    events: [observationLedgerRecord(first), observationLedgerRecord(second)],
    repository,
    taskClass,
  });

  assert.equal(report.receipts.workEvaluations, 2);
  assert.equal(report.receipts.currentWorkMarks, 2);
  assert.equal(report.rubricGroups[0].comparableWorkEvaluations, 2);
  assert.equal(report.rubricGroups[0].comparableTargetRuns, 1);
  assert.equal(report.status, "insufficient_evidence");
  assert.ok(report.limitations.some((entry) => entry.code === "SMALL_SAMPLE"));
});

test("later work mark corrections replace current state without deleting history", async () => {
  const first = await fixture("stensibly-work-evaluation-repair-v1.json");
  const correction = nextWork(first, {
    id: "stensibly.pr308.work-evaluation.corrected.v1",
    targetRun: "run_w01_oauth_implementation_01",
    evaluatorRun: "run_w01_oauth_review_01",
  });
  const report = buildEvaluationProjection({
    events: [observationLedgerRecord(correction), observationLedgerRecord(first)],
    repository,
    taskClass,
  });

  assert.equal(report.receipts.workEvaluations, 2);
  assert.equal(report.receipts.currentWorkMarks, 1);
  const group = report.rubricGroups[0];
  assert.equal(group.workEvaluationReceipts, 2);
  assert.equal(group.currentWorkMarks, 1);
  assert.equal(group.markHistory.length, 2);
  assert.equal(group.marks.length, 1);
  assert.equal(group.marks[0].receipt.id, correction.id);
  assert.deepEqual(group.classifications, [{ value: "accepted", count: 1 }]);
  assert.equal(group.repairCountTotal, 0);
});

test("superseded current marks remain visible but do not satisfy evidence sufficiency", async () => {
  const first = await fixture("stensibly-work-evaluation-repair-v1.json");
  const superseded = nextWork(first);
  setFact(superseded, "proofwake.evaluation.classification", "superseded");
  const report = buildEvaluationProjection({
    events: [observationLedgerRecord(first), observationLedgerRecord(superseded)],
    repository,
    taskClass,
  });

  assert.equal(report.rubricGroups[0].currentWorkMarks, 2);
  assert.equal(report.rubricGroups[0].comparableWorkEvaluations, 1);
  assert.equal(report.rubricGroups[0].comparableTargetRuns, 1);
  assert.equal(report.status, "insufficient_evidence");
});

test("rubric versions remain separate and are never averaged", async () => {
  const first = await fixture("stensibly-work-evaluation-repair-v1.json");
  const second = nextWork(first, { rubricVersion: "stensibly-review-v2" });
  const report = buildEvaluationProjection({
    events: [observationLedgerRecord(first), observationLedgerRecord(second)],
    repository,
    taskClass,
  });

  assert.equal(report.status, "insufficient_evidence");
  assert.deepEqual(report.rubricGroups.map((group) => [
    group.rubricVersion,
    group.comparableWorkEvaluations,
    group.status,
  ]), [
    ["stensibly-review-v1", 1, "insufficient_evidence"],
    ["stensibly-review-v2", 1, "insufficient_evidence"],
  ]);
  assert.ok(report.limitations.some((entry) => entry.code === "SMALL_SAMPLE"));
  assert.ok(report.limitations.some((entry) => entry.code === "MIXED_RUBRICS"));
});

test("review dispositions remain individually inspectable", async () => {
  const base = await fixture("stensibly-review-finding-upheld-v1.json");
  const dispositions = ["unresolved", "upheld-repair-required", "rejected", "superseded"];
  const events = dispositions.map((disposition, index) =>
    observationLedgerRecord(nextFinding(base, disposition, index))
  );
  const report = buildEvaluationProjection({ events, repository, taskClass });

  assert.equal(report.receipts.reviewFindings, 4);
  assert.equal(report.receipts.currentReviewFindings, 4);
  assert.equal(report.reviewerCalibration.length, 1);
  assert.equal(report.reviewerCalibration[0].findingReceiptCount, 4);
  assert.equal(report.reviewerCalibration[0].findingCount, 4);
  assert.deepEqual(report.reviewerCalibration[0].dispositions, dispositions
    .sort()
    .map((value) => ({ value, count: 1 })));
  assert.deepEqual(report.openFindings.map((finding) => finding.disposition), [
    "unresolved",
    "upheld-repair-required",
  ]);
});

test("later finding dispositions clear stale open state while retaining history", async () => {
  const base = await fixture("stensibly-review-finding-upheld-v1.json");
  const unresolved = nextFinding(base, "unresolved", 0);
  const rejected = clone(unresolved);
  rejected.id = "stensibly.pr308.review-finding.rejected.latest.v1";
  rejected.time = "2026-07-27T12:30:00.000Z";
  rejected.data.observedAt = "2026-07-27T12:31:00.000Z";
  rejected.data.ingestedAt = "2026-07-27T12:50:00.000Z";
  setFact(rejected, "proofwake.review.disposition", "rejected");

  const report = buildEvaluationProjection({
    events: [observationLedgerRecord(rejected), observationLedgerRecord(unresolved)],
    repository,
    taskClass,
  });

  assert.equal(report.receipts.reviewFindings, 2);
  assert.equal(report.receipts.currentReviewFindings, 1);
  const reviewer = report.reviewerCalibration[0];
  assert.equal(reviewer.findingReceiptCount, 2);
  assert.equal(reviewer.findingCount, 1);
  assert.equal(reviewer.findingHistory.length, 2);
  assert.deepEqual(reviewer.dispositions, [{ value: "rejected", count: 1 }]);
  assert.equal(reviewer.findings[0].receipt.id, rejected.id);
  assert.equal(report.openFindings.length, 0);
});

test("invalid wrappers and specialised receipts are excluded without disclosing content", async () => {
  const work = await fixture("stensibly-work-evaluation-repair-v1.json");
  const valid = observationLedgerRecord(work);
  const badFingerprint = clone(valid);
  badFingerprint.requestFingerprint = `sha256:${"0".repeat(64)}`;
  const badIdentity = clone(valid);
  badIdentity.id = "proofwake_observation_wrong";
  const extraWrapper = clone(valid);
  extraWrapper.hiddenPayload = "private-wrapper-sentinel";
  const unknown = clone(work);
  unknown.id = "stensibly.pr308.work-evaluation.unknown-fact.v1";
  unknown.data.facts.push({
    name: "proofwake.evaluation.prompt",
    value: "private-content-sentinel",
  });
  const badSpecialised = observationLedgerRecord(unknown);

  const report = buildEvaluationProjection({
    events: [valid, badFingerprint, badIdentity, extraWrapper, badSpecialised],
    repository,
    taskClass,
  });
  assert.equal(report.receipts.selected, 1);
  assert.equal(report.receipts.excluded, 4);
  assert.deepEqual(report.receipts.excludedByCode, [
    { value: "EVALUATION_LEDGER_FINGERPRINT_MISMATCH", count: 1 },
    { value: "EVALUATION_LEDGER_IDENTITY_MISMATCH", count: 1 },
    { value: "EVALUATION_LEDGER_WRAPPER_MISMATCH", count: 1 },
    { value: "EVALUATION_UNKNOWN_FACT", count: 1 },
  ]);
  const publicOutput = JSON.stringify(report);
  assert.equal(publicOutput.includes("private-content-sentinel"), false);
  assert.equal(publicOutput.includes("private-wrapper-sentinel"), false);
  assert.equal(publicOutput.includes("proofwake.evaluation.prompt"), false);
});

test("duplicate canonical ledger records are all excluded and cannot choose a winner", async () => {
  const work = await fixture("stensibly-work-evaluation-repair-v1.json");
  const record = observationLedgerRecord(work);
  const report = buildEvaluationProjection({
    events: [record, clone(record)],
    repository,
    taskClass,
  });

  assert.equal(report.receipts.selected, 0);
  assert.equal(report.receipts.excluded, 2);
  assert.deepEqual(report.receipts.excludedByCode, [
    { value: "EVALUATION_LEDGER_DUPLICATE_RECORD", count: 2 },
  ]);
  assert.equal(report.status, "insufficient_evidence");
});

test("projection rebuild is deterministic under ledger and object-key reordering", async () => {
  const work = await fixture("stensibly-work-evaluation-repair-v1.json");
  const review = await fixture("stensibly-review-finding-upheld-v1.json");
  const second = nextWork(work);
  const invalid = observationLedgerRecord(work);
  invalid.hiddenPayload = "not-disclosed";
  const reorderedInvalid = Object.fromEntries(Object.entries(invalid).reverse());
  const events = [
    observationLedgerRecord(work),
    observationLedgerRecord(review),
    observationLedgerRecord(second),
    invalid,
  ];
  const reversed = [
    reorderedInvalid,
    observationLedgerRecord(second),
    observationLedgerRecord(review),
    observationLedgerRecord(work),
  ];
  const forward = buildEvaluationProjection({ events, repository, taskClass });
  const reverse = buildEvaluationProjection({ events: reversed, repository, taskClass });
  assert.deepEqual(reverse, forward);
});

test("installed evaluation CLI preserves the ledger and has human/JSON evidence parity", async () => {
  await temporary(async (directory) => {
    const dataPath = join(directory, "private-ledger-name.jsonl");
    const work = await fixture("stensibly-work-evaluation-repair-v1.json");
    const review = await fixture("stensibly-review-finding-upheld-v1.json");
    const records = [observationLedgerRecord(work), observationLedgerRecord(review)];
    const original = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    await writeFile(dataPath, original);

    let result = await runProcess(process.execPath, [
      main,
      "evaluation",
      "--repo", repository,
      "--task-class", taskClass,
      "--data", dataPath,
      "--output", "json",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.command, "evaluation");
    assert.equal(json.status, "insufficient_evidence");
    assert.equal(json.receipts.selected, 2);
    assert.equal(json.receipts.currentWorkMarks, 1);
    assert.equal(json.receipts.currentReviewFindings, 1);
    assert.equal(result.stdout.includes(dataPath), false);

    result = await runProcess(process.execPath, [
      main,
      "evaluation",
      "--repo", repository,
      "--task-class", taskClass,
      "--data", dataPath,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Status: insufficient_evidence/u);
    assert.match(result.stdout, /Work: 1 receipts; 1 current marks/u);
    assert.match(result.stdout, /Review: 1 receipts; 1 current findings/u);
    assert.match(result.stdout, /classification repair-required: 1/u);
    assert.match(result.stdout, /confidence high: 1/u);
    assert.match(result.stdout, /uncertainty bounded: 1/u);
    assert.match(result.stdout, /Open findings: 1/u);
    assert.match(result.stdout, /Selected-receipt coverage:/u);
    assert.match(result.stdout, /Current-evidence coverage:/u);
    assert.equal(result.stdout.includes(dataPath), false);
    assert.equal(await readFile(dataPath, "utf8"), original);
  });
});

test("evaluation CLI returns bounded path-free storage errors and help", async () => {
  await temporary(async (directory) => {
    const dataPath = join(directory, "do-not-disclose-this-ledger.jsonl");
    await writeFile(dataPath, "{not-json}\n");
    const result = await runProcess(process.execPath, [
      main,
      "evaluation",
      "--repo", repository,
      "--task-class", taskClass,
      "--data", dataPath,
      "--output", "json",
    ]);
    assert.equal(result.code, 1);
    const response = JSON.parse(result.stdout);
    assert.equal(response.error.code, "EVALUATION_COMMAND_FAILED");
    assert.equal(result.stdout.includes(dataPath), false);
    assert.equal(result.stdout.includes("not-json"), false);
  });

  const help = await runProcess(process.execPath, [main, "evaluation", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Proofwake evaluation evidence/u);
});
