import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { parseStrictJson } from "./strict-json.js";
import {
  REPOSITORY_POLICY_FILENAME,
  RepositoryPolicyError,
  repositoryPolicyFingerprint,
  validateRepositoryPolicy,
} from "./repository-policy.js";

export const REPOSITORY_POLICY_MAX_BYTES = 32_768;

function isCode(error, code) {
  return error && typeof error === "object" && "code" in error && error.code === code;
}

function changed(before, after) {
  return before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RepositoryPolicyError("REPOSITORY_POLICY_INVALID_UTF8", "Repository policy must be valid UTF-8.");
  }
}

export function parseRepositoryPolicyJson(text) {
  const value = parseStrictJson(text, {
    maxBytes: REPOSITORY_POLICY_MAX_BYTES,
    maxDepth: 12,
    maxStringLength: 4_096,
    maxObjectKeys: 128,
    maxArrayLength: 64,
    prefix: "REPOSITORY_POLICY",
  });
  return validateRepositoryPolicy(value);
}

export async function readRepositoryPolicyFile(path) {
  let pathMetadata;
  try {
    pathMetadata = await lstat(path);
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw new RepositoryPolicyError("REPOSITORY_POLICY_UNAVAILABLE", "Repository policy could not be inspected.");
  }
  if (pathMetadata.isSymbolicLink()) {
    throw new RepositoryPolicyError("REPOSITORY_POLICY_SYMLINK", `${REPOSITORY_POLICY_FILENAME} must not be a symbolic link.`);
  }
  if (!pathMetadata.isFile()) {
    throw new RepositoryPolicyError("REPOSITORY_POLICY_NOT_FILE", `${REPOSITORY_POLICY_FILENAME} must be a regular file.`);
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isCode(error, "ELOOP")) {
      throw new RepositoryPolicyError("REPOSITORY_POLICY_SYMLINK", `${REPOSITORY_POLICY_FILENAME} must not be a symbolic link.`);
    }
    throw new RepositoryPolicyError("REPOSITORY_POLICY_UNAVAILABLE", "Repository policy could not be opened.");
  }

  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new RepositoryPolicyError("REPOSITORY_POLICY_NOT_FILE", `${REPOSITORY_POLICY_FILENAME} must be a regular file.`);
    if (before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino) {
      throw new RepositoryPolicyError("REPOSITORY_POLICY_CHANGED", "Repository policy changed before it could be read.");
    }
    if (before.size > REPOSITORY_POLICY_MAX_BYTES) {
      throw new RepositoryPolicyError("REPOSITORY_POLICY_TOO_LARGE", `Repository policy exceeds ${REPOSITORY_POLICY_MAX_BYTES} bytes.`);
    }
    const bytes = await handle.readFile();
    if (bytes.length > REPOSITORY_POLICY_MAX_BYTES) {
      throw new RepositoryPolicyError("REPOSITORY_POLICY_TOO_LARGE", `Repository policy exceeds ${REPOSITORY_POLICY_MAX_BYTES} bytes.`);
    }
    const after = await handle.stat();
    if (changed(before, after)) throw new RepositoryPolicyError("REPOSITORY_POLICY_CHANGED", "Repository policy changed while it was being read.");
    return parseRepositoryPolicyJson(decodeUtf8(bytes));
  } finally {
    await handle.close();
  }
}

export function repositoryPolicyIdentity(repository) {
  return repository.kind === "remote" ? repository.id : `local:${repository.localId}`;
}

export function repositoryPolicyLabel(repository) {
  return repository.kind === "remote" ? repository.id : repository.displayName;
}

function inside(root, path) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export async function inspectAdapterPaths(root, adapters) {
  const canonicalRoot = await realpath(root);
  const result = {};
  for (const adapter of adapters) {
    const candidate = resolve(canonicalRoot, adapter.path);
    if (!inside(canonicalRoot, candidate)) {
      result[adapter.name] = {
        path: adapter.path,
        schema: adapter.schema,
        trust: adapter.trust,
        state: "unsafe",
        code: "REPOSITORY_ADAPTER_PATH_ESCAPE",
      };
      continue;
    }
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        result[adapter.name] = {
          path: adapter.path,
          schema: adapter.schema,
          trust: adapter.trust,
          state: "missing",
          code: "REPOSITORY_ADAPTER_MISSING",
        };
        continue;
      }
      result[adapter.name] = {
        path: adapter.path,
        schema: adapter.schema,
        trust: adapter.trust,
        state: "unavailable",
        code: "REPOSITORY_ADAPTER_UNAVAILABLE",
      };
      continue;
    }
    if (metadata.isSymbolicLink()) {
      result[adapter.name] = {
        path: adapter.path,
        schema: adapter.schema,
        trust: adapter.trust,
        state: "unsafe",
        code: "REPOSITORY_ADAPTER_SYMLINK",
      };
      continue;
    }
    if (!metadata.isFile()) {
      result[adapter.name] = {
        path: adapter.path,
        schema: adapter.schema,
        trust: adapter.trust,
        state: "unsafe",
        code: "REPOSITORY_ADAPTER_NOT_FILE",
      };
      continue;
    }
    let canonical;
    try {
      canonical = await realpath(candidate);
    } catch {
      result[adapter.name] = {
        path: adapter.path,
        schema: adapter.schema,
        trust: adapter.trust,
        state: "unavailable",
        code: "REPOSITORY_ADAPTER_UNAVAILABLE",
      };
      continue;
    }
    if (!inside(canonicalRoot, canonical)) {
      result[adapter.name] = {
        path: adapter.path,
        schema: adapter.schema,
        trust: adapter.trust,
        state: "unsafe",
        code: "REPOSITORY_ADAPTER_PATH_ESCAPE",
      };
      continue;
    }
    result[adapter.name] = {
      path: adapter.path,
      schema: adapter.schema,
      trust: adapter.trust,
      state: "ready",
      code: null,
      sizeBytes: metadata.size,
    };
  }
  return result;
}

export function repositoryPolicySummary(policy) {
  return {
    identity: repositoryPolicyIdentity(policy.repository),
    label: repositoryPolicyLabel(policy.repository),
    fingerprint: repositoryPolicyFingerprint(policy),
    lifecycle: policy.lifecycle.state,
    requiredSignals: policy.signals.filter((signal) => signal.requirement === "required").length,
    optionalSignals: policy.signals.filter((signal) => signal.requirement === "optional").length,
  };
}
