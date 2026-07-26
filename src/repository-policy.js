import { createHash } from "node:crypto";

export const REPOSITORY_POLICY_SCHEMA = "urn:proofwake:schema:repository-policy:v1";
export const REPOSITORY_POLICY_FILENAME = ".proofwake.json";

const MAX_SIGNALS = 32;
const MAX_ADAPTERS = 16;
const MAX_SOURCES = 16;
const MAX_STRING = 512;

const TOP_LEVEL_KEYS = new Set(["version", "repository", "lifecycle", "signals", "adapters"]);
const REPOSITORY_KEYS = new Set(["kind", "id", "provider", "localId", "displayName"]);
const LIFECYCLE_KEYS = new Set(["state", "dormantAfterDays"]);
const SIGNAL_KEYS = new Set(["kind", "requirement", "subject", "appliesTo", "freshness", "acceptedSources"]);
const FRESHNESS_KEYS = new Set(["mode", "hours"]);
const ADAPTER_KEYS = new Set(["name", "type", "path", "schema", "trust"]);

const SIGNAL_KINDS = new Set([
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
const REQUIREMENTS = new Set(["required", "optional"]);
const SUBJECTS = new Set(["revision", "repository", "host", "service", "deployment"]);
const APPLICABILITY = new Set([
  "every-revision",
  "default-branch",
  "deployed-revision",
  "release",
  "repository",
  "host",
  "service",
  "deployment",
]);
const APPLICABILITY_BY_SUBJECT = Object.freeze({
  revision: new Set(["every-revision", "default-branch", "deployed-revision", "release"]),
  repository: new Set(["repository"]),
  host: new Set(["host"]),
  service: new Set(["service"]),
  deployment: new Set(["deployment"]),
});
const FRESHNESS_MODES = new Set(["revision", "duration", "none"]);
const LIFECYCLE_STATES = new Set(["active", "dormant"]);
const TRUST_CLASSES = new Set([
  "local-operator",
  "signed-provider",
  "verified-receipt",
  "authenticated-client",
  "untrusted-observation",
]);
const BUILTIN_SOURCES = new Set(["local-command", "github", "manual"]);
const SCHEMA_URI_PROTOCOLS = new Set(["https:", "urn:"]);

const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/u;
const SOURCE = /^(?:[a-z0-9][a-z0-9._-]{0,99}|adapter:[a-z0-9][a-z0-9._-]{0,99})$/u;
const REMOTE_REPOSITORY = /^[a-z0-9](?:[a-z0-9._-]{0,99})\/[a-z0-9](?:[a-z0-9._-]{0,99})$/u;
const LOCAL_ID = /^sha256:[a-f0-9]{64}$/u;

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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, required, path) {
  if (!isObject(value)) fail("REPOSITORY_POLICY_INVALID_TYPE", "Expected an object.", path);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("REPOSITORY_POLICY_UNKNOWN_FIELD", `Unknown field: ${key}.`, `${path}.${key}`);
  }
  for (const key of required) {
    if (!(key in value)) fail("REPOSITORY_POLICY_MISSING_FIELD", `Missing required field: ${key}.`, `${path}.${key}`);
  }
}

function string(value, path, { max = MAX_STRING, pattern } = {}) {
  if (typeof value !== "string") fail("REPOSITORY_POLICY_INVALID_TYPE", "Expected a string.", path);
  if (value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("REPOSITORY_POLICY_INVALID_VALUE", `String must contain 1..${max} characters without controls.`, path);
  }
  if (pattern && !pattern.test(value)) fail("REPOSITORY_POLICY_INVALID_VALUE", "String has an invalid format.", path);
  return value;
}

function enumValue(value, values, path) {
  string(value, path, { max: 100 });
  if (!values.has(value)) fail("REPOSITORY_POLICY_INVALID_VALUE", `Unsupported value: ${value}.`, path);
  return value;
}

function integer(value, path, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("REPOSITORY_POLICY_INVALID_VALUE", `Expected an integer between ${minimum} and ${maximum}.`, path);
  }
  return value;
}

function normalizeRepository(repository) {
  exactKeys(repository, REPOSITORY_KEYS, ["kind"], "$.repository");
  const kind = enumValue(repository.kind, new Set(["remote", "local"]), "$.repository.kind");
  if (kind === "remote") {
    if ("localId" in repository || "displayName" in repository) {
      fail("REPOSITORY_POLICY_IDENTITY_CONFLICT", "Remote repository identity must not include local fields.", "$.repository");
    }
    exactKeys(repository, REPOSITORY_KEYS, ["kind", "id", "provider"], "$.repository");
    const id = string(repository.id, "$.repository.id", { max: 201, pattern: REMOTE_REPOSITORY }).toLowerCase();
    const provider = string(repository.provider, "$.repository.provider", { max: 100, pattern: SLUG }).toLowerCase();
    return { kind, id, provider };
  }
  if ("id" in repository || "provider" in repository) {
    fail("REPOSITORY_POLICY_IDENTITY_CONFLICT", "Local repository identity must not include remote fields.", "$.repository");
  }
  exactKeys(repository, REPOSITORY_KEYS, ["kind", "localId", "displayName"], "$.repository");
  const localId = string(repository.localId, "$.repository.localId", { max: 71, pattern: LOCAL_ID });
  const displayName = string(repository.displayName, "$.repository.displayName", { max: 100, pattern: SLUG }).toLowerCase();
  return { kind, localId, displayName };
}

