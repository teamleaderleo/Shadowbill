import { dirname, join, resolve } from "node:path";
import { inspectRepositoryEnrollment } from "./repository-enrollment.js";
import { buildRepositoryInventory } from "./repository-inventory.js";
import { readRepositoryPolicyFile } from "./repository-policy-file.js";
import { RepositoryRegistryStore } from "./repository-registry.js";
import { resolveStorageIdentity } from "./identity.js";
import { JsonlEventStore } from "./store.js";

export class RepositoryCliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "RepositoryCliUsageError";
    this.code = "REPOSITORY_CLI_USAGE";
  }
}

function value(args, index, name) {
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) throw new RepositoryCliUsageError(`${name} requires a value.`);
  return next;
}

function outputMode(args) {
  return args.some((entry, index) => entry === "--output" && args[index + 1] === "json") ? "json" : "human";
}

function errorDetails(error) {
  const details = {
    code: typeof error?.code === "string" ? error.code : "REPOSITORY_COMMAND_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
  if (typeof error?.path === "string") details.path = error.path;
  return details;
}

function printWarnings(warnings) {
  for (const warning of [...new Set(warnings)]) console.error(`Proofwake: ${warning}`);
}

function parseEnroll(args) {
  const options = {
    root: undefined,
    policyPath: undefined,
    repository: undefined,
    lifecycle: undefined,
    registryPath: undefined,
    dataPath: undefined,
    output: "human",
    write: false,
    approveAutodetected: false,
    replace: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index];
    if (entry === "--help" || entry === "-h") { options.help = true; continue; }
    if (entry === "--write") { options.write = true; continue; }
    if (entry === "--approve-autodetected") { options.approveAutodetected = true; continue; }
    if (entry === "--replace") { options.replace = true; continue; }
    if (["--policy", "--repository", "--lifecycle", "--registry", "--data", "--output"].includes(entry)) {
      const next = value(args, index, entry);
      index += 1;
      if (entry === "--policy") options.policyPath = next;
      else if (entry === "--repository") options.repository = next;
      else if (entry === "--lifecycle") options.lifecycle = next;
      else if (entry === "--registry") options.registryPath = next;
      else if (entry === "--data") options.dataPath = next;
      else {
        if (!new Set(["human", "json"]).has(next)) throw new RepositoryCliUsageError("--output must be human or json.");
        options.output = next;
      }
      continue;
    }
    if (entry.startsWith("--")) throw new RepositoryCliUsageError(`Unknown enroll argument: ${entry}`);
    if (options.root !== undefined) throw new RepositoryCliUsageError("enroll accepts one repository path.");
    options.root = entry;
  }
  if (!options.help && options.root === undefined) throw new RepositoryCliUsageError("enroll requires a repository path.");
  if (options.approveAutodetected && !options.write) throw new RepositoryCliUsageError("--approve-autodetected requires --write.");
  if (options.replace && !options.write) throw new RepositoryCliUsageError("--replace requires --write.");
  return options;
}

function parseRepositories(args) {
  const options = { registryPath: undefined, dataPath: undefined, output: "human", help: false };
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index];
    if (entry === "--help" || entry === "-h") { options.help = true; continue; }
    if (["--registry", "--data", "--output"].includes(entry)) {
      const next = value(args, index, entry);
      index += 1;
      if (entry === "--registry") options.registryPath = next;
      else if (entry === "--data") options.dataPath = next;
      else {
        if (!new Set(["human", "json"]).has(next)) throw new RepositoryCliUsageError("--output must be human or json.");
        options.output = next;
      }
      continue;
    }
    throw new RepositoryCliUsageError(`Unknown repositories argument: ${entry}`);
  }
  return options;
}

function repositoryHelp() {
  return `Proofwake repository commands

  enroll PATH [--policy FILE] [--repository owner/name] [--lifecycle active|dormant]
              [--write] [--approve-autodetected] [--replace]
              [--registry PATH] [--data PATH] [--output human|json]
  repositories [--registry PATH] [--data PATH] [--output human|json]

Enrolment is a dry run unless --write is supplied. A tracked, clean .proofwake.json is
authoritative. --policy supplies an explicitly approved global policy. Autodetected policy
requires both --write and --approve-autodetected before registry persistence.`;
}

async function paths(options) {
  const storage = await resolveStorageIdentity({ explicitDataPath: options.dataPath });
  return {
    storage,
    registryPath: resolve(options.registryPath ?? join(dirname(storage.dataPath), "repositories.json")),
  };
}

