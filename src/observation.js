import { createHash } from "node:crypto";

export const OBSERVATION_SCHEMA = "urn:proofwake:schema:observation:v1";
export const OBSERVATION_MAX_BYTES = 65_536;
export const OBSERVATION_MAX_DEPTH = 16;

const TOP_LEVEL_KEYS = new Set([
  "specversion", "id", "source", "type", "subject", "time", "dataschema", "data",
]);
const DATA_KEYS = new Set([
  "schemaVersion", "adapter", "kind", "status", "timeSource", "observedAt", "ingestedAt",
  "durationMs", "relationships", "facts", "evidence", "coverage",
]);
const ADAPTER_KEYS = new Set([
  "name", "version", "mappingVersion", "trust", "sourceSchema", "sourceSchemaVersion",
]);
const RELATIONSHIP_KEYS = new Set([
  "repository", "revision", "run", "workflowAttempt", "deployment", "service", "causation", "correlations",
]);
const FACT_KEYS = new Set(["name", "value"]);
const EVIDENCE_KEYS = new Set([
  "uri", "digest", "sizeBytes", "mediaType", "producer", "schema", "state", "disclosure",
]);
const COVERAGE_KEYS = new Set(["state", "redacted", "truncated", "omitted"]);

const KINDS = new Set([
  "verify", "github-ci", "browser-review", "deployment", "service-check", "domain-check",
  "host-diagnostic", "local-diagnostic", "shadowbill-estimate",
]);
const STATUSES = new Set(["passed", "failed", "warning", "unknown", "unavailable", "cancelled"]);
const TIME_SOURCES = new Set(["producer", "provider", "adapter"]);
const TRUST_CLASSES = new Set([
  "local-operator", "signed-provider", "verified-receipt", "authenticated-client", "untrusted-observation",
]);
const DISCLOSURE_CLASSES = new Set([
  "public-metadata", "private-metadata", "restricted-reference", "content-excluded",
]);
const EVIDENCE_STATES = new Set(["verified", "unavailable", "redacted", "truncated"]);
const COVERAGE_STATES = new Set(["complete", "partial", "unavailable"]);

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const FACT_NAME = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const EVENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SAFE_FACT_STRING = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SUBJECT_PATTERNS = [
  ["repository-revision", /^repo:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@sha:([a-f0-9]{40})$/],
  ["repository", /^repo:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/],
  ["host", /^host:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/],
  ["service", /^service:([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})$/],
  ["deployment", /^deployment:([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})$/],
  ["run", /^run:([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})$/],
  ["artifact", /^artifact:(sha256:[a-f0-9]{64})$/],
];

