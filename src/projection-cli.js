import { dirname, join, resolve } from "node:path";
import { buildFleetProjection } from "./fleet-projection.js";
import { resolveStorageIdentity } from "./identity.js";
import { RepositoryRegistryStore } from "./repository-registry.js";
import { buildRevisionProjection } from "./revision-projection.js";
import { JsonlEventStore } from "./store.js";

export class ProjectionCliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProjectionCliUsageError";
    this.code = "PROJECTION_CLI_USAGE";
  }
}

function requiredValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new ProjectionCliUsageError(`${name} requires a value.`);
  return value;
}

function outputMode(args) {
  return args.some((value, index) => value === "--output" && args[index + 1] === "json") ? "json" : "human";
}

function commonHelp() {
  return `Proofwake evidence projections

  inspect [REVISION] --repo owner/name [--registry PATH] [--data PATH]
                     [--output human|json]
  fleet [--registry PATH] [--data PATH] [--output human|json]

Inspect explains every declared signal for one selected revision. Fleet reports current
repository state and attention reasons without producing a score.`;
}

function parseInspect(args) {
  const options = {
    repository: undefined,
    revision: undefined,
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
    if (["--repo", "--revision", "--registry", "--data", "--output"].includes(value)) {
      if (seen.has(value)) throw new ProjectionCliUsageError(`${value} may be supplied once.`);
      seen.add(value);
      const next = requiredValue(args, index, value);
      index += 1;
      if (value === "--repo") options.repository = next;
      else if (value === "--revision") options.revision = next;
      else if (value === "--registry") options.registryPath = next;
      else if (value === "--data") options.dataPath = next;
      else {
        if (next !== "human" && next !== "json") throw new ProjectionCliUsageError("--output must be human or json.");
        options.output = next;
      }
      continue;
    }
    if (value.startsWith("--")) throw new ProjectionCliUsageError(`Unknown inspect argument: ${value}`);
    if (options.revision !== undefined) throw new ProjectionCliUsageError("inspect accepts one positional revision.");
    options.revision = value;
  }
  if (!options.help && !options.repository) throw new ProjectionCliUsageError("inspect requires --repo owner/name.");
  return options;
}

function parseFleet(args) {
  const options = { registryPath: undefined, dataPath: undefined, output: "human", help: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--help" || value === "-h") {
      options.help = true;
      continue;
    }
    if (!["--registry", "--data", "--output"].includes(value)) {
      throw new ProjectionCliUsageError(`Unknown fleet argument: ${value}`);
    }
    if (seen.has(value)) throw new ProjectionCliUsageError(`${value} may be supplied once.`);
    seen.add(value);
    const next = requiredValue(args, index, value);
    index += 1;
    if (value === "--registry") options.registryPath = next;
    else if (value === "--data") options.dataPath = next;
    else {
      if (next !== "human" && next !== "json") throw new ProjectionCliUsageError("--output must be human or json.");
      options.output = next;
    }
  }
  return options;
}

function errorDetails(error) {
  const details = {
    code: typeof error?.code === "string" ? error.code : "PROJECTION_COMMAND_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
  if (typeof error?.path === "string") details.path = error.path;
  return details;
}

async function resolveStores(options) {
  const storage = await resolveStorageIdentity({ explicitDataPath: options.dataPath });
  const registryPath = resolve(options.registryPath ?? join(dirname(storage.dataPath), "repositories.json"));
  return {
    storage,
    registryPath,
    registryStore: new RepositoryRegistryStore(registryPath),
    eventStore: new JsonlEventStore(storage.dataPath),
  };
}

function printWarnings(warnings) {
  for (const warning of [...new Set(warnings)]) console.error(`Proofwake compatibility: ${warning}`);
}

function printInspect(report) {
  const revision = report.selectedRevision.slice(0, 12);
  console.log(`${report.repository.label} — ${revision} — ${report.status}`);
  console.log(`Revision: ${report.revision.confidence}; ${report.revision.relationToCheckout}`);
  console.log(`Policy: ${report.configuration.source} (${report.configuration.fingerprint})`);
  console.log(`Cursor: ${report.sourceCursor}`);
  for (const signal of report.signals) {
    console.log("");
    console.log(`${signal.policy.requirement === "required" ? "required" : "optional"} ${signal.policy.kind} — ${signal.state}`);
    console.log(`  ${signal.reason}`);
    console.log(`  attempts ${signal.attempts}; reruns ${signal.reruns}`);
    if (signal.latest) console.log(`  latest ${signal.latest.source}#${signal.latest.id} at ${signal.latest.observedAt}`);
    if (signal.recovery) console.log(`  recovery ${signal.recovery.type} from ${signal.recovery.from.id} to ${signal.recovery.to.id}`);
  }
  if (report.attention) {
    console.log("");
    console.log(`Attention: ${report.attention.reason}`);
  }
}

function printFleet(report) {
  console.log(`Proofwake fleet — ${report.summary.total}`);
  console.log(`Green ${report.summary.green}; red ${report.summary.red}; yellow ${report.summary.yellow}; grey ${report.summary.grey}`);
  console.log(`Cursor: ${report.sourceCursor}`);
  for (const repository of report.repositories) {
    console.log("");
    console.log(`${repository.repository.label} — ${repository.status} / ${repository.classification}`);
    console.log(`  revision ${repository.selectedRevision ? repository.selectedRevision.slice(0, 12) : "—"}`);
    if (repository.currentFailure) console.log(`  failing ${repository.currentFailure.signal}: ${repository.currentFailure.reason}`);
    else if (repository.missingOrStale) console.log(`  ${repository.missingOrStale.state} ${repository.missingOrStale.signal}: ${repository.missingOrStale.reason}`);
    if (repository.recentRecovery) console.log(`  recovery ${repository.recentRecovery.type} at ${repository.recentRecovery.to.observedAt}`);
    if (repository.attention) console.log(`  attention ${repository.attention.reason}`);
  }
}

async function runProjectionCommand(command, args) {
  const requested = outputMode(args);
  let warnings = [];
  try {
    const options = command === "inspect" ? parseInspect(args) : parseFleet(args);
    if (options.help) {
      console.log(commonHelp());
      return;
    }
    const resolved = await resolveStores(options);
    warnings = [...new Set(resolved.storage.warnings)];
    const report = command === "inspect"
      ? await buildRevisionProjection({
        repository: options.repository,
        revision: options.revision,
        registryStore: resolved.registryStore,
        eventStore: resolved.eventStore,
      })
      : await buildFleetProjection({
        registryStore: resolved.registryStore,
        eventStore: resolved.eventStore,
      });
    const response = { ...report, registryPath: resolved.registryPath, warnings };
    if (options.output === "json") console.log(JSON.stringify(response, null, 2));
    else {
      printWarnings(warnings);
      if (command === "inspect") printInspect(response);
      else printFleet(response);
    }
  } catch (error) {
    const response = {
      service: "proofwake",
      command,
      status: "error",
      error: errorDetails(error),
      warnings,
    };
    if (requested === "json") console.log(JSON.stringify(response, null, 2));
    else {
      printWarnings(warnings);
      const path = response.error.path ? ` (${response.error.path})` : "";
      console.error(`Proofwake ${command}: ${response.error.code}: ${response.error.message}${path}`);
      console.error(commonHelp());
    }
    process.exitCode = 1;
  }
}

export async function runInspectCommand(args) {
  await runProjectionCommand("inspect", args);
}

export async function runFleetCommand(args) {
  await runProjectionCommand("fleet", args);
}
