import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { normalizeRepositoryPolicy, repositoryPolicyDigest } from "./repository-policy.js";
import { parseStrictJson } from "./strict-json.js";

const REGISTRY_MAX_BYTES = 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 300_000;
const DEFAULT_RETRY_DELAY_MS = 15;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export class RepositoryRegistryError extends Error {
  constructor(code, message, path = "$") {
    super(message);
    this.name = "RepositoryRegistryError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "$") {
  throw new RepositoryRegistryError(code, message, path);
}

function isCode(error, code) {
  return error && typeof error === "object" && "code" in error && error.code === code;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function exactKeys(value, allowed, required, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("REPOSITORY_REGISTRY_INVALID_TYPE", "Expected an object.", path);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("REPOSITORY_REGISTRY_UNKNOWN_FIELD", `Unknown field: ${key}.`, `${path}.${key}`);
  }
  for (const key of required) {
    if (!(key in value)) fail("REPOSITORY_REGISTRY_MISSING_FIELD", `Missing required field: ${key}.`, `${path}.${key}`);
  }
}

function validateTimestamp(value, path) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("REPOSITORY_REGISTRY_INVALID_TIMESTAMP", "Expected a canonical UTC timestamp.", path);
  }
}

function validateEntry(entry, index) {
  const path = `$.entries[${index}]`;
  exactKeys(entry, ["repository", "root", "rootIdentity", "configuration", "policy", "approvedAt", "approval"],
    ["repository", "root", "rootIdentity", "configuration", "policy", "approvedAt", "approval"], path);
  if (typeof entry.repository !== "string" || !REPOSITORY.test(entry.repository)) {
    fail("REPOSITORY_REGISTRY_INVALID_REPOSITORY", "Repository identity must use owner/name form.", `${path}.repository`);
  }
  if (typeof entry.root !== "string" || !isAbsolute(entry.root)) {
    fail("REPOSITORY_REGISTRY_INVALID_ROOT", "Registry roots must be absolute paths.", `${path}.root`);
  }
  exactKeys(entry.rootIdentity, ["device", "inode"], ["device", "inode"], `${path}.rootIdentity`);
  for (const key of ["device", "inode"]) {
    if (typeof entry.rootIdentity[key] !== "string" || !/^\d+$/.test(entry.rootIdentity[key])) {
      fail("REPOSITORY_REGISTRY_INVALID_ROOT_IDENTITY", "Root identity values must be decimal strings.", `${path}.rootIdentity.${key}`);
    }
  }
  exactKeys(entry.configuration, ["source", "path", "digest"], ["source", "path", "digest"], `${path}.configuration`);
  if (!["committed", "global"].includes(entry.configuration.source)) {
    fail("REPOSITORY_REGISTRY_INVALID_CONFIGURATION", "Configuration source must be committed or global.", `${path}.configuration.source`);
  }
  if (entry.configuration.path !== null && entry.configuration.path !== ".proofwake.json") {
    fail("REPOSITORY_REGISTRY_INVALID_CONFIGURATION", "Committed configuration path must be .proofwake.json.", `${path}.configuration.path`);
  }
  if (entry.configuration.source === "committed" && entry.configuration.path !== ".proofwake.json") {
    fail("REPOSITORY_REGISTRY_INVALID_CONFIGURATION", "Committed entries require .proofwake.json.", `${path}.configuration.path`);
  }
  if (entry.configuration.source === "global" && entry.configuration.path !== null) {
    fail("REPOSITORY_REGISTRY_INVALID_CONFIGURATION", "Global entries cannot declare a committed path.", `${path}.configuration.path`);
  }
  if (typeof entry.configuration.digest !== "string" || !DIGEST.test(entry.configuration.digest)) {
    fail("REPOSITORY_REGISTRY_INVALID_CONFIGURATION", "Configuration digest must be SHA-256.", `${path}.configuration.digest`);
  }
  const policy = normalizeRepositoryPolicy(entry.policy);
  if (policy.repository !== entry.repository || repositoryPolicyDigest(policy) !== entry.configuration.digest) {
    fail("REPOSITORY_REGISTRY_POLICY_CONFLICT", "Registry policy identity or digest conflicts with its entry.", `${path}.policy`);
  }
  validateTimestamp(entry.approvedAt, `${path}.approvedAt`);
  if (entry.approval !== "explicit-cli") {
    fail("REPOSITORY_REGISTRY_INVALID_APPROVAL", "Registry approval must be explicit-cli.", `${path}.approval`);
  }
  return { ...entry, policy };
}