export class ObservationError extends Error {
  constructor(code, message, path = "$") {
    super(message);
    this.name = "ObservationError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "$") {
  throw new ObservationError(code, message, path);
}

function skipWhitespace(text, cursor) {
  while (cursor.index < text.length && /\s/.test(text[cursor.index])) cursor.index += 1;
}

function parseJsonString(text, cursor) {
  const start = cursor.index;
  cursor.index += 1;
  while (cursor.index < text.length) {
    const code = text.charCodeAt(cursor.index);
    if (code === 0x22) {
      cursor.index += 1;
      try {
        return JSON.parse(text.slice(start, cursor.index));
      } catch {
        fail("OBSERVATION_INVALID_JSON", "Invalid JSON string escape.");
      }
    }
    if (code < 0x20) fail("OBSERVATION_INVALID_JSON", "Unescaped control character in JSON string.");
    if (code === 0x5c) {
      cursor.index += 1;
      if (cursor.index >= text.length) fail("OBSERVATION_INVALID_JSON", "Incomplete JSON escape.");
      if (text[cursor.index] === "u") {
        const hex = text.slice(cursor.index + 1, cursor.index + 5);
        if (!/^[a-fA-F0-9]{4}$/.test(hex)) fail("OBSERVATION_INVALID_JSON", "Invalid Unicode escape.");
        cursor.index += 5;
        continue;
      }
      if (!/["\\/bfnrt]/.test(text[cursor.index])) fail("OBSERVATION_INVALID_JSON", "Invalid JSON escape.");
    }
    cursor.index += 1;
  }
  fail("OBSERVATION_INVALID_JSON", "Unterminated JSON string.");
}

function parseJsonNumber(text, cursor) {
  const match = text.slice(cursor.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  if (!match) fail("OBSERVATION_INVALID_JSON", "Invalid JSON number.");
  cursor.index += match[0].length;
}

function parseJsonValue(text, cursor, depth, path) {
  if (depth > OBSERVATION_MAX_DEPTH) fail("OBSERVATION_TOO_DEEP", `JSON nesting exceeds ${OBSERVATION_MAX_DEPTH}.`, path);
  skipWhitespace(text, cursor);
  const char = text[cursor.index];
  if (char === "{") return parseJsonObject(text, cursor, depth + 1, path);
  if (char === "[") return parseJsonArray(text, cursor, depth + 1, path);
  if (char === '"') return parseJsonString(text, cursor);
  if (char === "-" || /\d/.test(char ?? "")) return parseJsonNumber(text, cursor);
  for (const literal of ["true", "false", "null"]) {
    if (text.startsWith(literal, cursor.index)) {
      cursor.index += literal.length;
      return;
    }
  }
  fail("OBSERVATION_INVALID_JSON", "Unexpected JSON token.", path);
}

function parseJsonObject(text, cursor, depth, path) {
  cursor.index += 1;
  skipWhitespace(text, cursor);
  if (text[cursor.index] === "}") {
    cursor.index += 1;
    return;
  }
  const keys = new Set();
  while (cursor.index < text.length) {
    skipWhitespace(text, cursor);
    if (text[cursor.index] !== '"') fail("OBSERVATION_INVALID_JSON", "Object keys must be strings.", path);
    const key = parseJsonString(text, cursor);
    if (keys.has(key)) fail("OBSERVATION_DUPLICATE_KEY", `Duplicate JSON key: ${key}.`, `${path}.${key}`);
    keys.add(key);
    skipWhitespace(text, cursor);
    if (text[cursor.index] !== ":") fail("OBSERVATION_INVALID_JSON", "Expected colon after object key.", `${path}.${key}`);
    cursor.index += 1;
    parseJsonValue(text, cursor, depth, `${path}.${key}`);
    skipWhitespace(text, cursor);
    if (text[cursor.index] === "}") {
      cursor.index += 1;
      return;
    }
    if (text[cursor.index] !== ",") fail("OBSERVATION_INVALID_JSON", "Expected comma between object entries.", path);
    cursor.index += 1;
  }
  fail("OBSERVATION_INVALID_JSON", "Unterminated JSON object.", path);
}

function parseJsonArray(text, cursor, depth, path) {
  cursor.index += 1;
  skipWhitespace(text, cursor);
  if (text[cursor.index] === "]") {
    cursor.index += 1;
    return;
  }
  let index = 0;
  while (cursor.index < text.length) {
    parseJsonValue(text, cursor, depth, `${path}[${index}]`);
    skipWhitespace(text, cursor);
    if (text[cursor.index] === "]") {
      cursor.index += 1;
      return;
    }
    if (text[cursor.index] !== ",") fail("OBSERVATION_INVALID_JSON", "Expected comma between array entries.", path);
    cursor.index += 1;
    index += 1;
  }
  fail("OBSERVATION_INVALID_JSON", "Unterminated JSON array.", path);
}

export function parseObservationJson(text) {
  if (typeof text !== "string") fail("OBSERVATION_INVALID_JSON", "Observation JSON must be a string.");
  if (Buffer.byteLength(text, "utf8") > OBSERVATION_MAX_BYTES) {
    fail("OBSERVATION_TOO_LARGE", `Observation exceeds ${OBSERVATION_MAX_BYTES} bytes.`);
  }
  const cursor = { index: 0 };
  parseJsonValue(text, cursor, 0, "$");
  skipWhitespace(text, cursor);
  if (cursor.index !== text.length) fail("OBSERVATION_INVALID_JSON", "Trailing data after JSON value.");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("OBSERVATION_INVALID_JSON", "Observation contains invalid JSON.");
  }
  validateObservation(value);
  return value;
}

function requireObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("OBSERVATION_INVALID_TYPE", "Expected an object.", path);
}

function exactKeys(value, allowed, required, path) {
  requireObject(value, path);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("OBSERVATION_UNKNOWN_FIELD", `Unknown field: ${key}.`, `${path}.${key}`);
  }
  for (const key of required) {
    if (!(key in value)) fail("OBSERVATION_MISSING_FIELD", `Missing required field: ${key}.`, `${path}.${key}`);
  }
}

function requireString(value, path, { min = 1, max = 256, pattern } = {}) {
  if (typeof value !== "string") fail("OBSERVATION_INVALID_TYPE", "Expected a string.", path);
  if (value.length < min || value.length > max) fail("OBSERVATION_INVALID_LENGTH", `String length must be ${min}..${max}.`, path);
  if (pattern && !pattern.test(value)) fail("OBSERVATION_INVALID_VALUE", "String value has an invalid format.", path);
}

function requireEnum(value, allowed, path) {
  requireString(value, path);
  if (!allowed.has(value)) fail("OBSERVATION_INVALID_VALUE", `Unsupported value: ${value}.`, path);
}

function requireTimestamp(value, path) {
  requireString(value, path, { max: 64 });
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("OBSERVATION_INVALID_TIMESTAMP", "Timestamp must be canonical ISO 8601 UTC.", path);
  }
}

