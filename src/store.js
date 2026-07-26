import { chmod, mkdir, open, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 300_000;
const DEFAULT_RETRY_DELAY_MS = 15;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isCode(error, code) {
  return error && typeof error === "object" && "code" in error && error.code === code;
}

async function readLedger(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return { raw: "", events: [], trailingPartialStart: null, needsSeparator: false };
    throw error;
  }

  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (endsWithNewline) lines.pop();
  const events = [];
  let consumedCharacters = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineStart = consumedCharacters;
    consumedCharacters += Buffer.byteLength(line, "utf8") + 1;
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      if (index === lines.length - 1 && !endsWithNewline) {
        return { raw, events, trailingPartialStart: lineStart, needsSeparator: false };
      }
      throw new Error(`Invalid JSONL event at line ${index + 1}: ${error.message}`);
    }
  }

  return {
    raw,
    events,
    trailingPartialStart: null,
    needsSeparator: raw.length > 0 && !endsWithNewline,
  };
}

function findEventById(events, id) {
  return events.find((entry) => entry?.id === id);
}

function stripIdempotentVolatileFields(event) {
  if (!event || typeof event !== "object") return event;
  if (event.type !== "proofwake_observation" || !event.observation?.data) return event;
  const observation = { ...event.observation };
  const data = { ...observation.data };
  if (data.adapter && typeof data.adapter === "object") {
    data.adapter = { ...data.adapter };
    delete data.adapter.secretSource;
  }
  delete data.ingestedAt;
  observation.data = data;
  return { ...event, observation };
}

function persistedEventFingerprint(event) {
  const copy = { ...stripIdempotentVolatileFields(event) };
  delete copy.timestamp;
  return JSON.stringify(copy);
}

function idempotentEquivalent(left, right) {
  return persistedEventFingerprint(left) === persistedEventFingerprint(right);
}

function preparePersistedEvent(event, existing) {
  if (!existing || existing.type !== "proofwake_observation" || event.type !== "proofwake_observation") return event;
  return {
    ...stripIdempotentVolatileFields(event),
    timestamp: existing.timestamp,
  };
}

function sourceObservation(event) {
  return event?.type === "proofwake_observation" ? event.observation : undefined;
}

export class EventIdConflictError extends Error {
  constructor(id) {
    super(`Event identity was reused with different semantics: ${id}`);
    this.name = "EventIdConflictError";
    this.code = "EVENT_ID_CONFLICT";
    this.id = id;
  }
}

async function syncAppend(path, content) {
  const handle = await open(path, "a", 0o600);
  try {
    await chmod(path, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class JsonlEventStore {
  #writeQueue = Promise.resolve();

  constructor(path, options = {}) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.recoveryPath = `${path}.recovery.jsonl`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  async #acquireLock() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockTimeoutMs;

    while (true) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;

        try {
          const lock = await stat(this.lockPath);
          if (Date.now() - lock.mtimeMs > this.staleLockMs) {
            await rm(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (isCode(statError, "ENOENT")) continue;
          throw statError;
        }

        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for ledger lock: ${this.lockPath}`);
        }
        await delay(this.retryDelayMs + Math.floor(Math.random() * this.retryDelayMs));
        continue;
      }

      try {
        await writeFile(join(this.lockPath, "owner.json"), JSON.stringify({
          token: randomUUID(),
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        await rm(this.lockPath, { recursive: true, force: true });
        throw error;
      }
      return async () => rm(this.lockPath, { recursive: true, force: true });
    }
  }

  async #repairTrailingPartial(ledger) {
    if (ledger.trailingPartialStart === null) return;
    const suffix = ledger.raw.slice(ledger.trailingPartialStart);
    if (suffix.length > 0) await syncAppend(this.recoveryPath, suffix);
    await truncate(this.path, ledger.trailingPartialStart);
  }

  #enqueueAppend(event, requestFingerprint) {
    const operation = this.#writeQueue.then(async () => {
      const release = await this.#acquireLock();
      try {
        const ledger = await readLedger(this.path);
        const existing = findEventById(ledger.events, event.id);
        if (existing) {
          if (requestFingerprint === undefined) return false;
          if (existing.requestFingerprint === requestFingerprint && idempotentEquivalent(existing, event)) {
            return { status: "duplicate", event: { ...existing, observation: sourceObservation(event) ?? existing.observation } };
          }
          throw new EventIdConflictError(event.id);
        }
        await this.#repairTrailingPartial(ledger);
        const separator = ledger.trailingPartialStart === null && ledger.needsSeparator ? "\n" : "";
        const persisted = preparePersistedEvent(event, ledger.events.at(-1));
        await syncAppend(this.path, `${separator}${JSON.stringify(persisted)}\n`);
        return requestFingerprint === undefined ? true : { status: "inserted", event };
      } finally {
        await release();
      }
    });

    this.#writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /**
   * Appends an event once. Returns false when its ID already exists.
   * @param {import('./types.js').ShadowbillEvent} event
   * @returns {Promise<boolean>}
   */
  append(event) {
    return this.#enqueueAppend(event, undefined);
  }

  /**
   * Appends an event with semantic duplicate detection.
   * @param {{id: string, requestFingerprint: string}} event
   * @returns {Promise<{status: 'inserted'|'duplicate', event: object}>}
   */
  appendIdempotent(event) {
    if (!event || typeof event !== "object" || typeof event.id !== "string" || typeof event.requestFingerprint !== "string") {
      throw new TypeError("Idempotent events require string id and requestFingerprint fields");
    }
    return this.#enqueueAppend(event, event.requestFingerprint);
  }

  /** @returns {Promise<import('./types.js').ShadowbillEvent[]>} */
  async readAll() {
    return (await readLedger(this.path)).events;
  }
}
