import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseStrictJson } from "./strict-json.js";

export const REPOSITORY_POLICY_SCHEMA = "https://raw.githubusercontent.com/teamleaderleo/proofwake/main/schema/repository-v1.schema.json";
export const REPOSITORY_POLICY_MAX_BYTES = 32_768;

export const REPOSITORY_SIGNAL_KINDS = Object.freeze([
  "verify",
  "github-ci",
  "browser-review",
  "deployment",
  "service-check",
  "domain-check",
  "host-diagnostic",
  "local-diagnostic",
  "shadowbill-estimate",
]);

export const REPOSITORY_SIGNAL_SCOPES = Object.freeze([
  "revision",
  "default-branch",
  "release",
  "deployment",
  "repository",
  "host",
]);

const POLICY_KEYS = new Set(["$schema", "version", "repository", "lifecycle", "expectedSignals", "adapters"]);
const SIGNAL_KEYS = new Set(["kind", "required", "staleAfterHours", "scope"]);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ADAPTER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PORTABLE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

export class RepositoryPolicyError extends Error {
  constructor(code, message, path = "$") {
    super(message);
    this.name = "RepositoryPolicyError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "$") {
  throw new RepositoryPolicyError(code, message, path);
}

function requireObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("REPOSITORY_POLICY_INVALID_TYPE", "Expected an object.", path);
  }
}

function exactKeys(value, allowed, required, path) {
  requireObject(value, path);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("REPOSITORY_POLICY_UNKNOWN_FIELD", `Unknown field: ${key}.`, `${path}.${key}`);
  }
  for (const key of required) {
    if (!(key in value)) fail("REPOSITORY_POLICY_MISSING_FIELD", `Missing required field: ${key}.`, `${path}.${key}`);
  }
}

function requireString(value, path, { max = 256, pattern } = {}) {
  if (typeof value !== "string") fail("REPOSITORY_POLICY_INVALID_TYPE", "Expected a string.", path);
  if (value.length === 0 || value.length > max) fail("REPOSITORY_POLICY_INVALID_LENGTH", `String length must be 1..${max}.`, path);
  if (pattern && !pattern.test(value)) fail("REPOSITORY_POLICY_INVALID_VALUE", "String value has an invalid format.", path);
}

function requireBoolean(value, path) {
  if (typeof value !== "boolean") fail("REPOSITORY_POLICY_INVALID_TYPE", "Expected a boolean.", path);
}

function requireInteger(value, path, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("REPOSITORY_POLICY_INVALID_VALUE", `Expected an integer between ${minimum} and ${maximum}.`, path);
  }
}

function validateSignal(signal, index) {
  const path = `$.expectedSignals[${index}]`;
  exactKeys(signal, SIGNAL_KEYS, ["kind", "required", "staleAfterHours", "scope"], path);
  requireString(signal.kind, `${path}.kind`, { max: 64 });
  if (!REPOSITORY_SIGNAL_KINDS.includes(signal.kind)) {
    fail("REPOSITORY_POLICY_INVALID_VALUE", `Unsupported signal kind: ${signal.kind}.`, `${path}.kind`);
  }
  requireBoolean(signal.required, `${path}.required`);
  requireInteger(signal.staleAfterHours, `${path}.staleAfterHours`, 0, 8_760);
  requireString(signal.scope, `${path}.scope`, { max: 32 });
  if (!REPOSITORY_SIGNAL_SCOPES.includes(signal.scope)) {
    fail("REPOSITORY_POLICY_INVALID_VALUE", `Unsupported signal scope: ${signal.scope}.`, `${path}.scope`);
  }
}

export function validatePortableAdapterPath(value, path = "$.adapters") {
  requireString(value, path, { max: 240 });
  if (value.includes("\\") || value.includes("\0") || isAbsolute(value)) {
    fail("REPOSITORY_POLICY_INVALID_ADAPTER_PATH", "Adapter paths must be portable project-relative paths.", path);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || !PORTABLE_PATH_SEGMENT.test(segment))) {
    fail("REPOSITORY_POLICY_INVALID_ADAPTER_PATH", "Adapter paths contain an unsupported segment.", path);
  }
  return segments;
}