function requireNonNegativeInteger(value, path, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    fail("OBSERVATION_INVALID_VALUE", `Expected a non-negative safe integer no greater than ${max}.`, path);
  }
}

function requireUri(value, path, max = 512) {
  requireString(value, path, { max });
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) fail("OBSERVATION_INVALID_VALUE", "Expected an absolute URI.", path);
  if (/\s/.test(value)) fail("OBSERVATION_INVALID_VALUE", "URI cannot contain whitespace.", path);
}

export function parseObservationSubject(subject) {
  requireString(subject, "$.subject", { max: 300 });
  for (const [kind, pattern] of SUBJECT_PATTERNS) {
    const match = subject.match(pattern);
    if (!match) continue;
    if (kind === "repository-revision") return { kind, repository: match[1], revision: match[2] };
    if (kind === "repository") return { kind, repository: match[1] };
    return { kind, identity: match[1] };
  }
  fail("OBSERVATION_INVALID_SUBJECT", "Unsupported observation subject.", "$.subject");
}

function validateAdapter(adapter) {
  exactKeys(adapter, ADAPTER_KEYS, ["name", "version", "mappingVersion", "trust", "sourceSchema", "sourceSchemaVersion"], "$.data.adapter");
  requireString(adapter.name, "$.data.adapter.name", { max: 64, pattern: TOKEN });
  requireString(adapter.version, "$.data.adapter.version", { max: 64, pattern: TOKEN });
  requireNonNegativeInteger(adapter.mappingVersion, "$.data.adapter.mappingVersion", 65_535);
  requireEnum(adapter.trust, TRUST_CLASSES, "$.data.adapter.trust");
  requireString(adapter.sourceSchema, "$.data.adapter.sourceSchema", { max: 256 });
  if (!(TOKEN.test(adapter.sourceSchema) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(adapter.sourceSchema))) {
    fail("OBSERVATION_INVALID_VALUE", "Source schema must be a token or absolute URI.", "$.data.adapter.sourceSchema");
  }
  requireString(adapter.sourceSchemaVersion, "$.data.adapter.sourceSchemaVersion", { max: 64, pattern: TOKEN });
}

function validateRelationships(relationships) {
  exactKeys(relationships, RELATIONSHIP_KEYS, [], "$.data.relationships");
  if ("repository" in relationships) requireString(relationships.repository, "$.data.relationships.repository", { max: 200, pattern: REPOSITORY });
  if ("revision" in relationships) requireString(relationships.revision, "$.data.relationships.revision", { min: 40, max: 40, pattern: REVISION });
  for (const key of ["run", "deployment", "service", "causation"]) {
    if (key in relationships) requireString(relationships[key], `$.data.relationships.${key}`, { max: 128, pattern: TOKEN });
  }
  if ("workflowAttempt" in relationships) requireNonNegativeInteger(relationships.workflowAttempt, "$.data.relationships.workflowAttempt", 1_000_000);
  if ("correlations" in relationships) {
    if (!Array.isArray(relationships.correlations) || relationships.correlations.length > 8) {
      fail("OBSERVATION_INVALID_VALUE", "Correlations must be an array with at most 8 entries.", "$.data.relationships.correlations");
    }
    const seen = new Set();
    relationships.correlations.forEach((value, index) => {
      requireString(value, `$.data.relationships.correlations[${index}]`, { max: 128, pattern: TOKEN });
      if (seen.has(value)) fail("OBSERVATION_DUPLICATE_VALUE", "Duplicate correlation value.", `$.data.relationships.correlations[${index}]`);
      seen.add(value);
    });
  }
  if ("revision" in relationships && !("repository" in relationships)) {
    fail("OBSERVATION_RELATIONSHIP_CONFLICT", "A revision relationship requires a repository relationship.", "$.data.relationships.revision");
  }
}

