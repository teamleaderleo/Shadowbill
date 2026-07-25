import { createHash } from "node:crypto";

export const MAX_OBSERVATION_BYTES = 65_536;
const MAX_DEPTH = 12;
const MAX_STRING_LENGTH = 4_096;
const MAX_OBJECT_KEYS = 64;
const MAX_ARRAY_LENGTH = 32;
const MAX_EVIDENCE_REFERENCES = 16;
const MAX_RELATIONSHIPS = 16;
const MAX_DURATION_MS = 31 * 24 * 60 * 60 * 1000;
const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const TOP_LEVEL_FIELDS = new Set(["specversion", "id", "source", "type", "time", "subject", "datacontenttype", "dataschema", "data"]);
const DATA_FIELDS = new Set(["schemaVersion", "adapter", "repository", "revision", "kind", "status", "observedAt", "durationMs", "attempt", "sequence", "relationships", "evidence", "attributes", "redacted", "truncated"]);
const TRUST_CLASSES = new Set(["local-operator", "signed-provider", "verified-receipt", "authenticated-client", "untrusted-observation"]);
const STATUSES = new Set(["started", "passed", "failed", "cancelled", "timed_out", "skipped", "unknown"]);
const DISCLOSURE_CLASSES = new Set(["public-metadata", "private-metadata", "restricted-reference", "content-excluded"]);
const EVIDENCE_STATES = new Set(["available", "verified", "unavailable", "redacted", "truncated"]);
const ALLOWED_ATTRIBUTES = Object.freeze({
  "vcs.repository.url.full": "url",
  "vcs.repository.name": "string",
  "vcs.owner.name": "string",
  "vcs.provider.name": "slug",
  "vcs.ref.head.revision": "revision",
  "vcs.ref.head.name": "string",
  "vcs.ref.head.type": new Set(["branch", "tag"]),
  "vcs.change.id": "string",
  "vcs.change.state": new Set(["open", "closed", "merged"]),
  "cicd.pipeline.name": "string",
  "cicd.pipeline.action.name": new Set(["BUILD", "RUN", "SYNC"]),
});

export class ProofwakeObservationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProofwakeObservationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProofwakeObservationError(code, message);
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("PW_SCHEMA_UNKNOWN_FIELD", `${label} contains unsupported field: ${key}`);
  }
}

function requiredString(value, label, maximum = MAX_STRING_LENGTH) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("PW_SCHEMA_INVALID", `${label} must be a non-empty bounded string without control characters`);
  }
  return value;
}

function optionalBoolean(value, label) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") fail("PW_SCHEMA_INVALID", `${label} must be boolean`);
  return value;
}

function isoTime(value, label) {
  requiredString(value, label, 100);
  if (!RFC3339_DATE_TIME.test(value)) fail("PW_SCHEMA_INVALID", `${label} must be an RFC 3339 date-time with a timezone`);
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) fail("PW_SCHEMA_INVALID", `${label} must be a real RFC 3339 date-time`);
  return new Date(milliseconds).toISOString();
}

function absoluteUri(value, label, protocols = null, normalize = true) {
  requiredString(value, label, 2_048);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("PW_SCHEMA_INVALID", `${label} must be an absolute URI`);
  }
  if (protocols && !protocols.has(parsed.protocol)) fail("PW_SCHEMA_INVALID", `${label} uses an unsupported URI scheme`);
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && (parsed.username || parsed.password)) {
    fail("PW_SCHEMA_INVALID", `${label} must not contain credentials`);
  }
  return normalize ? parsed.href : value;
}

