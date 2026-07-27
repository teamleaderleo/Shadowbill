import { buildEvaluationProjection, EvaluationProjectionError } from "./evaluation-projection.js";
import { resolveStorageIdentity } from "./identity.js";
import { JsonlEventStore } from "./store.js";

export class EvaluationCliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvaluationCliUsageError";
    this.code = "EVALUATION_CLI_USAGE";
  }
}

function help() {
  return `Proofwake evaluation evidence

  evaluation --repo owner/name --task-class TOKEN [--target-run run_...]
             [--data PATH] [--output human|json]

Builds one read-only task-specific evidence view. Rubric versions remain separate,
missing evidence is not counted as negative evidence, and sparse samples return
insufficient_evidence rather than a score.`;
}

function requiredValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new EvaluationCliUsageError(`${name} requires a value.`);
  }
  return value;
}

function requestedOutput(args) {
  return args.some((value, index) => value === "--output" && args[index + 1] === "json")
    ? "json"
    : "human";
}

function parseArguments(args) {
  const options = {
    repository: undefined,
    taskClass: undefined,
    targetRun: undefined,
    dataPath: undefined,
    output: "human",
    help: false,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--help" || value === "-h") {
      options.help = true;
      continue;
    }
    if (!["--repo", "--task-class", "--target-run", "--data", "--output"].includes(value)) {
      throw new EvaluationCliUsageError(`Unknown evaluation argument: ${value}`);
    }
    if (seen.has(value)) throw new EvaluationCliUsageError(`${value} may be supplied once.`);
    seen.add(value);
    const next = requiredValue(args, index, value);
    index += 1;
    if (value === "--repo") options.repository = next;
    else if (value === "--task-class") options.taskClass = next;
    else if (value === "--target-run") options.targetRun = next;
    else if (value === "--data") options.dataPath = next;
    else {
      if (next !== "human" && next !== "json") {
        throw new EvaluationCliUsageError("--output must be human or json.");
      }
      options.output = next;
    }
  }
  if (!options.help && !options.repository) {
    throw new EvaluationCliUsageError("evaluation requires --repo owner/name.");
  }
  if (!options.help && !options.taskClass) {
    throw new EvaluationCliUsageError("evaluation requires --task-class TOKEN.");
  }
  return options;
}

function warningCodes(storage) {
  const warnings = [];
  if (storage.compatibilityMode) warnings.push("LEGACY_LEDGER_COMPATIBILITY");
  if (storage.warnings.some((warning) => warning.includes("SHADOWBILL_"))) {
    warnings.push("LEGACY_ENVIRONMENT_ALIAS");
  }
  return [...new Set(warnings)];
}

function errorDetails(error) {
  if (error instanceof EvaluationCliUsageError || error instanceof EvaluationProjectionError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "EVALUATION_COMMAND_FAILED",
    message: "Evaluation projection could not be built from the selected ledger.",
  };
}

function printCounts(label, entries, indent = "  ") {
  for (const entry of entries) console.log(`${indent}${label} ${String(entry.value)}: ${entry.count}`);
}

function printCoverage(label, coverage) {
  console.log(`${label}:`);
  printCounts("state", coverage.states, "  ");
  console.log(`  redacted receipts: ${coverage.redactedReceipts}`);
  console.log(`  truncated receipts: ${coverage.truncatedReceipts}`);
  printCounts("omission", coverage.omissions, "  ");
}