export function validateRepositoryPolicy(value) {
  exactKeys(value, POLICY_KEYS, ["version", "repository", "expectedSignals", "adapters"], "$");
  if ("$schema" in value && value.$schema !== REPOSITORY_POLICY_SCHEMA) {
    fail("REPOSITORY_POLICY_INVALID_SCHEMA", `Unsupported repository schema: ${value.$schema}.`, "$.$schema");
  }
  if (value.version !== 1) fail("REPOSITORY_POLICY_INVALID_VERSION", "Repository policy version must be 1.", "$.version");
  requireString(value.repository, "$.repository", { max: 200, pattern: REPOSITORY });
  if ("lifecycle" in value && !["active", "dormant"].includes(value.lifecycle)) {
    fail("REPOSITORY_POLICY_INVALID_VALUE", "Lifecycle must be active or dormant.", "$.lifecycle");
  }
  if (!Array.isArray(value.expectedSignals) || value.expectedSignals.length > 32) {
    fail("REPOSITORY_POLICY_INVALID_VALUE", "expectedSignals must contain at most 32 entries.", "$.expectedSignals");
  }
  const signalKinds = new Set();
  value.expectedSignals.forEach((signal, index) => {
    validateSignal(signal, index);
    if (signalKinds.has(signal.kind)) {
      fail("REPOSITORY_POLICY_DUPLICATE_SIGNAL", `Duplicate signal kind: ${signal.kind}.`, `$.expectedSignals[${index}].kind`);
    }
    signalKinds.add(signal.kind);
  });
  requireObject(value.adapters, "$.adapters");
  const adapters = Object.entries(value.adapters);
  if (adapters.length > 16) fail("REPOSITORY_POLICY_INVALID_VALUE", "adapters must contain at most 16 entries.", "$.adapters");
  for (const [name, adapterPath] of adapters) {
    requireString(name, `$.adapters.${name}`, { max: 64, pattern: ADAPTER_NAME });
    validatePortableAdapterPath(adapterPath, `$.adapters.${name}`);
  }
  return value;
}

export function normalizeRepositoryPolicy(value) {
  validateRepositoryPolicy(value);
  return {
    $schema: REPOSITORY_POLICY_SCHEMA,
    version: 1,
    repository: value.repository,
    lifecycle: value.lifecycle ?? "active",
    expectedSignals: [...value.expectedSignals]
      .map((signal) => ({
        kind: signal.kind,
        required: signal.required,
        staleAfterHours: signal.staleAfterHours,
        scope: signal.scope,
      }))
      .sort((left, right) => left.kind.localeCompare(right.kind)),
    adapters: Object.fromEntries(Object.entries(value.adapters).sort(([left], [right]) => left.localeCompare(right))),
  };
}

export function parseRepositoryPolicyJson(text) {
  const value = parseStrictJson(text, {
    maxBytes: REPOSITORY_POLICY_MAX_BYTES,
    maxDepth: 8,
    prefix: "REPOSITORY_POLICY",
  });
  return normalizeRepositoryPolicy(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function repositoryPolicyDigest(policy) {
  const normalized = normalizeRepositoryPolicy(policy);
  return `sha256:${createHash("sha256").update(canonical(normalized), "utf8").digest("hex")}`;
}

function statChanged(before, after) {
  return before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs;
}

export async function readRepositoryPolicyFile(path) {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw new RepositoryPolicyError(
      "REPOSITORY_POLICY_UNAVAILABLE",
      `Repository policy could not be opened: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) fail("REPOSITORY_POLICY_NOT_FILE", "Repository policy must be a regular file.");
    if (before.size > REPOSITORY_POLICY_MAX_BYTES) fail("REPOSITORY_POLICY_TOO_LARGE", `Repository policy exceeds ${REPOSITORY_POLICY_MAX_BYTES} bytes.`);
    const bytes = await handle.readFile();
    if (bytes.length > REPOSITORY_POLICY_MAX_BYTES) fail("REPOSITORY_POLICY_TOO_LARGE", `Repository policy exceeds ${REPOSITORY_POLICY_MAX_BYTES} bytes.`);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("REPOSITORY_POLICY_INVALID_UTF8", "Repository policy must be valid UTF-8.");
    }
    const after = await handle.stat();
    if (statChanged(before, after)) fail("REPOSITORY_POLICY_CHANGED", "Repository policy changed while it was being read.");
    return parseRepositoryPolicyJson(text);
  } finally {
    await handle.close();
  }
}

function within(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function inspectAdapterPaths(rootPath, adapters) {
  const root = await realpath(rootPath);
  const results = {};
  for (const [name, adapterPath] of Object.entries(adapters)) {
    const segments = validatePortableAdapterPath(adapterPath, `$.adapters.${name}`);
    let current = root;
    let exists = true;
    let escaped = false;
    for (let index = 0; index < segments.length; index += 1) {
      const candidate = join(current, segments[index]);
      try {
        const metadata = await lstat(candidate);
        if (metadata.isSymbolicLink()) {
          const resolved = await realpath(candidate);
          if (!within(root, resolved)) {
            escaped = true;
            break;
          }
          current = resolved;
        } else {
          current = candidate;
        }
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          exists = false;
          current = resolve(current, ...segments.slice(index));
          break;
        }
        throw error;
      }
    }
    if (escaped || !within(root, current)) {
      fail("REPOSITORY_ADAPTER_PATH_ESCAPE", `Adapter path escapes the repository root: ${adapterPath}.`, `$.adapters.${name}`);
    }
    results[name] = { path: adapterPath, exists };
  }
  return results;
}
