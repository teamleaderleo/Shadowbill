import { readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";
import {
  MAX_OBSERVATION_BYTES,
  prepareObservation,
  ProofwakeObservationError,
} from "./observation.js";
import { resolveStorageIdentity } from "./identity.js";
import { JsonlEventStore } from "./store.js";

function option(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}

function has(arguments_, name) {
  return arguments_.includes(name);
}

async function readBoundedStream(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_OBSERVATION_BYTES) {
      throw new ProofwakeObservationError(
        "PW_OBSERVATION_TOO_LARGE",
        `Observation exceeds ${MAX_OBSERVATION_BYTES} bytes`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ProofwakeObservationError("PW_JSON_UTF8", "Observation must be valid UTF-8");
  }
}

/**
 * Executes one local Proofwake observation emission.
 * @param {{
 *   argv?: string[],
 *   input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream,
 *   errorOutput?: NodeJS.WritableStream,
 *   environment?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   now?: Date,
 * }} [options]
 */
export async function runEmitCommand(options = {}) {
  const arguments_ = options.argv ?? process.argv.slice(3);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const environment = options.environment ?? process.env;

  const fileFlag = has(arguments_, "--json");
  const stdinFlag = has(arguments_, "--stdin");
  if (fileFlag === stdinFlag) {
    throw new ProofwakeObservationError(
      "PW_INPUT_REQUIRED",
      "Choose exactly one of --json FILE or --stdin",
    );
  }

  const filePath = option(arguments_, "--json");
  if (fileFlag && (!filePath || filePath.startsWith("--"))) {
    throw new ProofwakeObservationError("PW_INPUT_REQUIRED", "--json requires a file path");
  }

  const storage = await resolveStorageIdentity({
    explicitDataPath: option(arguments_, "--data"),
    environment,
  });
  for (const warning of [...new Set(storage.warnings)]) {
    errorOutput.write(`Proofwake compatibility: ${warning}\n`);
  }

  const buffer = fileFlag ? await readFile(filePath) : await readBoundedStream(input);
  if (buffer.length > MAX_OBSERVATION_BYTES) {
    throw new ProofwakeObservationError(
      "PW_OBSERVATION_TOO_LARGE",
      `Observation exceeds ${MAX_OBSERVATION_BYTES} bytes`,
    );
  }

  const prepared = prepareObservation(decodeUtf8(buffer), { now: options.now });
  const store = new JsonlEventStore(storage.dataPath);
  const result = await store.appendObservation(prepared.event);
  const response = {
    accepted: true,
    duplicate: result.duplicate,
    source: prepared.identity.source,
    id: prepared.identity.id,
    fingerprint: prepared.fingerprint,
    ingestedAt: result.event.proofwakeingestedat,
    dataPath: storage.dataPath,
  };
  output.write(`${JSON.stringify(response)}\n`);
  return response;
}

export function formatEmitFailure(error) {
  const code = typeof error?.code === "string" ? error.code : "PW_EMIT_FAILED";
  return `${code}: ${error instanceof Error ? error.message : String(error)}`;
}
