import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseStrictJson } from "./strict-json.js";
import { repositoryPolicyFingerprint, validateRepositoryPolicy } from "./repository-policy.js";
import { repositoryPolicyIdentity, repositoryPolicyLabel } from "./repository-policy-file.js";

const REGISTRY_VERSION = 1;
const REGISTRY_MAX_BYTES = 1_048_576;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 300_000;

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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value, path) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail("REPOSITORY_REGISTRY_INVALID", "Expected an ISO timestamp.", path);
  return new Date(value).toISOString();
}

function rootIdentity(value, path) {
  if (!isObject(value) || typeof value.device !== "string" || typeof value.inode !== "string" ||
      !/^\d+$/u.test(value.device) || !/^\d+$/u.test(value.inode)) {
    fail("REPOSITORY_REGISTRY_INVALID", "Invalid repository root identity.", path);
  }
  return { device: value.device, inode: value.inode };
}

function normalizeEntry(value, index) {
  const path = `$.entries[${index}]`;
  if (!isObject(value)) fail("REPOSITORY_REGISTRY_INVALID", "Registry entry must be an object.", path);
  const allowed = new Set([
    "repository", "root", "rootIdentity", "configuration", "policy", "approvedAt", "approval", "enrolledAt", "updatedAt",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("REPOSITORY_REGISTRY_UNKNOWN_FIELD", `Unknown registry field: ${key}.`, `${path}.${key}`);
  }
  for (const key of allowed) {
    if (!(key in value)) fail("REPOSITORY_REGISTRY_INVALID", `Missing registry field: ${key}.`, `${path}.${key}`);
  }
  if (!isObject(value.repository) || !isObject(value.repository.value)) {
    fail("REPOSITORY_REGISTRY_INVALID", "Invalid repository identity wrapper.", `${path}.repository`);
  }
  const policy = validateRepositoryPolicy(value.policy);
  const identity = repositoryPolicyIdentity(policy.repository);
  const label = repositoryPolicyLabel(policy.repository);
  if (value.repository.identity !== identity || value.repository.label !== label ||
      JSON.stringify(value.repository.value) !== JSON.stringify(policy.repository)) {
    fail("REPOSITORY_REGISTRY_IDENTITY_MISMATCH", "Registry identity does not match its policy.", `${path}.repository`);
  }
  if (typeof value.root !== "string" || !isAbsolute(value.root)) {
    fail("REPOSITORY_REGISTRY_INVALID", "Repository root must be absolute.", `${path}.root`);
  }
  const source = value.configuration?.source;
  if (!isObject(value.configuration) || !["committed", "global"].includes(source) ||
      (source === "committed" && value.configuration.path !== ".proofwake.json") ||
      (source === "global" && value.configuration.path !== null) ||
      typeof value.configuration.fingerprint !== "string") {
    fail("REPOSITORY_REGISTRY_INVALID", "Invalid configuration metadata.", `${path}.configuration`);
  }
  if (value.configuration.fingerprint !== repositoryPolicyFingerprint(policy)) {
    fail("REPOSITORY_REGISTRY_FINGERPRINT_MISMATCH", "Stored policy fingerprint is invalid.", `${path}.configuration.fingerprint`);
  }
  if (!isObject(value.approval) || !["committed", "global-policy", "autodetected"].includes(value.approval.method) ||
      value.approval.actor !== "local-operator") {
    fail("REPOSITORY_REGISTRY_INVALID", "Invalid approval metadata.", `${path}.approval`);
  }
  return {
    repository: { identity, label, value: policy.repository },
    root: value.root,
    rootIdentity: rootIdentity(value.rootIdentity, `${path}.rootIdentity`),
    configuration: {
      source,
      path: value.configuration.path,
      fingerprint: value.configuration.fingerprint,
    },
    policy,
    approvedAt: timestamp(value.approvedAt, `${path}.approvedAt`),
    approval: { method: value.approval.method, actor: "local-operator" },
    enrolledAt: timestamp(value.enrolledAt, `${path}.enrolledAt`),
    updatedAt: timestamp(value.updatedAt, `${path}.updatedAt`),
  };
}

function normalizeRegistry(value) {
  if (!isObject(value) || value.version !== REGISTRY_VERSION || !Array.isArray(value.entries)) {
    fail("REPOSITORY_REGISTRY_INVALID", "Registry must contain version 1 and an entries array.");
  }
  for (const key of Object.keys(value)) {
    if (!["version", "entries"].includes(key)) fail("REPOSITORY_REGISTRY_UNKNOWN_FIELD", `Unknown registry field: ${key}.`, `$.${key}`);
  }
  const entries = value.entries.map(normalizeEntry);
  const identities = new Set();
  const roots = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (identities.has(entry.repository.identity)) {
      fail("REPOSITORY_REGISTRY_DUPLICATE", "Repository identity appears more than once.", `$.entries[${index}].repository.identity`);
    }
    if (roots.has(entry.root)) {
      fail("REPOSITORY_REGISTRY_DUPLICATE", "Repository root appears more than once.", `$.entries[${index}].root`);
    }
    identities.add(entry.repository.identity);
    roots.add(entry.root);
  }
  return { version: REGISTRY_VERSION, entries };
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class RepositoryRegistryStore {
  constructor(path) {
    this.path = path;
    this.lockPath = `${path}.lock`;
  }

  async read() {
    let raw;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT")) return { version: REGISTRY_VERSION, entries: [] };
      throw error;
    }
    if (Buffer.byteLength(raw, "utf8") > REGISTRY_MAX_BYTES) fail("REPOSITORY_REGISTRY_TOO_LARGE", `Registry exceeds ${REGISTRY_MAX_BYTES} bytes.`);
    return normalizeRegistry(parseStrictJson(raw, {
      maxBytes: REGISTRY_MAX_BYTES,
      maxDepth: 20,
      maxArrayLength: 2048,
      maxObjectKeys: 128,
      prefix: "REPOSITORY_REGISTRY",
    }));
  }

  async #lock() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        return async () => rm(this.lockPath, { recursive: true, force: true });
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        try {
          const metadata = await stat(this.lockPath);
          if (Date.now() - metadata.mtimeMs > STALE_LOCK_MS) {
            await rm(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (metadataError) {
          if (isCode(metadataError, "ENOENT")) continue;
          throw metadataError;
        }
        if (Date.now() >= deadline) fail("REPOSITORY_REGISTRY_LOCK_TIMEOUT", "Timed out waiting for the repository registry lock.");
        await delay(20);
      }
    }
  }

  async #write(registry) {
    const normalized = normalizeRegistry(registry);
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = join(parent, `.${randomUUID()}.repositories.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
    await syncDirectory(parent);
  }

  async enroll(proposal, options = {}) {
    const release = await this.#lock();
    try {
      const registry = await this.read();
      const identity = proposal.repository.identity;
      const root = await realpath(proposal.root);
      const existingByIdentity = registry.entries.findIndex((entry) => entry.repository.identity === identity);
      const existingByRoot = registry.entries.findIndex((entry) => entry.root === root);
      const existingIndex = existingByIdentity !== -1 ? existingByIdentity : existingByRoot;
      if (existingByIdentity !== -1 && existingByRoot !== -1 && existingByIdentity !== existingByRoot) {
        fail("REPOSITORY_REGISTRY_CONFLICT", "Repository identity and root belong to different registry entries.");
      }
      if (existingIndex !== -1 && !options.replace) {
        const existing = registry.entries[existingIndex];
        if (existing.repository.identity === identity && existing.root === root &&
            existing.configuration.fingerprint === proposal.configuration.fingerprint) {
          return { status: "unchanged", entry: existing };
        }
        fail("REPOSITORY_ALREADY_ENROLLED", "Repository is already enrolled with different metadata; use --replace.");
      }
      if (proposal.configuration.source === "autodetected" && !options.approveAutodetected) {
        fail("REPOSITORY_APPROVAL_REQUIRED", "Autodetected policy requires --approve-autodetected before registry persistence.");
      }
      const now = (options.now ?? new Date()).toISOString();
      const configurationSource = proposal.configuration.source === "autodetected" ? "global" : proposal.configuration.source;
      const entry = normalizeEntry({
        repository: proposal.repository,
        root,
        rootIdentity: proposal.rootIdentity,
        configuration: {
          source: configurationSource,
          path: configurationSource === "committed" ? ".proofwake.json" : null,
          fingerprint: proposal.configuration.fingerprint,
        },
        policy: proposal.policy,
        approvedAt: now,
        approval: {
          method: proposal.configuration.source === "committed"
            ? "committed"
            : proposal.configuration.source === "global"
              ? "global-policy"
              : "autodetected",
          actor: "local-operator",
        },
        enrolledAt: existingIndex === -1 ? now : registry.entries[existingIndex].enrolledAt,
        updatedAt: now,
      }, existingIndex === -1 ? registry.entries.length : existingIndex);
      if (existingIndex === -1) registry.entries.push(entry);
      else registry.entries[existingIndex] = entry;
      registry.entries.sort((left, right) => left.repository.identity.localeCompare(right.repository.identity));
      await this.#write(registry);
      return { status: existingIndex === -1 ? "inserted" : "updated", entry };
    } finally {
      await release();
    }
  }
}
