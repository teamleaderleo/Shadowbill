import { resolveStorageIdentity } from "./identity.js";
import { executeLocalCommand } from "./run.js";
import { JsonlEventStore } from "./store.js";

export class RunUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunUsageError";
    this.code = "PROOFWAKE_RUN_USAGE";
  }
}

function usage() {
  return `proofwake run --repo owner/name --kind verify [--cwd PATH]
              [--run-id TOKEN] [--timeout-seconds N]
              [--data PATH] [--output human|json]
              -- COMMAND [ARGS...]`;
}

function requestedOutput(args) {
  const separator = args.indexOf("--");
  const options = separator === -1 ? args : args.slice(0, separator);
  return options.some((value, index) => value === "--output" && options[index + 1] === "json") ? "json" : "human";
}

function requiredValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new RunUsageError(`${name} requires a value.`);
  return value;
}

function parseArguments(args) {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const separator = args.indexOf("--");
  if (separator < 0) throw new RunUsageError("run requires -- before the command argument vector.");

  const options = {
    repository: undefined,
    kind: undefined,
    cwd: process.cwd(),
    runId: undefined,
    timeoutSeconds: 0,
    dataPath: undefined,
    output: "human",
  };
  const seen = new Set();
  const names = new Set(["--repo", "--kind", "--cwd", "--run-id", "--timeout-seconds", "--data", "--output"]);

  for (let index = 0; index < separator; index += 1) {
    const name = args[index];
    if (!names.has(name)) throw new RunUsageError(`Unknown run argument: ${name}`);
    if (seen.has(name)) throw new RunUsageError(`${name} may be supplied once.`);
    seen.add(name);
    const value = requiredValue(args, index, name);
    index += 1;

    if (name === "--repo") options.repository = value;
    else if (name === "--kind") options.kind = value;
    else if (name === "--cwd") options.cwd = value;
    else if (name === "--run-id") options.runId = value;
    else if (name === "--data") options.dataPath = value;
    else if (name === "--output") {
      if (value !== "human" && value !== "json") throw new RunUsageError("--output must be human or json.");
      options.output = value;
    } else {
      if (!/^\d+$/u.test(value)) throw new RunUsageError("--timeout-seconds must be an integer.");
      options.timeoutSeconds = Number(value);
      if (!Number.isSafeInteger(options.timeoutSeconds) || options.timeoutSeconds > 86_400) {
        throw new RunUsageError("--timeout-seconds must be between 0 and 86400.");
      }
    }
  }

  const command = args.slice(separator + 1);
  if (!options.repository) throw new RunUsageError("--repo is required.");
  if (!options.kind) throw new RunUsageError("--kind is required.");
  if (command.length === 0) throw new RunUsageError("A command is required after --.");
  return { ...options, command };
}

function errorDetails(error) {
  const details = {
    code: typeof error?.code === "string" ? error.code : "PROOFWAKE_RUN_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
  if (typeof error?.path === "string") details.path = error.path;
  return details;
}

function printWarnings(warnings) {
  for (const warning of [...new Set(warnings)]) console.error(`Proofwake compatibility: ${warning}`);
}

export async function runCommandCli(args) {
  const output = requestedOutput(args);
  let warnings = [];
  try {
    const options = parseArguments(args);
    if (options.help) {
      console.log(usage());
      return;
    }
    const storage = await resolveStorageIdentity({ explicitDataPath: options.dataPath });
    warnings = [...new Set(storage.warnings)];
    const result = await executeLocalCommand({
      repository: options.repository,
      kind: options.kind,
      command: options.command,
      cwd: options.cwd,
      runId: options.runId,
      timeoutMs: options.timeoutSeconds * 1000,
      outputMode: options.output,
      store: new JsonlEventStore(storage.dataPath),
    });
    const response = {
      service: "proofwake",
      command: "run",
      status: result.observation.data.status,
      repository: result.repository,
      revision: result.revision,
      runId: result.runId,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      signal: result.signal,
      failureCode: result.failureCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      outputLimited: result.outputLimited,
      dirtyWorktree: result.dirty ?? null,
      detachedHead: result.detached ?? null,
      fingerprint: result.fingerprint,
      storageStatus: result.storageStatus,
      replayed: result.replayed,
      warnings,
    };
    if (options.output === "json") {
      console.log(JSON.stringify(response, null, 2));
    } else {
      printWarnings(warnings);
      const revision = response.revision.slice(0, 12);
      const replay = response.replayed ? " replay" : "";
      console.error(`Proofwake run:${replay} ${response.status} ${response.repository}@${revision} (${response.durationMs} ms)`);
      console.error(`Receipt: ${response.runId} ${response.fingerprint}`);
    }
    process.exitCode = result.cliExitCode;
  } catch (error) {
    const response = {
      service: "proofwake",
      command: "run",
      status: "error",
      error: errorDetails(error),
      warnings,
    };
    if (output === "json") {
      console.log(JSON.stringify(response, null, 2));
    } else {
      printWarnings(warnings);
      const path = response.error.path ? ` (${response.error.path})` : "";
      console.error(`Proofwake run: ${response.error.code}: ${response.error.message}${path}`);
      console.error(`Usage: ${usage()}`);
    }
    process.exitCode = 2;
  }
}