export async function runEnrollCommand(args) {
  const requested = outputMode(args);
  let warnings = [];
  try {
    const options = parseEnroll(args);
    if (options.help) {
      console.log(repositoryHelp());
      return;
    }
    const resolved = await paths(options);
    warnings = [...resolved.storage.warnings];
    let globalPolicy;
    if (options.policyPath !== undefined) {
      globalPolicy = await readRepositoryPolicyFile(resolve(options.policyPath));
      if (!globalPolicy) throw new RepositoryCliUsageError("--policy file does not exist.");
    }
    const proposal = await inspectRepositoryEnrollment(options.root, {
      globalPolicy,
      repository: options.repository,
      lifecycle: options.lifecycle,
    });
    warnings.push(...proposal.warnings);
    let result = { status: "dry-run", entry: null };
    if (options.write) {
      result = await new RepositoryRegistryStore(resolved.registryPath).enroll(proposal, {
        replace: options.replace,
        approveAutodetected: options.approveAutodetected,
      });
    }
    const response = {
      service: "proofwake",
      command: "enroll",
      status: result.status,
      dryRun: !options.write,
      registryPath: resolved.registryPath,
      proposal,
      ...(result.entry ? { entry: result.entry } : {}),
      warnings: [...new Set(warnings)],
    };
    if (options.output === "json") console.log(JSON.stringify(response, null, 2));
    else {
      printWarnings(response.warnings);
      console.log(`${options.write ? "Enrolment" : "Enrolment proposal"}: ${proposal.repository.label}`);
      console.log(`Root: ${proposal.root}`);
      console.log(`Policy: ${proposal.configuration.source} (${proposal.configuration.fingerprint})`);
      console.log(`Signals: ${proposal.policy.signals.length}; adapters: ${proposal.policy.adapters.length}`);
      console.log(options.write ? `Registry: ${result.status}` : "No registry change; add --write to approve this proposal.");
    }
  } catch (error) {
    const response = {
      service: "proofwake",
      command: "enroll",
      status: "error",
      error: errorDetails(error),
      warnings: [...new Set(warnings)],
    };
    if (requested === "json") console.log(JSON.stringify(response, null, 2));
    else {
      printWarnings(response.warnings);
      console.error(`Proofwake enroll: ${response.error.code}: ${response.error.message}${response.error.path ? ` (${response.error.path})` : ""}`);
    }
    process.exitCode = 1;
  }
}

export async function runRepositoriesCommand(args) {
  const requested = outputMode(args);
  let warnings = [];
  try {
    const options = parseRepositories(args);
    if (options.help) {
      console.log(repositoryHelp());
      return;
    }
    const resolved = await paths(options);
    warnings = [...resolved.storage.warnings];
    const report = await buildRepositoryInventory({
      registryStore: new RepositoryRegistryStore(resolved.registryPath),
      eventStore: new JsonlEventStore(resolved.storage.dataPath),
    });
    const response = { ...report, registryPath: resolved.registryPath, warnings: [...new Set(warnings)] };
    if (options.output === "json") console.log(JSON.stringify(response, null, 2));
    else {
      printWarnings(response.warnings);
      console.log(`Proofwake repositories — ${response.summary.total}`);
      console.log(`Active ${response.summary.active}; dormant ${response.summary.dormant}; unobserved ${response.summary.unobserved}; misconfigured ${response.summary.misconfigured}`);
      for (const repository of response.repositories) {
        console.log("");
        console.log(`${repository.repository.label} — ${repository.classification} / ${repository.health}`);
        console.log(`  policy ${repository.policySource}${repository.policyChanged ? " (changed since enrolment)" : ""}`);
        console.log(`  revision ${repository.revision ?? "—"}; observations ${repository.observationCount ?? 0}`);
        if (repository.attentionReason) console.log(`  attention ${repository.attentionReason}`);
      }
    }
  } catch (error) {
    const response = {
      service: "proofwake",
      command: "repositories",
      status: "error",
      error: errorDetails(error),
      warnings: [...new Set(warnings)],
    };
    if (requested === "json") console.log(JSON.stringify(response, null, 2));
    else {
      printWarnings(response.warnings);
      console.error(`Proofwake repositories: ${response.error.code}: ${response.error.message}${response.error.path ? ` (${response.error.path})` : ""}`);
    }
    process.exitCode = 1;
  }
}
