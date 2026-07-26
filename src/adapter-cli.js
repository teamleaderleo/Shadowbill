import { dirname, join, resolve } from "node:path";
import { resolveStorageIdentity } from "./identity.js";
import { ingestRenderproveReceipt } from "./renderprove-adapter.js";
import { RepositoryRegistryStore } from "./repository-registry.js";
import { JsonlEventStore } from "./store.js";

const REPOSITORY = /^[a-z0-9](?:[a-z0-9._-]{0,99})\/[a-z0-9](?:[a-z0-9._-]{0,99})$/u;
const PUBLIC_RENDERPROVE_ERRORS = new Set([
  "RENDERPROVE_REPOSITORY_UNKNOWN",
  "RENDERPROVE_REPOSITORY_INVALID",
  "RENDERPROVE_REPOSITORY_UNSUPPORTED",
  "RENDERPROVE_ADAPTER_UNDECLARED",
  "RENDERPROVE_SIGNAL_UNDECLARED",
  "RENDERPROVE_REVISION_UNAVAILABLE",
  "RENDERPROVE_REVISION_CONFLICT",
  "RENDERPROVE_CHECKOUT_DIRTY",
  "RENDERPROVE_CHECKOUT_CHANGED",
  "RENDERPROVE_CLOCK_SKEW",
]);

export class AdapterCliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdapterCliUsageError";
    this.code = "ADAPTER_CLI_USAGE";
  }
}

function requiredValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new AdapterCliUsageError(`${name} requires a value.`);
  return value;
}

function requestedOutput(args) {
  return args.some((value, index) => value === "--output" && args[index + 1] === "json") ? "json" : "human";
}

function help() {
  return `Proofwake native adapter ingestion

  ingest-adapter --repo owner/name [--adapter renderprove] [--revision FULL_SHA]
                 [--registry PATH] [--data PATH] [--output human|json]

The Renderprove adapter validates the declared receipt and screenshot digests, then binds the
receipt to one stable clean checkout revision. Receipt content and local paths stay outside the ledger.`;
}

function parse(args) {
  const options = {
    repository: undefined,
    adapter: "renderprove",
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
    if (!["--repo", "--adapter", "--revision", "--registry", "--data", "--output"].includes(value)) {
      throw new AdapterCliUsageError(`Unknown ingest-adapter argument: ${value}`);
    }
    if (seen.has(value)) throw new AdapterCliUsageError(`${value} may be supplied once.`);
    seen.add(value);
    const next = requiredValue(args, index, value);
    index += 1;
    if (value === "--repo") options.repository = next.toLowerCase();
    else if (value === "--adapter") options.adapter = next.toLowerCase();
    else if (value === "--revision") options.revision = next;
    else if (value === "--registry") options.registryPath = next;
    else if (value === "--data") options.dataPath = next;
    else {
      if (!["human", "json"].includes(next)) throw new AdapterCliUsageError("--output must be human or json.");
      options.output = next;
    }
  }
  if (!options.help && !options.repository) throw new AdapterCliUsageError("ingest-adapter requires --repo owner/name.");
  if (options.repository !== undefined && !REPOSITORY.test(options.repository)) {
    throw new AdapterCliUsageError("--repo must use canonical lowercase owner/name form.");
  }
  if (options.adapter !== "renderprove") throw new AdapterCliUsageError("Only the renderprove adapter is supported in adapter v1.");
  if (options.revision !== undefined && !/^[a-f0-9]{40}$/u.test(options.revision)) {
    throw new AdapterCliUsageError("--revision must be a full lowercase SHA-1.");
  }
  return options;
}

function errorDetails(error) {
  const code = typeof error?.code === "string" ? error.code : "ADAPTER_INGEST_FAILED";
  if (code.startsWith("RENDERPROVE_") && !PUBLIC_RENDERPROVE_ERRORS.has(code)) {
    return { code, message: "Renderprove receipt verification failed." };
  }
  const details = {
    code,
    message: error instanceof Error ? error.message : String(error),
  };
  if (typeof error?.path === "string" && /^\$(?:\.[A-Za-z][A-Za-z0-9-]*|\[\d+\])*$/u.test(error.path)) {
    details.path = error.path;
  }
  return details;
}

function printWarnings(warnings) {
  for (const warning of [...new Set(warnings)]) console.error(`Proofwake compatibility: ${warning}`);
}

export async function runIngestAdapterCommand(args) {
  const output = requestedOutput(args);
  let warnings = [];
  try {
    const options = parse(args);
    if (options.help) {
      console.log(help());
      return;
    }
    const storage = await resolveStorageIdentity({ explicitDataPath: options.dataPath });
    warnings = [...new Set(storage.warnings)];
    const registryPath = resolve(options.registryPath ?? join(dirname(storage.dataPath), "repositories.json"));
    const registry = await new RepositoryRegistryStore(registryPath).read();
    const entry = registry.entries.find((candidate) =>
      candidate.repository.identity === options.repository || candidate.repository.label === options.repository);
    if (!entry) {
      const error = new Error("Repository is not enrolled.");
      error.code = "RENDERPROVE_REPOSITORY_UNKNOWN";
      error.path = "$.repository";
      throw error;
    }
    const result = await ingestRenderproveReceipt({
      entry,
      eventStore: new JsonlEventStore(storage.dataPath),
      adapterName: options.adapter,
      revision: options.revision,
    });
    const response = {
      service: "proofwake",
      command: "ingest-adapter",
      adapter: options.adapter,
      status: result.status,
      browserStatus: result.browserStatus,
      repository: result.repository,
      revision: result.revision,
      receiptDigest: result.receiptDigest,
      caseCount: result.caseCount,
      artifactCount: result.artifactCount,
      observation: {
        source: result.observation.source,
        id: result.observation.id,
        fingerprint: result.fingerprint,
        ingestedAt: result.observation.data.ingestedAt,
      },
      warnings,
    };
    if (options.output === "json") console.log(JSON.stringify(response, null, 2));
    else {
      printWarnings(warnings);
      const verb = result.status === "inserted" ? "Accepted" : "Already accepted";
      console.log(`${verb} Renderprove receipt for ${result.repository}@${result.revision.slice(0, 12)}.`);
      console.log(`Browser result: ${result.browserStatus}; cases ${result.caseCount}; artifacts ${result.artifactCount}.`);
      console.log(`Receipt: ${result.receiptDigest}`);
    }
  } catch (error) {
    const response = {
      service: "proofwake",
      command: "ingest-adapter",
      status: "error",
      error: errorDetails(error),
      warnings,
    };
    if (output === "json") console.log(JSON.stringify(response, null, 2));
    else {
      printWarnings(warnings);
      const path = response.error.path ? ` (${response.error.path})` : "";
      console.error(`Proofwake ingest-adapter: ${response.error.code}: ${response.error.message}${path}`);
      console.error(help());
    }
    process.exitCode = 1;
  }
}