function validateFacts(facts) {
  if (!Array.isArray(facts) || facts.length > 64) fail("OBSERVATION_INVALID_VALUE", "Facts must be an array with at most 64 entries.", "$.data.facts");
  const names = new Set();
  facts.forEach((fact, index) => {
    const path = `$.data.facts[${index}]`;
    exactKeys(fact, FACT_KEYS, ["name", "value"], path);
    requireString(fact.name, `${path}.name`, { max: 128, pattern: FACT_NAME });
    if (names.has(fact.name)) fail("OBSERVATION_DUPLICATE_VALUE", "Fact names must be unique.", `${path}.name`);
    names.add(fact.name);
    const value = fact.value;
    if (typeof value === "string") requireString(value, `${path}.value`, { max: 128, pattern: SAFE_FACT_STRING });
    else if (typeof value === "number") {
      if (!Number.isFinite(value) || !Number.isSafeInteger(value)) fail("OBSERVATION_INVALID_VALUE", "Numeric fact values must be safe integers.", `${path}.value`);
    } else if (typeof value !== "boolean") {
      fail("OBSERVATION_INVALID_TYPE", "Fact values must be token strings, safe integers, or booleans.", `${path}.value`);
    }
  });
}

function validateEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length > 16) fail("OBSERVATION_INVALID_VALUE", "Evidence must be an array with at most 16 entries.", "$.data.evidence");
  const digests = new Set();
  evidence.forEach((item, index) => {
    const path = `$.data.evidence[${index}]`;
    exactKeys(item, EVIDENCE_KEYS, ["uri", "digest", "mediaType", "producer", "schema", "state", "disclosure"], path);
    requireUri(item.uri, `${path}.uri`);
    requireString(item.digest, `${path}.digest`, { min: 71, max: 71, pattern: DIGEST });
    if (digests.has(item.digest)) fail("OBSERVATION_DUPLICATE_VALUE", "Evidence digests must be unique.", `${path}.digest`);
    digests.add(item.digest);
    if ("sizeBytes" in item) requireNonNegativeInteger(item.sizeBytes, `${path}.sizeBytes`, 1_000_000_000_000);
    requireString(item.mediaType, `${path}.mediaType`, { max: 128, pattern: MEDIA_TYPE });
    requireString(item.producer, `${path}.producer`, { max: 64, pattern: TOKEN });
    requireString(item.schema, `${path}.schema`, { max: 256 });
    requireEnum(item.state, EVIDENCE_STATES, `${path}.state`);
    requireEnum(item.disclosure, DISCLOSURE_CLASSES, `${path}.disclosure`);
  });
}

function validateCoverage(coverage) {
  exactKeys(coverage, COVERAGE_KEYS, ["state", "redacted", "truncated", "omitted"], "$.data.coverage");
  requireEnum(coverage.state, COVERAGE_STATES, "$.data.coverage.state");
  if (typeof coverage.redacted !== "boolean") fail("OBSERVATION_INVALID_TYPE", "Expected a boolean.", "$.data.coverage.redacted");
  if (typeof coverage.truncated !== "boolean") fail("OBSERVATION_INVALID_TYPE", "Expected a boolean.", "$.data.coverage.truncated");
  if (!Array.isArray(coverage.omitted) || coverage.omitted.length > 16) fail("OBSERVATION_INVALID_VALUE", "Omitted must be an array with at most 16 entries.", "$.data.coverage.omitted");
  const seen = new Set();
  coverage.omitted.forEach((value, index) => {
    requireString(value, `$.data.coverage.omitted[${index}]`, { max: 128, pattern: FACT_NAME });
    if (seen.has(value)) fail("OBSERVATION_DUPLICATE_VALUE", "Omitted field identifiers must be unique.", `$.data.coverage.omitted[${index}]`);
    seen.add(value);
  });
  if (coverage.state === "complete" && coverage.omitted.length > 0) {
    fail("OBSERVATION_COVERAGE_CONFLICT", "Complete coverage cannot declare omitted fields.", "$.data.coverage");
  }
  if (coverage.redacted && !coverage.omitted.some((value) => value.includes("redacted"))) {
    fail("OBSERVATION_COVERAGE_CONFLICT", "Redacted coverage must name a redacted omission.", "$.data.coverage.omitted");
  }
  if (coverage.truncated && !coverage.omitted.some((value) => value.includes("truncated"))) {
    fail("OBSERVATION_COVERAGE_CONFLICT", "Truncated coverage must name a truncated omission.", "$.data.coverage.omitted");
  }
}

