#!/usr/bin/env node
import { runIngestAdapterCommand } from "./adapter-cli.js";
import { runDoctorCommand } from "./doctor-command.js";
import { runEvaluationCommand } from "./evaluation-cli.js";
import { runFailuresCommand, runRecoveriesCommand } from "./history-report-cli.js";
import { resolveStorageIdentity } from "./identity.js";
import { emitObservation, readBoundedObservationFile, readBoundedObservationStream } from "./emit.js";
import { runEnrollCommand, runRepositoriesCommand } from "./repository-cli.js";
import { runCommandCli } from "./run-cli.js";
import { runFleetCommand, runInspectCommand } from "./projection-cli.js";
import { JsonlEventStore } from "./store.js";

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
  enroll PATH [--policy FILE] [--repository owner/name] [--lifecycle active|dormant]
              [--write] [--approve-autodetected] [--replace]
              [--registry PATH] [--data PATH] [--output human|json]
  repositories [--registry PATH] [--data PATH] [--output human|json]
  run --repo owner/name --kind KIND [--cwd PATH] [--run-id TOKEN]
      [--timeout-seconds N] [--data PATH] [--output human|json]
      -- COMMAND [ARGS...]
  ingest-adapter --repo owner/name [--adapter renderprove] [--revision FULL_SHA]
                 [--registry PATH] [--data PATH] [--output human|json]
  inspect [REVISION] --repo owner/name [--registry PATH] [--data PATH]
                     [--output human|json]
  fleet [--registry PATH] [--data PATH] [--output human|json]
  evaluation --repo owner/name --task-class TOKEN [--target-run run_...]
             [--data PATH] [--output human|json]
  failures [--days 1..365] [--registry PATH] [--data PATH] [--output human|json]
  recoveries [--days 1..365] [--registry PATH] [--data PATH] [--output human|json]
  status [--json]
  serve [--port 7337] [--github-secret SECRET] [--allowed-hosts HOSTS]
  mcp [--registry PATH] [--allow-writes] [--allow-evaluation-writes]
  report [--date YYYY-MM-DD] [--days 1..365] [--by-repository] [--json]
  doctor [--registry PATH] [--data PATH] [--collector-token-file PATH]
         [--pricing PATH] [--model MODEL] [--timezone IANA_NAME] [--json]
  ingest-git [--repo PATH]
  hook install [PATH]

Emit accepts one complete Proofwake observation v1 document. Enrolment is a dry run
unless --write is supplied. A tracked, clean .proofwake.json is authoritative.
Run launches one argument vector without a shell and records a bounded terminal receipt.
Native adapter ingestion validates declared external receipts and artifact digests before indexing.
Inspect and fleet rebuild current revision evidence. Evaluation rebuilds one task-specific,
rubric-separated evidence view and returns insufficient_evidence for sparse samples.
The MCP evaluation write tool is absent unless --allow-evaluation-writes is supplied.
Failures and recoveries report bounded policy-matched history from the registry and accepted ledger.
Doctor checks the active ledger, optional estimate module, repository registry, enrolled
checkouts, policies, and declared adapter receipt paths without changing them.

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

const CONTENT_DERIVED_OBSERVATION_ERRORS = new Set([
  "OBSERVATION_DUPLICATE_KEY",
  "OBSERVATION_DUPLICATE_VALUE",
  "OBSERVATION_INVALID_VALUE",
  "OBSERVATION_UNKNOWN_FIELD",
]);

function errorDetails(error) {
  const code = typeof error?.code === "string" ? error.code : "PROOFWAKE_EMIT_FAILED";
  if (CONTENT_DERIVED_OBSERVATION_ERRORS.has(code)) {
    return { code, message: "Observation verification failed." };
  }
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
} else if (command === "enroll") {
  await runEnrollCommand(process.argv.slice(3));
} else if (command === "repositories") {
  await runRepositoriesCommand(process.argv.slice(3));
} else if (command === "run") {
  await runCommandCli(process.argv.slice(3));
} else if (command === "ingest-adapter") {
  await runIngestAdapterCommand(process.argv.slice(3));
} else if (command === "inspect") {
  await runInspectCommand(process.argv.slice(3));
} else if (command === "fleet") {
  await runFleetCommand(process.argv.slice(3));
} else if (command === "evaluation") {
  await runEvaluationCommand(process.argv.slice(3));
} else if (command === "failures") {
  await runFailuresCommand(process.argv.slice(3));
} else if (command === "recoveries") {
  await runRecoveriesCommand(process.argv.slice(3));
} else if (command === "doctor") {
  await runDoctorCommand(process.argv.slice(3));
} else {
  await import("./cli.js");
}
