#!/usr/bin/env node
import { resolveStorageIdentity } from "./identity.js";
import { emitObservation, readBoundedObservationFile, readBoundedObservationStream } from "./emit.js";
import { JsonlEventStore } from "./store.js";
import { runRepositoryCommand } from "./repository-cli.js";

class EmitUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmitUsageError";
    this.code = "PROOFWAKE_EMIT_USAGE";
  }
}

function help() {
  return `Proofwake

The evidence trail behind every revision.

Commands:
  emit --json FILE [--data PATH] [--output human|json]
  emit --stdin [--data PATH] [--output human|json]
  enroll PATH [--dry-run] [--repository owner/name] [--output human|json]
  repositories [--output human|json]
  status [--json]
  serve [--port 7337] [--github-secret SECRET] [--allowed-hosts HOSTS]
  mcp [--allow-writes]
  report [--date YYYY-MM-DD] [--days 1..365] [--by-repository] [--json]
  doctor [--json]
  ingest-git [--repo PATH]
  hook install [PATH]

Emit accepts one complete Proofwake observation v1 document. --json selects an input file;
--output json selects machine-readable command output.

Legacy SHADOWBILL_* variables and the shadowbill binary remain compatibility aliases.`;
}

function parseEmitArguments(args) {
  const result = { file: undefined, stdin: false, dataPath: undefined, output: "human", outputSet: false };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--stdin") {
      if (result.stdin) throw new EmitUsageError("--stdin may be supplied once.");
      result.stdin = true;
      continue;
    }
    if (["--json", "--data", "--output"].includes(value)) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new EmitUsageError(`${value} requires a value.`);
      index += 1;
      if (value === "--json") {
        if (result.file !== undefined) throw new EmitUsageError("--json may be supplied once.");
        result.file = next;
      } else if (value === "--data") {
        if (result.dataPath !== undefined) throw new EmitUsageError("--data may be supplied once.");
        result.dataPath = next;
      } else {
        if (result.outputSet) throw new EmitUsageError("--output may be supplied once.");
        if (next !== "human" && next !== "json") throw new EmitUsageError("--output must be human or json.");
        result.output = next;
        result.outputSet = true;
      }
      continue;
    }
    if (value === "--help" || value === "-h") {
      result.help = true;
      continue;
    }
    throw new EmitUsageError(`Unknown emit argument: ${value}`);
  }
  if (!result.help && Number(result.file !== undefined) + Number(result.stdin) !== 1) {
    throw new EmitUsageError("Choose exactly one observation source: --json FILE or --stdin.");
  }
  return result;
}

function requestedOutput(args) {
  return args.some((value, index) => value === "--output" && args[index + 1] === "json") ? "json" : "human";
}

function uniqueWarnings(warnings) {
  return [...new Set(warnings)];
}

function errorDetails(error) {
  const code = typeof error?.code === "string" ? error.code : "PROOFWAKE_EMIT_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  const details = { code, message };
  if (typeof error?.path === "string") details.path = error.path;
  return details;
}

function printHumanWarnings(warnings) {
  for (const warning of uniqueWarnings(warnings)) console.error(`Proofwake compatibility: ${warning}`);
}

async function runEmit(args) {
  const output = requestedOutput(args);
  let warnings = [];
  try {
    const options = parseEmitArguments(args);
    if (options.help) {
      console.log(help());
      return;
    }
    const storage = await resolveStorageIdentity({ explicitDataPath: options.dataPath });
    warnings = uniqueWarnings(storage.warnings);
    const text = options.file !== undefined
      ? await readBoundedObservationFile(options.file)
      : await readBoundedObservationStream(process.stdin);
    const result = await emitObservation({ store: new JsonlEventStore(storage.dataPath), text });
    const response = {
      service: "proofwake",
      command: "emit",
      status: result.status,
      identity: {
        source: result.observation.source,
        id: result.observation.id,
      },
      fingerprint: result.fingerprint,
      ingestedAt: result.observation.data.ingestedAt,
      warnings,
    };
    if (options.output === "json") {
      console.log(JSON.stringify(response, null, 2));
    } else {
      printHumanWarnings(warnings);
      const verb = result.status === "inserted" ? "Accepted" : "Already accepted";
      console.log(`${verb} observation ${response.identity.source}#${response.identity.id}.`);
      console.log(`Fingerprint: ${response.fingerprint}`);
    }
  } catch (error) {
    const response = {
      service: "proofwake",
      command: "emit",
      status: "error",
      error: errorDetails(error),
      warnings: uniqueWarnings(warnings),
    };
    if (output === "json") console.log(JSON.stringify(response, null, 2));
    else {
      printHumanWarnings(response.warnings);
      const path = response.error.path ? ` (${response.error.path})` : "";
      console.error(`Proofwake emit: ${response.error.code}: ${response.error.message}${path}`);
    }
    process.exitCode = 1;
  }
}

const command = process.argv[2];
if (command === undefined || command === "help" || command === "--help" || command === "-h") {
  console.log(help());
} else if (command === "emit") {
  await runEmit(process.argv.slice(3));
} else if (command === "enroll" || command === "repositories") {
  await runRepositoryCommand(command, process.argv.slice(3));
} else {
  await import("./cli.js");
}