function printHuman(report) {
  console.log(`Proofwake evaluation — ${report.selection.repository} — ${report.selection.taskClass}`);
  console.log(`Status: ${report.status}`);
  if (report.selection.targetRun) console.log(`Target run: ${report.selection.targetRun}`);
  console.log(`Receipts: ${report.receipts.selected} selected; ${report.receipts.excluded} excluded`);
  console.log(`Work: ${report.receipts.workEvaluations} receipts; ${report.receipts.currentWorkMarks} current marks`);
  console.log(`Review: ${report.receipts.reviewFindings} receipts; ${report.receipts.currentReviewFindings} current findings`);
  printCounts("excluded", report.receipts.excludedByCode, "");
  console.log(`Cursor: ${report.sourceCursor}`);

  for (const target of report.targets) {
    console.log("");
    console.log(`Target ${target.targetRun}`);
    console.log(`  work receipts ${target.workEvaluationReceipts}; current marks ${target.currentWorkMarks}`);
    console.log(`  review receipts ${target.reviewFindingReceipts}; current findings ${target.currentReviewFindings}`);
    if (target.callsigns.length > 0) console.log(`  callsigns ${target.callsigns.join(", ")}`);
    if (target.modelProfiles.length > 0) console.log(`  model profiles ${target.modelProfiles.join(", ")}`);
    if (target.adapterProfiles.length > 0) console.log(`  adapter profiles ${target.adapterProfiles.join(", ")}`);
  }

  for (const group of report.rubricGroups) {
    console.log("");
    console.log(`Rubric ${group.rubricVersion} — ${group.status}`);
    console.log(`  work receipts ${group.workEvaluationReceipts}; current marks ${group.currentWorkMarks}`);
    console.log(`  comparable marks ${group.comparableWorkEvaluations}; distinct target runs ${group.comparableTargetRuns}`);
    console.log(`  target runs ${group.targetRunCount}; evaluator runs ${group.evaluatorRunCount}`);
    console.log(`  repairs ${group.repairCountTotal}`);
    printCounts("classification", group.classifications);
    printCounts("severity", group.severities);
    printCounts("accepted first pass", group.acceptedFirstPass);
    printCounts("confidence", group.confidence);
    printCounts("uncertainty", group.uncertainty);
    printCounts("evidence class", group.evidenceClasses);
    printCounts("independence", group.independence);
    for (const facet of group.facets) {
      console.log(`  facet ${facet.facet}: ${facet.count}`);
      printCounts("classification", facet.classifications, "    ");
      printCounts("severity", facet.severities, "    ");
    }
    for (const mark of group.marks) {
      console.log(`  mark ${mark.targetRun} / ${mark.evaluatorRun} / ${mark.facet}`);
      console.log(`    ${mark.classification}; severity ${mark.severity}; confidence ${mark.confidence}; uncertainty ${mark.uncertainty}`);
      console.log(`    accepted first pass ${mark.acceptedFirstPass}; repairs ${mark.repairCount}; receipt ${mark.receipt.id}`);
    }
    printCoverage("  current coverage", group.coverage);
  }

  for (const reviewer of report.reviewerCalibration) {
    console.log("");
    console.log(`Evaluator ${reviewer.evaluatorRun} / ${reviewer.rubricVersion}`);
    console.log(`  finding receipts ${reviewer.findingReceiptCount}; current findings ${reviewer.findingCount}`);
    if (reviewer.callsigns.length > 0) console.log(`  callsigns ${reviewer.callsigns.join(", ")}`);
    printCounts("disposition", reviewer.dispositions);
    printCounts("severity", reviewer.severities);
    printCounts("confidence", reviewer.confidence);
    printCounts("uncertainty", reviewer.uncertainty);
    for (const finding of reviewer.findings) {
      console.log(`  finding ${finding.targetRun} / ${finding.findingId}`);
      console.log(`    ${finding.disposition}; severity ${finding.severity}; confidence ${finding.confidence}; uncertainty ${finding.uncertainty}`);
      console.log(`    clearing ${finding.clearingCondition}; receipt ${finding.receipt.id}`);
    }
    printCoverage("  current coverage", reviewer.coverage);
  }

  if (report.openFindings.length > 0) {
    console.log("");
    console.log(`Open findings: ${report.openFindings.length}`);
    for (const finding of report.openFindings) {
      console.log(`  ${finding.findingId} — ${finding.disposition} — ${finding.severity}`);
    }
  }

  console.log("");
  printCoverage("Selected-receipt coverage", report.coverage.selectedReceipts);
  printCoverage("Current-evidence coverage", report.coverage.currentEvidence);

  if (report.limitations.length > 0) {
    console.log("");
    console.log("Limitations:");
    for (const limitation of report.limitations) {
      console.log(`  ${limitation.code}: ${limitation.message}`);
    }
  }
}

export async function runEvaluationCommand(args) {
  const output = requestedOutput(args);
  let warnings = [];
  try {
    const options = parseArguments(args);
    if (options.help) {
      console.log(help());
      return;
    }
    const storage = await resolveStorageIdentity({ explicitDataPath: options.dataPath });
    warnings = warningCodes(storage);
    const events = await new JsonlEventStore(storage.dataPath).readAll();
    const report = buildEvaluationProjection({
      events,
      repository: options.repository,
      taskClass: options.taskClass,
      targetRun: options.targetRun,
    });
    const response = {
      service: "proofwake",
      command: "evaluation",
      ...report,
      warnings,
    };
    if (options.output === "json") console.log(JSON.stringify(response, null, 2));
    else {
      for (const warning of warnings) console.error(`Proofwake compatibility: ${warning}`);
      printHuman(response);
    }
  } catch (error) {
    const response = {
      service: "proofwake",
      command: "evaluation",
      status: "error",
      error: errorDetails(error),
      warnings,
    };
    if (output === "json") console.log(JSON.stringify(response, null, 2));
    else {
      for (const warning of warnings) console.error(`Proofwake compatibility: ${warning}`);
      console.error(`Proofwake evaluation: ${response.error.code}: ${response.error.message}`);
      console.error(help());
    }
    process.exitCode = 1;
  }
}
