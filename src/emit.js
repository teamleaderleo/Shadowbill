import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
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

function sourceUnavailable() {
  return new ObservationSourceError(
    "OBSERVATION_SOURCE_UNAVAILABLE",
    "Observation file could not be opened.",
  );
}

function sourceNotFile() {
  return new ObservationSourceError(
    "OBSERVATION_SOURCE_NOT_FILE",
    "Observation input must be a regular file.",
  );
}

export async function readBoundedObservationFile(path) {
  let pathMetadata;
  try {
    pathMetadata = await lstat(path);
  } catch {
    throw sourceUnavailable();
  }
  if (pathMetadata.isSymbolicLink()) {
    throw new ObservationSourceError(
      "OBSERVATION_SOURCE_SYMLINK",
      "Observation input must not be a symbolic link.",
    );
  }
  if (!pathMetadata.isFile()) throw sourceNotFile();

  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new ObservationSourceError(
        "OBSERVATION_SOURCE_SYMLINK",
        "Observation input must not be a symbolic link.",
      );
    }
    throw sourceUnavailable();
  }

  try {
    const before = await handle.stat();
    if (!before.isFile()) throw sourceNotFile();
    if (before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino) {
      throw new ObservationSourceError("OBSERVATION_SOURCE_CHANGED", "Observation file changed before it could be read.");
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

export async function appendObservation({ store, observation, now = new Date() }) {
  const accepted = structuredClone(observation);
  accepted.data = { ...accepted.data, ingestedAt: now.toISOString() };
  validateObservation(accepted);
  return new ObservationLedger(store).append(accepted);
}

export async function emitObservation({ store, text, now = new Date() }) {
  return appendObservation({
    store,
    observation: parseObservationJson(text),
    now,
  });
}