function normalizeLifecycle(lifecycle) {
  exactKeys(lifecycle, LIFECYCLE_KEYS, ["state"], "$.lifecycle");
  const state = enumValue(lifecycle.state, LIFECYCLE_STATES, "$.lifecycle.state");
  if (state === "active") {
    if (!("dormantAfterDays" in lifecycle)) {
      fail("REPOSITORY_POLICY_MISSING_FIELD", "Active policy requires dormantAfterDays.", "$.lifecycle.dormantAfterDays");
    }
    return {
      state,
      dormantAfterDays: integer(lifecycle.dormantAfterDays, "$.lifecycle.dormantAfterDays", 1, 3650),
    };
  }
  if ("dormantAfterDays" in lifecycle) {
    fail("REPOSITORY_POLICY_LIFECYCLE_CONFLICT", "Dormant policy must not declare dormantAfterDays.", "$.lifecycle.dormantAfterDays");
  }
  return { state };
}

function normalizeFreshness(freshness, path) {
  exactKeys(freshness, FRESHNESS_KEYS, ["mode"], path);
  const mode = enumValue(freshness.mode, FRESHNESS_MODES, `${path}.mode`);
  if (mode === "duration") {
    if (!("hours" in freshness)) fail("REPOSITORY_POLICY_MISSING_FIELD", "Duration freshness requires hours.", `${path}.hours`);
    return { mode, hours: integer(freshness.hours, `${path}.hours`, 1, 87_600) };
  }
  if ("hours" in freshness) {
    fail("REPOSITORY_POLICY_FRESHNESS_CONFLICT", `${mode} freshness must not declare hours.`, `${path}.hours`);
  }
  return { mode };
}

function normalizeSignal(signal, index) {
  const path = `$.signals[${index}]`;
  exactKeys(signal, SIGNAL_KEYS, ["kind", "requirement", "subject", "appliesTo", "freshness", "acceptedSources"], path);
  const kind = enumValue(signal.kind, SIGNAL_KINDS, `${path}.kind`);
  const requirement = enumValue(signal.requirement, REQUIREMENTS, `${path}.requirement`);
  const subject = enumValue(signal.subject, SUBJECTS, `${path}.subject`);
  const appliesTo = enumValue(signal.appliesTo, APPLICABILITY, `${path}.appliesTo`);
  if (!APPLICABILITY_BY_SUBJECT[subject].has(appliesTo)) {
    fail(
      "REPOSITORY_POLICY_APPLICABILITY_CONFLICT",
      `${appliesTo} does not apply to ${subject} observations.`,
      `${path}.appliesTo`,
    );
  }
  const freshness = normalizeFreshness(signal.freshness, `${path}.freshness`);

  if (subject === "revision" && freshness.mode !== "revision") {
    fail("REPOSITORY_POLICY_FRESHNESS_CONFLICT", "Revision signals require revision freshness.", `${path}.freshness.mode`);
  }
  if (subject !== "revision" && freshness.mode === "revision") {
    fail("REPOSITORY_POLICY_FRESHNESS_CONFLICT", "Revision freshness requires a revision subject.", `${path}.freshness.mode`);
  }
  if (requirement === "required" && freshness.mode === "none") {
    fail("REPOSITORY_POLICY_FRESHNESS_CONFLICT", "Required signals must declare revision or duration freshness.", `${path}.freshness.mode`);
  }

  if (!Array.isArray(signal.acceptedSources) || signal.acceptedSources.length < 1 || signal.acceptedSources.length > MAX_SOURCES) {
    fail("REPOSITORY_POLICY_INVALID_VALUE", `acceptedSources must contain 1..${MAX_SOURCES} entries.`, `${path}.acceptedSources`);
  }
  const seen = new Set();
  const acceptedSources = signal.acceptedSources.map((value, sourceIndex) => {
    const sourcePath = `${path}.acceptedSources[${sourceIndex}]`;
    const normalized = string(value, sourcePath, { max: 108, pattern: SOURCE }).toLowerCase();
    if (seen.has(normalized)) fail("REPOSITORY_POLICY_DUPLICATE_VALUE", "acceptedSources must be unique.", sourcePath);
    seen.add(normalized);
    return normalized;
  });

  return { kind, requirement, subject, appliesTo, freshness, acceptedSources };
}

function validateReceiptPath(value, path) {
  string(value, path, { max: 512 });
  if (value.includes("\\") || value.includes(":") || /\s/u.test(value) || value.startsWith("/") || value.includes("\0")) {
    fail("REPOSITORY_POLICY_PATH_ESCAPE", "Receipt path must be a portable repository-relative path.", path);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("REPOSITORY_POLICY_PATH_ESCAPE", "Receipt path must not contain empty, current, or parent segments.", path);
  }
  if (/[?*\[\]{}]/u.test(value)) {
    fail("REPOSITORY_POLICY_PATH_ESCAPE", "Receipt path must name one file, not a glob.", path);
  }
  return value;
}