function slug(value, label, maximum = 100) {
  requiredString(value, label, maximum);
  if (!/^[a-z0-9][a-z0-9._:-]*$/iu.test(value)) fail("PW_SCHEMA_INVALID", `${label} must be a stable slug`);
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("PW_SCHEMA_INVALID", `${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function parseStrictJson(text, options = {}) {
  if (typeof text !== "string") fail("PW_JSON_SYNTAX", "JSON input must be UTF-8 text");
  const bytes = Buffer.byteLength(text, "utf8");
  const maximumBytes = options.maximumBytes ?? MAX_OBSERVATION_BYTES;
  if (bytes > maximumBytes) fail("PW_OBSERVATION_TOO_LARGE", `Observation exceeds ${maximumBytes} bytes`);

  let index = 0;
  const length = text.length;

  function skipWhitespace() {
    while (index < length && (text[index] === " " || text[index] === "\t" || text[index] === "\n" || text[index] === "\r")) index += 1;
  }

  function parseString() {
    const start = index;
    index += 1;
    while (index < length) {
      const code = text.charCodeAt(index);
      if (text[index] === "\"") {
        index += 1;
        let value;
        try {
          value = JSON.parse(text.slice(start, index));
        } catch {
          fail("PW_JSON_SYNTAX", `Invalid JSON string at character ${start}`);
        }
        if (value.length > MAX_STRING_LENGTH) fail("PW_JSON_STRING_TOO_LONG", `JSON string exceeds ${MAX_STRING_LENGTH} characters`);
        return value;
      }
      if (code < 0x20) fail("PW_JSON_SYNTAX", `Unescaped control character at character ${index}`);
      if (text[index] === "\\") {
        index += 1;
        if (index >= length) fail("PW_JSON_SYNTAX", "Unterminated JSON escape");
        const escape = text[index];
        if ('"\\/bfnrt'.includes(escape)) {
          index += 1;
          continue;
        }
        if (escape === "u") {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("PW_JSON_SYNTAX", `Invalid Unicode escape at character ${index}`);
          index += 5;
          continue;
        }
        fail("PW_JSON_SYNTAX", `Invalid JSON escape at character ${index}`);
      }
      index += 1;
    }
    fail("PW_JSON_SYNTAX", "Unterminated JSON string");
  }

  function parseNumber() {
    const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) fail("PW_JSON_SYNTAX", `Invalid JSON number at character ${index}`);
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail("PW_JSON_NON_FINITE", "JSON numbers must be finite");
    return value;
  }

  function parseValue(depth) {
    if (depth > MAX_DEPTH) fail("PW_JSON_DEPTH", `JSON nesting exceeds ${MAX_DEPTH}`);
    skipWhitespace();
    if (index >= length) fail("PW_JSON_SYNTAX", "Unexpected end of JSON input");
    const character = text[index];
    if (character === "\"") return parseString();
    if (character === "{") return parseObject(depth + 1);
    if (character === "[") return parseArray(depth + 1);
    if (text.startsWith("true", index)) { index += 4; return true; }
    if (text.startsWith("false", index)) { index += 5; return false; }
    if (text.startsWith("null", index)) { index += 4; return null; }
    if (character === "-" || /[0-9]/.test(character)) return parseNumber();
    fail("PW_JSON_SYNTAX", `Unexpected token at character ${index}`);
  }

  function parseObject(depth) {
    index += 1;
    const result = {};
    const keys = new Set();
    skipWhitespace();
    if (text[index] === "}") { index += 1; return result; }
    while (index < length) {
      skipWhitespace();
      if (text[index] !== "\"") fail("PW_JSON_SYNTAX", `Object key expected at character ${index}`);
      const key = parseString();
      if (keys.has(key)) fail("PW_JSON_DUPLICATE_KEY", `Duplicate JSON key: ${key}`);
      keys.add(key);
      if (keys.size > MAX_OBJECT_KEYS) fail("PW_JSON_OBJECT_TOO_LARGE", `JSON object exceeds ${MAX_OBJECT_KEYS} keys`);
      skipWhitespace();
      if (text[index] !== ":") fail("PW_JSON_SYNTAX", `Colon expected at character ${index}`);
      index += 1;
      result[key] = parseValue(depth);
      skipWhitespace();
      if (text[index] === "}") { index += 1; return result; }
      if (text[index] !== ",") fail("PW_JSON_SYNTAX", `Comma expected at character ${index}`);
      index += 1;
    }
    fail("PW_JSON_SYNTAX", "Unterminated JSON object");
  }

  function parseArray(depth) {
    index += 1;
    const result = [];
    skipWhitespace();
    if (text[index] === "]") { index += 1; return result; }
    while (index < length) {
      if (result.length >= MAX_ARRAY_LENGTH) fail("PW_JSON_ARRAY_TOO_LARGE", `JSON array exceeds ${MAX_ARRAY_LENGTH} items`);
      result.push(parseValue(depth));
      skipWhitespace();
      if (text[index] === "]") { index += 1; return result; }
      if (text[index] !== ",") fail("PW_JSON_SYNTAX", `Comma expected at character ${index}`);
      index += 1;
    }
    fail("PW_JSON_SYNTAX", "Unterminated JSON array");
  }

  const value = parseValue(0);
  skipWhitespace();
  if (index !== length) fail("PW_JSON_SYNTAX", `Trailing JSON content at character ${index}`);
  return value;
}

function normalizeAdapter(value) {
  if (!isPlainObject(value)) fail("PW_SCHEMA_INVALID", "data.adapter must be an object");
  exactFields(value, new Set(["name", "version", "trust"]), "data.adapter");
  const trust = requiredString(value.trust, "data.adapter.trust", 64);
  if (!TRUST_CLASSES.has(trust)) fail("PW_SCHEMA_INVALID", "data.adapter.trust is unsupported");
  return {
    name: slug(value.name, "data.adapter.name"),
    version: requiredString(value.version, "data.adapter.version", 100),
    trust,
  };
}

function normalizeRepository(value) {
  if (!isPlainObject(value)) fail("PW_SCHEMA_INVALID", "data.repository must be an object");
  exactFields(value, new Set(["kind", "id", "url", "provider", "localId"]), "data.repository");
  const kind = requiredString(value.kind, "data.repository.kind", 16);
  if (kind === "remote") {
    if (value.localId !== undefined) fail("PW_SCHEMA_INVALID", "remote repositories must not include localId");
    const id = requiredString(value.id, "data.repository.id", 255).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,99})\/[a-z0-9](?:[a-z0-9._-]{0,99})$/u.test(id)) {
      fail("PW_SCHEMA_INVALID", "data.repository.id must use canonical owner/name form");
    }
    return {
      kind,
      id,
      ...(value.url === undefined ? {} : { url: absoluteUri(value.url, "data.repository.url", new Set(["http:", "https:"])).replace(/\.git$/u, "") }),
      ...(value.provider === undefined ? {} : { provider: slug(value.provider, "data.repository.provider", 50) }),
    };
  }
  if (kind === "local") {
    if (value.id !== undefined || value.url !== undefined || value.provider !== undefined) {
      fail("PW_SCHEMA_INVALID", "local repositories must not include remote repository fields");
    }
    requiredString(value.localId, "data.repository.localId", 71);
    if (!/^sha256:[0-9a-f]{64}$/u.test(value.localId)) fail("PW_SCHEMA_INVALID", "data.repository.localId must be a sha256 digest");
    return { kind, localId: value.localId };
  }
  fail("PW_SCHEMA_INVALID", "data.repository.kind must be remote or local");
}

function normalizeRevision(value) {
  if (!isPlainObject(value)) fail("PW_SCHEMA_INVALID", "data.revision must be an object");
  exactFields(value, new Set(["algorithm", "id"]), "data.revision");
  const algorithm = requiredString(value.algorithm, "data.revision.algorithm", 32);
  const id = requiredString(value.id, "data.revision.id", 128);
  if (algorithm === "git-sha1" && !/^[0-9a-f]{40}$/iu.test(id)) fail("PW_SCHEMA_INVALID", "git-sha1 revisions require 40 hexadecimal characters");
  if (algorithm === "git-sha256" && !/^[0-9a-f]{64}$/iu.test(id)) fail("PW_SCHEMA_INVALID", "git-sha256 revisions require 64 hexadecimal characters");
  if (!new Set(["git-sha1", "git-sha256", "opaque"]).has(algorithm)) fail("PW_SCHEMA_INVALID", "data.revision.algorithm is unsupported");
  return { algorithm, id: algorithm === "opaque" ? id : id.toLowerCase() };
}

function normalizeRelationships(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail("PW_SCHEMA_INVALID", "data.relationships must be an object");
  exactFields(value, new Set(["causedBy", "correlatedWith"]), "data.relationships");
  const normalizeList = (list, label) => {
    if (list === undefined) return undefined;
    if (!Array.isArray(list) || list.length > MAX_RELATIONSHIPS) fail("PW_SCHEMA_INVALID", `${label} must be a bounded array`);
    const seen = new Set();
    return list.map((reference, index_) => {
      if (!isPlainObject(reference)) fail("PW_SCHEMA_INVALID", `${label}[${index_}] must be an object`);
      exactFields(reference, new Set(["source", "id"]), `${label}[${index_}]`);
      const normalized = {
        source: absoluteUri(reference.source, `${label}[${index_}].source`, null, false),
        id: requiredString(reference.id, `${label}[${index_}].id`, 128),
      };
      const key = `${normalized.source}\0${normalized.id}`;
      if (seen.has(key)) fail("PW_SCHEMA_INVALID", `${label} contains a duplicate reference`);
      seen.add(key);
      return normalized;
    });
  };
  return {
    ...(value.causedBy === undefined ? {} : { causedBy: normalizeList(value.causedBy, "data.relationships.causedBy") }),
    ...(value.correlatedWith === undefined ? {} : { correlatedWith: normalizeList(value.correlatedWith, "data.relationships.correlatedWith") }),
  };
}

function normalizeEvidence(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_REFERENCES) fail("PW_SCHEMA_INVALID", "data.evidence must be a bounded array");
  return value.map((reference, index) => {
    const label = `data.evidence[${index}]`;
    if (!isPlainObject(reference)) fail("PW_SCHEMA_INVALID", `${label} must be an object`);
    exactFields(reference, new Set(["uri", "digest", "sizeBytes", "mediaType", "producer", "schema", "state", "disclosure"]), label);
    if (!isPlainObject(reference.producer)) fail("PW_SCHEMA_INVALID", `${label}.producer must be an object`);
    exactFields(reference.producer, new Set(["name", "version"]), `${label}.producer`);
    const state = requiredString(reference.state, `${label}.state`, 32);
    const disclosure = requiredString(reference.disclosure, `${label}.disclosure`, 32);
    if (!EVIDENCE_STATES.has(state)) fail("PW_SCHEMA_INVALID", `${label}.state is unsupported`);
    if (!DISCLOSURE_CLASSES.has(disclosure)) fail("PW_SCHEMA_INVALID", `${label}.disclosure is unsupported`);
    const digest = requiredString(reference.digest, `${label}.digest`, 71).toLowerCase();
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) fail("PW_SCHEMA_INVALID", `${label}.digest must be sha256:<64 lowercase hex>`);
    return {
      uri: absoluteUri(reference.uri, `${label}.uri`),
      digest,
      ...(reference.sizeBytes === undefined ? {} : { sizeBytes: boundedInteger(reference.sizeBytes, `${label}.sizeBytes`, 0, Number.MAX_SAFE_INTEGER) }),
      mediaType: requiredString(reference.mediaType, `${label}.mediaType`, 255),
      producer: {
        name: slug(reference.producer.name, `${label}.producer.name`),
        version: requiredString(reference.producer.version, `${label}.producer.version`, 100),
      },
      ...(reference.schema === undefined ? {} : { schema: absoluteUri(reference.schema, `${label}.schema`) }),
      state,
      disclosure,
    };
  });
}

function normalizeAttributes(value) {
  if (value === undefined) return {};
  if (!isPlainObject(value) || Object.keys(value).length > 24) fail("PW_SCHEMA_INVALID", "data.attributes must be a bounded object");
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    const rule = ALLOWED_ATTRIBUTES[key];
    if (rule === undefined) fail("PW_SCHEMA_UNKNOWN_FIELD", `data.attributes contains unsupported attribute: ${key}`);
    if (rule instanceof Set) {
      if (typeof raw !== "string" || !rule.has(raw)) fail("PW_SCHEMA_INVALID", `data.attributes.${key} has an unsupported value`);
      result[key] = raw;
    } else if (rule === "url") {
      result[key] = absoluteUri(raw, `data.attributes.${key}`, new Set(["http:", "https:"])).replace(/\.git$/u, "");
    } else if (rule === "slug") {
      result[key] = slug(raw, `data.attributes.${key}`, 100);
    } else if (rule === "revision") {
      result[key] = requiredString(raw, `data.attributes.${key}`, 128);
    } else {
      result[key] = requiredString(raw, `data.attributes.${key}`, 255);
    }
  }
  return result;
}

export function normalizeObservation(value) {
  if (!isPlainObject(value)) fail("PW_SCHEMA_INVALID", "Observation must be a JSON object");
  exactFields(value, TOP_LEVEL_FIELDS, "observation");
  for (const field of ["specversion", "id", "source", "type", "time", "subject", "datacontenttype", "dataschema", "data"]) {
    if (!(field in value)) fail("PW_SCHEMA_REQUIRED", `Observation is missing required field: ${field}`);
  }
  if (value.specversion !== "1.0") fail("PW_SCHEMA_INVALID", "specversion must be 1.0");
  const id = requiredString(value.id, "id", 128);
  const source = absoluteUri(value.source, "source", null, false);
  const type = slug(value.type, "type", 255);
  const time = isoTime(value.time, "time");
  const subject = requiredString(value.subject, "subject", 512);
  if (value.datacontenttype !== "application/json") fail("PW_SCHEMA_INVALID", "datacontenttype must be application/json");
  if (value.dataschema !== "urn:proofwake:schema:observation:1") fail("PW_SCHEMA_INVALID", "dataschema must identify Proofwake observation schema v1");
  if (!isPlainObject(value.data)) fail("PW_SCHEMA_INVALID", "data must be an object");
  exactFields(value.data, DATA_FIELDS, "data");
  for (const field of ["schemaVersion", "adapter", "repository", "revision", "kind", "status", "observedAt"]) {
    if (!(field in value.data)) fail("PW_SCHEMA_REQUIRED", `data is missing required field: ${field}`);
  }
  if (value.data.schemaVersion !== 1) fail("PW_SCHEMA_INVALID", "data.schemaVersion must be 1");
  const status = requiredString(value.data.status, "data.status", 32);
  if (!STATUSES.has(status)) fail("PW_SCHEMA_INVALID", "data.status is unsupported");
  const kind = slug(value.data.kind, "data.kind", 64).toLowerCase();

  return {
    specversion: "1.0",
    id,
    source,
    type,
    time,
    subject,
    datacontenttype: "application/json",
    dataschema: "urn:proofwake:schema:observation:1",
    data: {
      schemaVersion: 1,
      adapter: normalizeAdapter(value.data.adapter),
      repository: normalizeRepository(value.data.repository),
      revision: normalizeRevision(value.data.revision),
      kind,
      status,
      observedAt: isoTime(value.data.observedAt, "data.observedAt"),
      ...(value.data.durationMs === undefined ? {} : { durationMs: boundedInteger(value.data.durationMs, "data.durationMs", 0, MAX_DURATION_MS) }),
      ...(value.data.attempt === undefined ? {} : { attempt: boundedInteger(value.data.attempt, "data.attempt", 1, 100_000) }),
      ...(value.data.sequence === undefined ? {} : { sequence: boundedInteger(value.data.sequence, "data.sequence", 0, Number.MAX_SAFE_INTEGER) }),
      ...(value.data.relationships === undefined ? {} : { relationships: normalizeRelationships(value.data.relationships) }),
      evidence: normalizeEvidence(value.data.evidence),
      attributes: normalizeAttributes(value.data.attributes),
      redacted: optionalBoolean(value.data.redacted, "data.redacted"),
      truncated: optionalBoolean(value.data.truncated, "data.truncated"),
    },
  };
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("PW_JSON_NON_FINITE", "Canonical JSON cannot encode non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("PW_SCHEMA_INVALID", "Canonical JSON supports only JSON values");
}

export function observationFingerprint(observation) {
  return createHash("sha256").update(canonicalJson(observation), "utf8").digest("hex");
}

export function prepareObservation(text, options = {}) {
  const parsed = parseStrictJson(text, options);
  const normalized = normalizeObservation(parsed);
  const fingerprint = observationFingerprint(normalized);
  const ingestedAt = (options.now ?? new Date()).toISOString();
  return {
    identity: { source: normalized.source, id: normalized.id },
    fingerprint,
    event: {
      ...normalized,
      proofwakeschema: "1",
      proofwakefingerprint: fingerprint,
      proofwakeingestedat: ingestedAt,
    },
  };
}
