import { createHash } from "node:crypto";
import { OBSERVATION_SCHEMA, validateObservation } from "./observation.js";

const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class ActivityObservationMappingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ActivityObservationMappingError";
    this.code = code;
  }
}

export function mappingFailure(code, message) {
  throw new ActivityObservationMappingError(code, message);
}

export function canonicalRepository(value, code = "ACTIVITY_OBSERVATION_INVALID_REPOSITORY") {
  if (typeof value !== "string") mappingFailure(code, "Repository identity must be owner/name.");
  const repository = value.toLowerCase();
  if (!REPOSITORY.test(repository) || repository.length > 200) {
    mappingFailure(code, "Repository identity must be owner/name.");
  }
  return repository;
}

export function fullRevision(value, code = "ACTIVITY_OBSERVATION_INVALID_REVISION") {
  if (typeof value !== "string" || !REVISION.test(value)) {
    mappingFailure(code, "Revision must be a full lowercase SHA-1.");
  }
  return value;
}

export function optionalFullRevision(value, code = "ACTIVITY_OBSERVATION_INVALID_REVISION") {
  if (value === undefined || value === null || value === "" || value === "0".repeat(40)) return null;
  if (typeof value === "string" && !/^[a-f0-9]+$/u.test(value)) return null;
  return fullRevision(value, code);
}

export function canonicalTimestamp(value, code = "ACTIVITY_OBSERVATION_INVALID_TIMESTAMP") {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    mappingFailure(code, "Timestamp must be ISO-8601 compatible.");
  }
  return new Date(value).toISOString();
}

export function mappedTimes(sourceTime, observedAt = sourceTime, ingestedAt = observedAt) {
  const time = canonicalTimestamp(sourceTime);
  const observed = canonicalTimestamp(observedAt);
  const ingested = canonicalTimestamp(ingestedAt);
  if (Date.parse(observed) < Date.parse(time) || Date.parse(ingested) < Date.parse(observed)) {
    mappingFailure("ACTIVITY_OBSERVATION_TIME_CONFLICT", "Observation timestamps are out of order.");
  }
  return { time, observedAt: observed, ingestedAt: ingested };
}

export function nonNegativeInteger(value, code, field, { optional = false, minimum = 0 } = {}) {
  if (optional && value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < minimum) {
    mappingFailure(code, `${field} must be a non-negative safe integer.`);
  }
  return value;
}

export function boundedToken(value, code, field) {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    mappingFailure(code, `${field} must be a bounded token.`);
  }
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalValue(value), "utf8").digest("hex")}`;
}

export function partialCoverage(omitted) {
  return {
    state: "partial",
    redacted: true,
    truncated: false,
    omitted,
  };
}

export function githubDeliveryEvidence(eventName, deliveryId, payload) {
  return [{
    uri: `urn:proofwake:github-delivery:${deliveryId}`,
    digest: contentDigest(payload),
    mediaType: "application/json",
    producer: "github",
    schema: `github-webhook-${eventName}`,
    state: "verified",
    disclosure: "content-excluded",
  }];
}

export function createActivityObservation({
  id,
  source,
  type,
  subject,
  time,
  adapter,
  kind,
  status,
  timeSource,
  observedAt,
  ingestedAt,
  durationMs,
  relationships,
  facts,
  evidence,
  coverage,
}) {
  const observation = {
    specversion: "1.0",
    id,
    source,
    type,
    subject,
    time,
    dataschema: OBSERVATION_SCHEMA,
    data: {
      schemaVersion: 1,
      adapter,
      kind,
      status,
      timeSource,
      observedAt,
      ingestedAt,
      ...(durationMs === undefined || durationMs === null ? {} : { durationMs }),
      relationships,
      facts,
      evidence,
      coverage,
    },
  };
  validateObservation(observation);
  return observation;
}
