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

function printHuman(report) {
  console.log(`Proofwake evaluation — ${report.selection.repository} — ${report.selection.taskClass}`);
  console.log(`Status: ${report.status}`);
  if (report.selection.targetRun) console.log(`Target run: ${report.selection.targetRun}`);
  console.log(`Receipts: ${report.receipts.selected} selected; ${report.receipts.excluded} excluded`);
  console.log(`Work evaluations: ${report.receipts.workEvaluations}; review findings: ${report.receipts.reviewFindings}`);
  console.log(`Cursor: ${report.sourceCursor}`);

  for (const group of report.rubricGroups) {
    console.log("");
    console.log(`Rubric ${group.rubricVersion} — ${group.status}`);
    console.log(`  comparable work evaluations ${group.comparableWorkEvaluations}`);
    console.log(`  target runs ${group.targetRunCount}; evaluator runs ${group.evaluatorRunCount}`);
    console.log(`  repairs ${group.repairCountTotal}`);
    for (const classification of group.classifications) {
      console.log(`  classification ${classification.value}: ${classification.count}`);
    }
  }

  for (const reviewer of report.reviewerCalibration) {
    console.log("");
    console.log(`Evaluator ${reviewer.evaluatorRun} / ${reviewer.rubricVersion}`);
    console.log(`  findings ${reviewer.findingCount}`);
    for (const disposition of reviewer.dispositions) {
      console.log(`  disposition ${disposition.value}: ${disposition.count}`);
    }
  }

  if (report.openFindings.length > 0) {
    console.log("");
    console.log(`Open findings: ${report.openFindings.length}`);
    for (const finding of report.openFindings) {
      console.log(`  ${finding.findingId} — ${finding.disposition} — ${finding.severity}`);
    }
  }

  if (report.coverage.omissions.length > 0) {
    console.log("");
    console.log("Coverage omissions:");
    for (const omission of report.coverage.omissions) {
      console.log(`  ${omission.value}: ${omission.count}`);
    }
  }

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
