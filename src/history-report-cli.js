import { dirname, join, resolve } from "node:path";
import { buildFailureReport, buildRecoveryReport } from "./history-reports.js";
import { resolveStorageIdentity } from "./identity.js";
import { RepositoryRegistryStore } from "./repository-registry.js";
import { JsonlEventStore } from "./store.js";

export class HistoryReportCliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "HistoryReportCliUsageError";
    this.code = "HISTORY_REPORT_CLI_USAGE";
  }
}

function requiredValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new HistoryReportCliUsageError(`${name} requires a value.`);
  return value;
}

function requestedOutput(args) {
  return args.some((value, index) => value === "--output" && args[index + 1] === "json") ? "json" : "human";
}

function help() {
  return `Proofwake failure and recovery reports

  failures [--days 1..365] [--registry PATH] [--data PATH] [--output human|json]
  recoveries [--days 1..365] [--registry PATH] [--data PATH] [--output human|json]

Reports use a rolling observed-time window and include policy-matched accepted evidence only.
Recovery v1 reports explicit same-revision or same-subject reruns with sequence-only causality.`;
}

function parse(command, args) {
  const options = {
    days: 30,
    registryPath: undefined,
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
    if (!["--days", "--registry", "--data", "--output"].includes(value)) {
      throw new HistoryReportCliUsageError(`Unknown ${command} argument: ${value}`);
    }
    if (seen.has(value)) throw new HistoryReportCliUsageError(`${value} may be supplied once.`);
    seen.add(value);
    const next = requiredValue(args, index, value);
    index += 1;
    if (value === "--days") {
      if (!/^\d+$/u.test(next)) throw new HistoryReportCliUsageError("--days must be an integer between 1 and 365.");
      options.days = Number(next);
      if (!Number.isSafeInteger(options.days) || options.days < 1 || options.days > 365) {
        throw new HistoryReportCliUsageError("--days must be an integer between 1 and 365.");
      }
    } else if (value === "--registry") options.registryPath = next;
    else if (value === "--data") options.dataPath = next;
    else {
      if (!new Set(["human", "json"]).has(next)) throw new HistoryReportCliUsageError("--output must be human or json.");
      options.output = next;
    }
  }
  return options;
}

function errorDetails(error) {
  const details = {
    code: typeof error?.code === "string" ? error.code : "HISTORY_REPORT_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
  if (typeof error?.path === "string") details.path = error.path;
  return details;
}

function printWarnings(warnings) {
  for (const warning of [...new Set(warnings)]) console.error(`Proofwake compatibility: ${warning}`);
}

function printFailures(report) {
  console.log(`Proofwake failures — ${report.window.days} days — ${report.summary.total}`);
  console.log(`Unresolved ${report.summary.unresolved}; resolved ${report.summary.resolved}; repositories ${report.summary.repositories}`);
  console.log(`Cursor: ${report.sourceCursor}`);
  for (const failure of report.failures) {
    console.log("");
    console.log(`${failure.repository} — ${failure.kind} — ${failure.status}`);
    console.log(`  revision ${failure.revision ? failure.revision.slice(0, 12) : "—"}`);
    console.log(`  observed ${failure.observedAt}`);
    console.log(`  policy ${failure.policy.requirement} / ${failure.policy.appliesTo}`);
    console.log(failure.unresolved
      ? "  unresolved"
      : `  resolved by ${failure.resolvedBy.source}#${failure.resolvedBy.id} at ${failure.resolvedBy.observedAt}`);
  }
  if (report.truncated) console.log("\nOutput truncated to 500 entries.");
}

function duration(value) {
  if (value === null) return "—";
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`;
  return `${Math.round(value / 3_600_000)}h`;
}

function printRecoveries(report) {
  console.log(`Proofwake recoveries — ${report.window.days} days — ${report.summary.total}`);
  console.log(`Repositories ${report.summary.repositories}; median source interval ${duration(report.summary.medianSourceIntervalMs)}`);
  console.log(`Cursor: ${report.sourceCursor}`);
  for (const recovery of report.recoveries) {
    console.log("");
    console.log(`${recovery.repository} — ${recovery.kind} — ${recovery.type}`);
    console.log(`  revision ${recovery.revision ? recovery.revision.slice(0, 12) : "—"}`);
    console.log(`  ${recovery.from.status} ${recovery.from.id} → passed ${recovery.to.id}`);
    console.log(`  source interval ${duration(recovery.sourceIntervalMs)}; causality ${recovery.causality}`);
  }
  if (report.truncated) console.log("\nOutput truncated to 500 entries.");
}

async function run(command, args) {
  const output = requestedOutput(args);
  let warnings = [];
  try {
    const options = parse(command, args);
    if (options.help) {
      console.log(help());
      return;
    }
    const storage = await resolveStorageIdentity({ explicitDataPath: options.dataPath });
    warnings = [...new Set(storage.warnings)];
    const registryPath = resolve(options.registryPath ?? join(dirname(storage.dataPath), "repositories.json"));
    const report = command === "failures"
      ? await buildFailureReport({
        registryStore: new RepositoryRegistryStore(registryPath),
        eventStore: new JsonlEventStore(storage.dataPath),
        days: options.days,
      })
      : await buildRecoveryReport({
        registryStore: new RepositoryRegistryStore(registryPath),
        eventStore: new JsonlEventStore(storage.dataPath),
        days: options.days,
      });
    const response = { ...report, warnings };
    if (options.output === "json") console.log(JSON.stringify(response, null, 2));
    else {
      printWarnings(warnings);
      if (command === "failures") printFailures(response);
      else printRecoveries(response);
    }
  } catch (error) {
    const response = {
      service: "proofwake",
      command,
      status: "error",
      error: errorDetails(error),
      warnings,
    };
    if (output === "json") console.log(JSON.stringify(response, null, 2));
    else {
      printWarnings(warnings);
      const path = response.error.path ? ` (${response.error.path})` : "";
      console.error(`Proofwake ${command}: ${response.error.code}: ${response.error.message}${path}`);
      console.error(help());
    }
    process.exitCode = error instanceof HistoryReportCliUsageError ? 2 : 1;
  }
}

export async function runFailuresCommand(args) {
  await run("failures", args);
}

export async function runRecoveriesCommand(args) {
  await run("recoveries", args);
}
