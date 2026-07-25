import { dirname, join, resolve } from "node:path";
import { resolveStorageIdentity } from "./identity.js";
import { inspectRepositoryEnrollment } from "./repository-enrollment.js";
import { buildRepositoryInventory } from "./repository-inventory.js";
import { RepositoryRegistryStore } from "./repository-registry.js";
import { JsonlEventStore } from "./store.js";

class RepositoryUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "RepositoryUsageError";
    this.code = "PROOFWAKE_REPOSITORY_USAGE";
  }
}

function usage(command) {
  return command === "enroll"
    ? "proofwake enroll PATH [--dry-run] [--replace] [--repository owner/name] [--lifecycle active|dormant] [--registry PATH] [--data PATH] [--output human|json]"
    : "proofwake repositories [--registry PATH] [--data PATH] [--output human|json]";
}

function requestedOutput(args) {
  return args.includes("--json") || args.some((value, index) => value === "--output" && args[index + 1] === "json")
    ? "json"
    : "human";
}

function parseArguments(command, args) {
  const options = {
    output: "human",
    outputSet: false,
    dataPath: undefined,
    registryPath: undefined,
    repository: undefined,
    lifecycle: undefined,
    dryRun: false,
    replace: false,
    paths: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--dry-run" || value === "--replace") {
      if (command !== "enroll") throw new RepositoryUsageError(`${value} is only valid with enroll.`);
      const key = value === "--dry-run" ? "dryRun" : "replace";
      if (options[key]) throw new RepositoryUsageError(`${value} may be supplied once.`);
      options[key] = true;
      continue;
    }
    if (value === "--json") {
      if (options.outputSet) throw new RepositoryUsageError("Choose one output option.");
      options.output = "json";
      options.outputSet = true;
      continue;
    }
    if (["--output", "--data", "--registry", "--repository", "--lifecycle"].includes(value)) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new RepositoryUsageError(`${value} requires a value.`);
      index += 1;
      if (value === "--output") {
        if (options.outputSet) throw new RepositoryUsageError("Choose one output option.");
        if (!["human", "json"].includes(next)) throw new RepositoryUsageError("--output must be human or json.");
        options.output = next;
        options.outputSet = true;
      } else if (value === "--data") {
        if (options.dataPath !== undefined) throw new RepositoryUsageError("--data may be supplied once.");
        options.dataPath = next;
      } else if (value === "--registry") {
        if (options.registryPath !== undefined) throw new RepositoryUsageError("--registry may be supplied once.");
        options.registryPath = next;
      } else if (value === "--repository") {
        if (command !== "enroll") throw new RepositoryUsageError("--repository is only valid with enroll.");
        if (options.repository !== undefined) throw new RepositoryUsageError("--repository may be supplied once.");
        options.repository = next;
      } else {
        if (command !== "enroll") throw new RepositoryUsageError("--lifecycle is only valid with enroll.");
        if (options.lifecycle !== undefined) throw new RepositoryUsageError("--lifecycle may be supplied once.");
        options.lifecycle = next;
      }
      continue;
    }
    if (value === "--help" || value === "-h") {
      options.help = true;
      continue;
    }
    if (value.startsWith("--")) throw new RepositoryUsageError(`Unknown argument: ${value}`);
    options.paths.push(value);
  }
  if (!options.help) {
    if (command === "enroll" && options.paths.length !== 1) throw new RepositoryUsageError("enroll requires exactly one repository path.");
    if (command === "repositories" && options.paths.length !== 0) throw new RepositoryUsageError("repositories accepts no positional paths.");
  }
  return options;
}

function uniqueWarnings(values) {
  return [...new Set(values)];
}

