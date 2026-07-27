import path from "node:path";
import { loadPricing } from "./estimate.js";
import { resolveStorageIdentity } from "./identity.js";
import { runProofwakeMcpStdioServer } from "./proofwake-mcp.js";
import { RepositoryRegistryStore } from "./repository-registry.js";
import { JsonlEventStore } from "./store.js";

export class McpCommandUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "McpCommandUsageError";
    this.code = "PROOFWAKE_MCP_USAGE";
  }
}

function help() {
  return `Proofwake MCP stdio server

  mcp [--registry PATH] [--data PATH]
      [--allow-writes] [--allow-evaluation-writes]

Projection and report tools are read-only. --allow-writes enables only the
legacy aggregate-chat write tool. --allow-evaluation-writes enables only the
bounded evaluation receipt ingestion tool.`;
}

function requiredValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new McpCommandUsageError(`${name} requires a value.`);
  }
  return value;
}

export function parseMcpCommandArguments(args) {
  const options = {
    registryPath: undefined,
    dataPath: undefined,
    allowWrites: false,
    allowEvaluationWrites: false,
    help: false,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--help" || value === "-h") {
      options.help = true;
      continue;
    }
    if (["--allow-writes", "--allow-evaluation-writes"].includes(value)) {
      if (seen.has(value)) throw new McpCommandUsageError(`${value} may be supplied once.`);
      seen.add(value);
      if (value === "--allow-writes") options.allowWrites = true;
      else options.allowEvaluationWrites = true;
      continue;
    }
    if (["--registry", "--data"].includes(value)) {
      if (seen.has(value)) throw new McpCommandUsageError(`${value} may be supplied once.`);
      seen.add(value);
      const next = requiredValue(args, index, value);
      index += 1;
      if (value === "--registry") options.registryPath = next;
      else options.dataPath = next;
      continue;
    }
    throw new McpCommandUsageError(`Unknown MCP argument: ${value}`);
  }
  return options;
}

export async function runMcpCommand(args) {
  const options = parseMcpCommandArguments(args);
  if (options.help) {
    console.log(help());
    return;
  }
  const storage = await resolveStorageIdentity({ explicitDataPath: options.dataPath });
  const pricing = await loadPricing(storage.pricingPath, storage.model);
  const registryPath = options.registryPath ?? path.join(path.dirname(storage.dataPath), "repositories.json");
  await runProofwakeMcpStdioServer({
    store: new JsonlEventStore(storage.dataPath),
    registryStore: new RepositoryRegistryStore(registryPath),
    pricing,
    profile: storage.profile,
    timeZone: storage.timeZone,
    allowWrites: options.allowWrites,
    allowEvaluationWrites: options.allowEvaluationWrites,
  });
}
