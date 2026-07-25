import { chmod, mkdir, open, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 300_000;
const DEFAULT_RETRY_DELAY_MS = 15;

export class IdempotencyConflictError extends Error {
  constructor(source, id) {
    super(`Observation identity ${source} + ${id} was already used with different semantics`);
    this.name = "IdempotencyConflictError";
    this.code = "PW_IDEMPOTENCY_CONFLICT";
    this.source = source;
    this.id = id;
  }
}

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
    const jsonLine = line.endsWith("\r") ? line.slice(0, -1) : line;
    const lineStart = consumedCharacters;
    consumedCharacters += line.length + (index < lines.length - 1 || endsWithNewline ? 1 : 0);
    if (jsonLine.length === 0) continue;
    try {
      events.push(JSON.parse(jsonLine));
    } catch (error) {
      const isTrailingPartial = index === lines.length - 1 && !endsWithNewline;
      if (isTrailingPartial) {
        return {
          raw,
          events,
          trailingPartialStart: Buffer.byteLength(raw.slice(0, lineStart), "utf8"),
          needsSeparator: false,
        };
      }
      throw new Error(`Invalid JSONL at line ${index + 1}: ${String(error)}`);
    }
  }

  return {
    raw,
    events,
    trailingPartialStart: null,
    needsSeparator: raw.length > 0 && !endsWithNewline,
  };
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

function cloudEventIdentity(event) {
  if (!event || event.specversion !== "1.0" || typeof event.source !== "string" || typeof event.id !== "string") return null;
  return `${event.source}\0${event.id}`;
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
    const rawBytes = Buffer.from(ledger.raw, "utf8");
    const validPrefix = rawBytes.subarray(0, ledger.trailingPartialStart);
    const partial = rawBytes.subarray(ledger.trailingPartialStart);
    const recovery = JSON.stringify({
      recoveredAt: new Date().toISOString(),
      bytesBase64: partial.toString("base64"),
    });
    await syncAppend(this.recoveryPath, `${recovery}\n`);
    await truncate(this.path, validPrefix.length);
  }

  /**
   * Appends one legacy event by its historical top-level ID semantics.
   * @param {import('./types.js').ShadowbillEvent} event
   * @returns {Promise<boolean>}
   */
  append(event) {
    const operation = this.#writeQueue.then(async () => {
      const release = await this.#acquireLock();
      try {
        const ledger = await readLedger(this.path);
        if (ledger.events.some((existing) => existing.id === event.id)) return false;
        await this.#repairTrailingPartial(ledger);
        const separator = ledger.trailingPartialStart === null && ledger.needsSeparator ? "\n" : "";
        await syncAppend(this.path, `${separator}${JSON.stringify(event)}\n`);
        return true;
      } finally {
        await release();
      }
    });

    this.#writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /**
   * Appends a prepared Proofwake CloudEvent using CloudEvents source + id identity.
   * Exact replays return the original stored event; conflicting semantic reuse fails.
   * @param {Record<string, unknown>} event
   * @returns {Promise<{inserted: boolean, duplicate: boolean, event: Record<string, unknown>}>}
   */
  appendObservation(event) {
    const operation = this.#writeQueue.then(async () => {
      const release = await this.#acquireLock();
      try {
        const ledger = await readLedger(this.path);
        await this.#repairTrailingPartial(ledger);
        const identity = cloudEventIdentity(event);
        if (identity === null || typeof event.proofwakefingerprint !== "string") {
          throw new Error("appendObservation requires a prepared Proofwake CloudEvent");
        }
        const existing = ledger.events.find((candidate) => cloudEventIdentity(candidate) === identity);
        if (existing) {
          if (existing.proofwakefingerprint === event.proofwakefingerprint) {
            return { inserted: false, duplicate: true, event: existing };
          }
          throw new IdempotencyConflictError(event.source, event.id);
        }
        const separator = ledger.trailingPartialStart === null && ledger.needsSeparator ? "\n" : "";
        await syncAppend(this.path, `${separator}${JSON.stringify(event)}\n`);
        return { inserted: true, duplicate: false, event };
      } finally {
        await release();
      }
    });

    this.#writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** @returns {Promise<import('./types.js').ShadowbillEvent[]>} */
  async readAll() {
    return (await readLedger(this.path)).events;
  }
}