function errorDetails(error) {
  const result = {
    code: typeof error?.code === "string" ? error.code : "PROOFWAKE_REPOSITORY_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
  if (typeof error?.path === "string") result.path = error.path;
  return result;
}

function printWarnings(warnings) {
  for (const warning of uniqueWarnings(warnings)) console.error(`Proofwake: ${warning}`);
}

function printEnrollment(result, dryRun) {
  const proposal = result.proposal;
  console.log(`${dryRun ? "Proposed" : "Enrolled"} ${proposal.repository}`);
  console.log(`Root: ${proposal.root}`);
  console.log(`Configuration: ${proposal.configuration.source}${proposal.configuration.path ? ` (${proposal.configuration.path})` : ""}`);
  console.log(`Lifecycle: ${proposal.policy.lifecycle}`);
  console.log(`Signals: ${proposal.policy.expectedSignals.length}`);
  for (const signal of proposal.policy.expectedSignals) {
    console.log(`  ${signal.required ? "required" : "optional"} ${signal.kind} — ${signal.scope}, ${signal.staleAfterHours}h`);
  }
  const adapters = Object.entries(proposal.adapterReadiness);
  if (adapters.length > 0) {
    console.log("Adapters:");
    for (const [name, adapter] of adapters) console.log(`  ${name}: ${adapter.path} (${adapter.exists ? "present" : "missing"})`);
  }
  if (!dryRun) console.log(`Registry result: ${result.status}`);
}

function printInventory(report) {
  console.log(`Proofwake repositories — ${report.summary.total}`);
  console.log(`Active ${report.summary.active}, dormant ${report.summary.dormant}, unobserved ${report.summary.unobserved}, misconfigured ${report.summary.misconfigured}`);
  for (const repository of report.repositories) {
    console.log("");
    console.log(`${repository.repository} — ${repository.classification}, ${repository.health}`);
    console.log(`  Root: ${repository.root}`);
    console.log(`  Latest revision: ${repository.latestRevision ?? "—"}`);
    console.log(`  Latest activity: ${repository.latestActivityAt ?? "—"}`);
    console.log(`  Configuration: ${repository.configuration.source}`);
    if (repository.attentionReason) console.log(`  Attention: ${repository.attentionReason}`);
    for (const problem of repository.problems) console.log(`  [${problem.code}] ${problem.message}`);
    for (const signal of repository.signals) {
      console.log(`  ${signal.required ? "required" : "optional"} ${signal.kind}: ${signal.state}${signal.coverage ? `, ${signal.coverage} coverage` : ""}`);
    }
  }
}

export async function runRepositoryCommand(command, args) {
  const output = requestedOutput(args);
  let warnings = [];
  try {
    const options = parseArguments(command, args);
    if (options.help) {
      console.log(usage(command));
      return;
    }
    const storage = await resolveStorageIdentity({ explicitDataPath: options.dataPath });
    warnings = uniqueWarnings(storage.warnings);
    const registryPath = resolve(options.registryPath ?? join(dirname(storage.dataPath), "repositories.json"));
    const registryStore = new RepositoryRegistryStore(registryPath);

    if (command === "enroll") {
      const proposal = await inspectRepositoryEnrollment(options.paths[0], {
        repository: options.repository,
        lifecycle: options.lifecycle,
      });
      warnings = uniqueWarnings([...warnings, ...proposal.warnings]);
      const stored = options.dryRun
        ? { status: "proposal", entry: null }
        : await registryStore.enroll(proposal, { replace: options.replace });
      const response = {
        service: "proofwake",
        command: "enroll",
        status: stored.status,
        dryRun: options.dryRun,
        registryPath,
        proposal,
        warnings,
      };
      if (options.output === "json") console.log(JSON.stringify(response, null, 2));
      else {
        printWarnings(warnings);
        printEnrollment(response, options.dryRun);
      }
      return;
    }

    const report = await buildRepositoryInventory({
      registryStore,
      eventStore: new JsonlEventStore(storage.dataPath),
    });
    const response = { ...report, registryPath, warnings };
    if (options.output === "json") console.log(JSON.stringify(response, null, 2));
    else {
      printWarnings(warnings);
      printInventory(response);
    }
  } catch (error) {
    const response = {
      service: "proofwake",
      command,
      status: "error",
      error: errorDetails(error),
      warnings: uniqueWarnings(warnings),
    };
    if (output === "json") console.log(JSON.stringify(response, null, 2));
    else {
      printWarnings(response.warnings);
      const path = response.error.path ? ` (${response.error.path})` : "";
      console.error(`Proofwake ${command}: ${response.error.code}: ${response.error.message}${path}`);
      console.error(`Usage: ${usage(command)}`);
    }
    process.exitCode = 1;
  }
}