function validateSchemaName(value, path) {
  string(value, path, { max: 256 });
  if (SLUG.test(value)) return value;
  if (/\s/u.test(value)) {
    fail("REPOSITORY_POLICY_INVALID_VALUE", "Schema identifiers must not contain whitespace.", path);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("REPOSITORY_POLICY_INVALID_VALUE", "Schema must be a stable token, HTTPS URL, or URN.", path);
  }
  if (!SCHEMA_URI_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password || (parsed.protocol === "urn:" && parsed.pathname.length === 0)) {
    fail("REPOSITORY_POLICY_INVALID_VALUE", "Schema must be a stable token, HTTPS URL, or non-empty URN without credentials.", path);
  }
  return parsed.href;
}

function normalizeAdapter(adapter, index) {
  const path = `$.adapters[${index}]`;
  exactKeys(adapter, ADAPTER_KEYS, ["name", "type", "path", "schema", "trust"], path);
  const name = string(adapter.name, `${path}.name`, { max: 100, pattern: SLUG }).toLowerCase();
  if (adapter.type !== "receipt-file") {
    fail("REPOSITORY_POLICY_INVALID_VALUE", "Only receipt-file adapters are supported in policy v1.", `${path}.type`);
  }
  return {
    name,
    type: "receipt-file",
    path: validateReceiptPath(adapter.path, `${path}.path`),
    schema: validateSchemaName(adapter.schema, `${path}.schema`),
    trust: enumValue(adapter.trust, TRUST_CLASSES, `${path}.trust`),
  };
}

export function validateRepositoryPolicy(policy) {
  exactKeys(policy, TOP_LEVEL_KEYS, ["version", "repository", "lifecycle", "signals", "adapters"], "$");
  if (policy.version !== 1) fail("REPOSITORY_POLICY_INVALID_VERSION", "version must be 1.", "$.version");

  const repository = normalizeRepository(policy.repository);
  const lifecycle = normalizeLifecycle(policy.lifecycle);

  if (!Array.isArray(policy.signals) || policy.signals.length > MAX_SIGNALS) {
    fail("REPOSITORY_POLICY_INVALID_VALUE", `signals must contain at most ${MAX_SIGNALS} entries.`, "$.signals");
  }
  const signalKinds = new Set();
  const signals = policy.signals.map((signal, index) => {
    const normalized = normalizeSignal(signal, index);
    if (signalKinds.has(normalized.kind)) {
      fail("REPOSITORY_POLICY_DUPLICATE_VALUE", "Signal kinds must be unique.", `$.signals[${index}].kind`);
    }
    signalKinds.add(normalized.kind);
    return normalized;
  });

  if (!Array.isArray(policy.adapters) || policy.adapters.length > MAX_ADAPTERS) {
    fail("REPOSITORY_POLICY_INVALID_VALUE", `adapters must contain at most ${MAX_ADAPTERS} entries.`, "$.adapters");
  }
  const adapterNames = new Set();
  const adapters = policy.adapters.map((adapter, index) => {
    const normalized = normalizeAdapter(adapter, index);
    if (adapterNames.has(normalized.name)) {
      fail("REPOSITORY_POLICY_DUPLICATE_VALUE", "Adapter names must be unique.", `$.adapters[${index}].name`);
    }
    adapterNames.add(normalized.name);
    return normalized;
  });

  for (let signalIndex = 0; signalIndex < signals.length; signalIndex += 1) {
    for (let sourceIndex = 0; sourceIndex < signals[signalIndex].acceptedSources.length; sourceIndex += 1) {
      const source = signals[signalIndex].acceptedSources[sourceIndex];
      if (BUILTIN_SOURCES.has(source)) continue;
      const adapterName = source.startsWith("adapter:") ? source.slice("adapter:".length) : null;
      if (!adapterName || !adapterNames.has(adapterName)) {
        fail(
          "REPOSITORY_POLICY_ADAPTER_MISSING",
          `Accepted source does not reference a declared adapter: ${source}.`,
          `$.signals[${signalIndex}].acceptedSources[${sourceIndex}]`,
        );
      }
    }
  }

  const requiredSignals = signals.filter((signal) => signal.requirement === "required");
  if (lifecycle.state === "active" && requiredSignals.length === 0) {
    fail("REPOSITORY_POLICY_LIFECYCLE_CONFLICT", "Active policy requires at least one required signal.", "$.signals");
  }
  if (lifecycle.state === "dormant" && requiredSignals.length > 0) {
    fail("REPOSITORY_POLICY_LIFECYCLE_CONFLICT", "Dormant policy must not require signals.", "$.signals");
  }

  return { version: 1, repository, lifecycle, signals, adapters };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function repositoryPolicyFingerprint(policy) {
  const normalized = validateRepositoryPolicy(policy);
  return `sha256:${createHash("sha256").update(canonical(normalized), "utf8").digest("hex")}`;
}
