import { open } from "node:fs/promises";
import { OBSERVATION_MAX_BYTES, ObservationError, parseObservationJson, validateObservation } from "./observation.js";
import { ObservationLedger } from "./observation-ledger.js";

export class ObservationSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ObservationSourceError";
    this.code = code;
  }
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ObservationSourceError("OBSERVATION_INVALID_UTF8", "Observation input must be valid UTF-8.");
  }
}

function assertBoundedSize(size) {
  if (size > OBSERVATION_MAX_BYTES) {
    throw new ObservationError(
      "OBSERVATION_TOO_LARGE",
      `Observation exceeds ${OBSERVATION_MAX_BYTES} bytes.`,
      "$",
    );
  }
}

function sourceChanged(before, after) {
  return before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs;
}

export async function readBoundedObservationFile(path) {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    throw new ObservationSourceError(
      "OBSERVATION_SOURCE_UNAVAILABLE",
      `Observation file could not be opened: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new ObservationSourceError("OBSERVATION_SOURCE_NOT_FILE", "Observation input must be a regular file.");
    }
    assertBoundedSize(before.size);
    const bytes = await handle.readFile();
    assertBoundedSize(bytes.length);
    const after = await handle.stat();
    if (sourceChanged(before, after)) {
      throw new ObservationSourceError("OBSERVATION_SOURCE_CHANGED", "Observation file changed while it was being read.");
    }
    return decodeUtf8(bytes);
  } finally {
    await handle.close();
  }
}

export async function readBoundedObservationStream(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    assertBoundedSize(size);
    chunks.push(bytes);
  }
  return decodeUtf8(Buffer.concat(chunks, size));
}

export async function emitObservation({ store, text, now = new Date() }) {
  const observation = parseObservationJson(text);
  observation.data = { ...observation.data, ingestedAt: now.toISOString() };
  validateObservation(observation);
  return new ObservationLedger(store).append(observation);
}
