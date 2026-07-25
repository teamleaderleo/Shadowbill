import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { resolveStorageIdentity } from "./identity.js";
import { ObservationLedger } from "./observation-ledger.js";
import {
  OBSERVATION_MAX_BYTES,
  ObservationError,
  parseObservationJson,
  validateObservation,
} from "./observation.js";
import { JsonlEventStore } from "./store.js";

class ObservationInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ObservationInputError";
    this.code = code;
  }
}

function option(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}

function has(arguments_, name) {
  return arguments_.includes(name);
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ObservationInputError("OBSERVATION_INVALID_UTF8", "Observation input must be valid UTF-8.");
  }
}

function assertBounded(bytes) {
  if (bytes > OBSERVATION_MAX_BYTES) {
    throw new ObservationInputError(
      "OBSERVATION_TOO_LARGE",
      `Observation exceeds ${OBSERVATION_MAX_BYTES} bytes.`,
    );
  }
}

async function readBoundedFile(path) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new ObservationInputError("OBSERVATION_INPUT_UNSAFE", "Observation file must not be a symbolic link.");
    }
    throw error;
  }

  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new ObservationInputError("OBSERVATION_INPUT_UNSAFE", "Observation input must be a regular file.");
    }
    assertBounded(metadata.size);
    const buffer = await handle.readFile();
    assertBounded(buffer.length);
    return buffer;
  } finally {
    await handle.close();
  }
}

async function readBoundedStream(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    assertBounded(bytes);
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function observationForIngestion(text, now) {
  const parsed = parseObservationJson(text);
  const observation = {
    ...parsed,
    data: {
      ...parsed.data,
      ingestedAt: now.toISOString(),
    },
  };
  validateObservation(observation);
  return observation;
}

/**
 * Runs `proofwake emit` against the existing observation-v1 contract.
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
  const now = options.now ?? new Date();

  const fileSelected = has(arguments_, "--json");
  const stdinSelected = has(arguments_, "--stdin");
  if (fileSelected === stdinSelected) {
    throw new ObservationInputError(
      "OBSERVATION_INPUT_REQUIRED",
      "Choose exactly one of --json FILE or --stdin.",
    );
  }

  const filePath = option(arguments_, "--json");
  if (fileSelected && (!filePath || filePath.startsWith("--"))) {
    throw new ObservationInputError("OBSERVATION_INPUT_REQUIRED", "--json requires a file path.");
  }

  const storage = await resolveStorageIdentity({
    explicitDataPath: option(arguments_, "--data"),
    environment,
  });
  for (const warning of [...new Set(storage.warnings)]) {
    errorOutput.write(`Proofwake compatibility: ${warning}\n`);
  }

  const bytes = fileSelected ? await readBoundedFile(filePath) : await readBoundedStream(input);
  const observation = observationForIngestion(decodeUtf8(bytes), now);
  const ledger = new ObservationLedger(new JsonlEventStore(storage.dataPath));
  const result = await ledger.append(observation);
  const response = {
    accepted: true,
    duplicate: result.status === "duplicate",
    source: result.observation.source,
    id: result.observation.id,
    fingerprint: result.fingerprint,
    ingestedAt: result.observation.data.ingestedAt,
  };
  output.write(`${JSON.stringify(response)}\n`);
  return response;
}

export function formatEmitError(error) {
  if (error instanceof ObservationError || typeof error?.code === "string") {
    return `${error.code}: ${error instanceof Error ? error.message : String(error)}`;
  }
  return `OBSERVATION_EMIT_FAILED: ${error instanceof Error ? error.message : String(error)}`;
}