export function validateRepositoryRegistry(value) {
  exactKeys(value, ["version", "entries"], ["version", "entries"], "$");
  if (value.version !== 1) fail("REPOSITORY_REGISTRY_INVALID_VERSION", "Repository registry version must be 1.", "$.version");
  if (!Array.isArray(value.entries) || value.entries.length > 10_000) {
    fail("REPOSITORY_REGISTRY_INVALID_ENTRIES", "Registry entries must be an array with at most 10,000 entries.", "$.entries");
  }
  const repositories = new Set();
  const roots = new Set();
  const entries = value.entries.map((entry, index) => {
    const normalized = validateEntry(entry, index);
    if (repositories.has(normalized.repository)) {
      fail("REPOSITORY_REGISTRY_DUPLICATE_REPOSITORY", `Duplicate repository: ${normalized.repository}.`, `$.entries[${index}].repository`);
    }
    if (roots.has(normalized.root)) {
      fail("REPOSITORY_REGISTRY_DUPLICATE_ROOT", `Duplicate repository root: ${normalized.root}.`, `$.entries[${index}].root`);
    }
    repositories.add(normalized.repository);
    roots.add(normalized.root);
    return normalized;
  });
  return { version: 1, entries: entries.sort((left, right) => left.repository.localeCompare(right.repository)) };
}

async function readRegistry(path) {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isCode(error, "ENOENT")) return { version: 1, entries: [] };
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) fail("REPOSITORY_REGISTRY_NOT_FILE", "Repository registry must be a regular file.");
    if (before.size > REGISTRY_MAX_BYTES) fail("REPOSITORY_REGISTRY_TOO_LARGE", `Repository registry exceeds ${REGISTRY_MAX_BYTES} bytes.`);
    const bytes = await handle.readFile();
    if (bytes.length > REGISTRY_MAX_BYTES) fail("REPOSITORY_REGISTRY_TOO_LARGE", `Repository registry exceeds ${REGISTRY_MAX_BYTES} bytes.`);
    let raw;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("REPOSITORY_REGISTRY_INVALID_UTF8", "Repository registry must be valid UTF-8.");
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail("REPOSITORY_REGISTRY_CHANGED", "Repository registry changed while it was being read.");
    }
    const value = parseStrictJson(raw, { maxBytes: REGISTRY_MAX_BYTES, maxDepth: 16, prefix: "REPOSITORY_REGISTRY" });
    return validateRepositoryRegistry(value);
  } finally {
    await handle.close();
  }
}

async function writeRegistry(path, registry) {
  const normalized = validateRepositoryRegistry(registry);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.repositories-${process.pid}-${randomUUID()}.tmp`);
  const body = `${JSON.stringify(normalized, null, 2)}\n`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function entryFromProposal(proposal, now) {
  const policy = normalizeRepositoryPolicy(proposal.policy);
  return {
    repository: proposal.repository,
    root: proposal.root,
    rootIdentity: proposal.rootIdentity,
    configuration: {
      source: proposal.configuration.source === "committed" ? "committed" : "global",
      path: proposal.configuration.source === "committed" ? ".proofwake.json" : null,
      digest: repositoryPolicyDigest(policy),
    },
    policy,
    approvedAt: now.toISOString(),
    approval: "explicit-cli",
  };
}

export class RepositoryRegistryStore {
  constructor(path, options = {}) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.queue = Promise.resolve();
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
          const metadata = await stat(this.lockPath);
          if (Date.now() - metadata.mtimeMs > this.staleLockMs) {
            await rm(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (isCode(statError, "ENOENT")) continue;
          throw statError;
        }
        if (Date.now() >= deadline) fail("REPOSITORY_REGISTRY_LOCK_TIMEOUT", `Timed out waiting for repository registry lock: ${this.lockPath}.`);
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

  async read() {
    return readRegistry(this.path);
  }

  enroll(proposal, { now = new Date(), replace = false } = {}) {
    const operation = this.queue.then(async () => {
      const release = await this.#acquireLock();
      try {
        const registry = await readRegistry(this.path);
        const entry = entryFromProposal(proposal, now);
        const existingIndex = registry.entries.findIndex((value) => value.repository === entry.repository);
        const rootOwner = registry.entries.find((value) => value.root === entry.root && value.repository !== entry.repository);
        if (rootOwner) {
          fail("REPOSITORY_ROOT_CONFLICT", `Repository root is already enrolled as ${rootOwner.repository}.`, "$.root");
        }
        if (existingIndex >= 0) {
          const existing = registry.entries[existingIndex];
          if (existing.root !== entry.root && !replace) {
            fail("REPOSITORY_ENROLLMENT_CONFLICT", `Repository is already enrolled at ${existing.root}; use --replace to move it.`, "$.root");
          }
          const comparableExisting = { ...existing, approvedAt: entry.approvedAt };
          if (JSON.stringify(comparableExisting) === JSON.stringify(entry)) return { status: "unchanged", entry: existing };
          registry.entries[existingIndex] = entry;
          await writeRegistry(this.path, registry);
          return { status: "updated", entry };
        }
        registry.entries.push(entry);
        await writeRegistry(this.path, registry);
        return { status: "inserted", entry };
      } finally {
        await release();
      }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