function validateSubjectRelationships(subject, relationships) {
  if (subject.kind === "repository-revision") {
    if (!relationships || relationships.repository !== subject.repository || relationships.revision !== subject.revision) {
      fail("OBSERVATION_RELATIONSHIP_CONFLICT", "Repository-revision subjects require matching repository and revision relationships.", "$.data.relationships");
    }
  }
  if (subject.kind === "repository" && relationships?.repository !== subject.repository) {
    fail("OBSERVATION_RELATIONSHIP_CONFLICT", "Repository subjects require a matching repository relationship.", "$.data.relationships.repository");
  }
}

export function validateObservation(observation) {
  exactKeys(observation, TOP_LEVEL_KEYS, ["specversion", "id", "source", "type", "subject", "time", "dataschema", "data"], "$");
  if (observation.specversion !== "1.0") fail("OBSERVATION_INVALID_VALUE", "specversion must be 1.0.", "$.specversion");
  requireString(observation.id, "$.id", { max: 200, pattern: TOKEN });
  requireUri(observation.source, "$.source", 256);
  requireString(observation.type, "$.type", { max: 200, pattern: EVENT_TYPE });
  const subject = parseObservationSubject(observation.subject);
  requireTimestamp(observation.time, "$.time");
  if (observation.dataschema !== OBSERVATION_SCHEMA) fail("OBSERVATION_INVALID_VALUE", `dataschema must be ${OBSERVATION_SCHEMA}.`, "$.dataschema");

  exactKeys(observation.data, DATA_KEYS, [
    "schemaVersion", "adapter", "kind", "status", "timeSource", "observedAt", "ingestedAt",
    "relationships", "facts", "evidence", "coverage",
  ], "$.data");
  if (observation.data.schemaVersion !== 1) fail("OBSERVATION_INVALID_VALUE", "schemaVersion must be 1.", "$.data.schemaVersion");
  validateAdapter(observation.data.adapter);
  requireEnum(observation.data.kind, KINDS, "$.data.kind");
  requireEnum(observation.data.status, STATUSES, "$.data.status");
  requireEnum(observation.data.timeSource, TIME_SOURCES, "$.data.timeSource");
  requireTimestamp(observation.data.observedAt, "$.data.observedAt");
  requireTimestamp(observation.data.ingestedAt, "$.data.ingestedAt");
  if (new Date(observation.data.observedAt) < new Date(observation.time)) {
    fail("OBSERVATION_TIME_CONFLICT", "observedAt cannot precede source time.", "$.data.observedAt");
  }
  if (new Date(observation.data.ingestedAt) < new Date(observation.data.observedAt)) {
    fail("OBSERVATION_TIME_CONFLICT", "ingestedAt cannot precede observedAt.", "$.data.ingestedAt");
  }
  if ("durationMs" in observation.data) requireNonNegativeInteger(observation.data.durationMs, "$.data.durationMs", 31_536_000_000);
  validateRelationships(observation.data.relationships);
  validateFacts(observation.data.facts);
  validateEvidence(observation.data.evidence);
  validateCoverage(observation.data.coverage);
  validateSubjectRelationships(subject, observation.data.relationships);
  return observation;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalizeObservation(observation, { omitIngestedAt = false } = {}) {
  validateObservation(observation);
  const value = omitIngestedAt
    ? { ...observation, data: { ...observation.data, ingestedAt: undefined } }
    : observation;
  if (omitIngestedAt) delete value.data.ingestedAt;
  return canonicalValue(value);
}

export function observationFingerprint(observation) {
  return `sha256:${createHash("sha256").update(canonicalizeObservation(observation, { omitIngestedAt: true }), "utf8").digest("hex")}`;
}
