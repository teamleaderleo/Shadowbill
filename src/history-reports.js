import { createHash } from "node:crypto";
import { repositoryPolicyFingerprint } from "./repository-policy.js";

const TERMINAL_FAILURES = new Set(["failed", "cancelled", "unavailable"]);
const REVISION = /^[a-f0-9]{40}$/u;
const MAX_ENTRIES = 500;

export class HistoryReportError extends Error {
  constructor(code, message, path = "$") {
    super(message);
    this.name = "HistoryReportError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "$") {
  throw new HistoryReportError(code, message, path);
}

function iso(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function adapterName(source, adapter) {
  if (typeof adapter?.name === "string") return adapter.name;
  if (source === "urn:proofwake:adapter:github") return "github";
  return "unknown";
}

function observationRecord(event) {
  const observation = event?.observation;
  const data = observation?.data;
  const observedAt = iso(data?.observedAt);
  const ingestedAt = iso(data?.ingestedAt);
  if (!observation || !data || !observedAt || !ingestedAt) return null;
  return {
    source: observation.source,
    id: observation.id,
    kind: data.kind,
    status: data.status,
    observedAt,
    ingestedAt,
    adapter: {
      name: adapterName(observation.source, data.adapter),
      version: data.adapter?.version ?? null,
      trust: data.adapter?.trust ?? "untrusted-observation",
    },
    relationships: data.relationships ?? {},
    coverage: data.coverage ?? { state: "unavailable", redacted: false, truncated: false, omitted: [] },
    evidence: data.evidence ?? [],
    cursorKey: `${event.id}|${event.requestFingerprint ?? ""}`,
  };
}

function workflowStatus(event) {
  if (event.status !== "completed") return "unknown";
  if (event.conclusion === "success") return "passed";
  if (event.conclusion === "cancelled") return "cancelled";
  if (["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(event.conclusion)) return "failed";
  return "unknown";
}

function legacyRecord(event) {
  const observedAt = iso(event?.timestamp);
  if (!observedAt) return null;
  if (event.type === "github_workflow_run") {
    return {
      source: "urn:proofwake:adapter:github",
      id: event.id,
      kind: "github-ci",
      status: workflowStatus(event),
      observedAt,
      ingestedAt: observedAt,
      adapter: { name: "github", version: null, trust: "signed-provider" },
      relationships: {
        repository: event.repository,
        revision: event.headSha,
        run: `github-workflow-${event.runId}`,
        workflowAttempt: event.runAttempt,
      },
      coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
      evidence: [],
      cursorKey: `${event.id}|${event.runAttempt}|${event.status}|${event.conclusion ?? ""}`,
    };
  }
  if (event.type === "github_deployment") {
    const status = ["success", "active"].includes(event.state)
      ? "passed"
      : ["failure", "error"].includes(event.state)
        ? "failed"
        : event.state === "inactive"
          ? "warning"
          : "unknown";
    return {
      source: "urn:proofwake:adapter:github",
      id: event.id,
      kind: "deployment",
      status,
      observedAt,
      ingestedAt: observedAt,
      adapter: { name: "github", version: null, trust: "signed-provider" },
      relationships: {
        repository: event.repository,
        revision: event.sha,
        deployment: `github-${event.deploymentId}`,
      },
      coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
      evidence: [],
      cursorKey: `${event.id}|${event.state}`,
    };
  }
  return null;
}

function normalizedRecords(events) {
  return events.map((event) => event?.type === "proofwake_observation" ? observationRecord(event) : legacyRecord(event))
    .filter(Boolean)
    .sort(compareRecords);
}

function compareRecords(left, right) {
  return left.observedAt.localeCompare(right.observedAt) ||
    left.ingestedAt.localeCompare(right.ingestedAt) ||
    left.source.localeCompare(right.source) ||
    left.id.localeCompare(right.id);
}

function acceptedSource(record, sources) {
  return sources.some((source) => source.startsWith("adapter:")
    ? record.adapter.name === source.slice("adapter:".length)
    : record.adapter.name === source);
}

function policyMatch(entry, record) {
  const signal = entry.policy.signals.find((candidate) =>
    candidate.kind === record.kind && acceptedSource(record, candidate.acceptedSources));
  if (!signal) return null;
  if (signal.subject === "revision" && !REVISION.test(record.relationships.revision ?? "")) return null;
  return {
    requirement: signal.requirement,
    subject: signal.subject,
    appliesTo: signal.appliesTo,
    freshness: signal.freshness,
    acceptedSources: signal.acceptedSources,
  };
}

function groupKey(item) {
  return [
    item.record.relationships.repository ?? "",
    item.policy.subject === "revision" ? item.record.relationships.revision ?? "" : "",
    item.record.kind,
  ].join("\u0000");
}

function completePass(record) {
  return record.status === "passed" && record.coverage.state === "complete";
}

function recordSummary(record, policy) {
  return {
    repository: record.relationships.repository ?? null,
    revision: policy.subject === "revision" ? record.relationships.revision ?? null : null,
    kind: record.kind,
    status: record.status,
    source: record.source,
    id: record.id,
    observedAt: record.observedAt,
    ingestedAt: record.ingestedAt,
    adapter: record.adapter,
    relationships: record.relationships,
    coverage: record.coverage,
    evidence: record.evidence,
    policy,
  };
}

function elapsed(left, right, field) {
  return Math.max(0, Date.parse(right[field]) - Date.parse(left[field]));
}

function validateDays(days) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    fail("HISTORY_REPORT_INVALID_DAYS", "days must be an integer between 1 and 365.", "$.days");
  }
  return days;
}

function sourceCursor(registry, records) {
  const payload = {
    repositories: registry.entries.map((entry) => [
      entry.repository.identity,
      repositoryPolicyFingerprint(entry.policy),
    ]).sort((left, right) => left[0].localeCompare(right[0])),
    records: records.map((record) => record.cursorKey).sort(),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex")}`;
}

async function snapshot({ registryStore, eventStore }) {
  const [registry, events] = await Promise.all([registryStore.read(), eventStore.readAll()]);
  const entries = new Map(registry.entries.map((entry) => [entry.repository.identity, entry]));
  const matched = [];
  for (const record of normalizedRecords(events)) {
    const entry = entries.get(record.relationships.repository);
    if (!entry) continue;
    const policy = policyMatch(entry, record);
    if (policy) matched.push({ record, policy });
  }
  return { registry, matched };
}

function reportWindow(now, days) {
  const endAt = now.toISOString();
  const startAt = new Date(now.getTime() - days * 86_400_000).toISOString();
  return { days, startAt, endAt, basis: "observedAt", mode: "rolling-duration" };
}

function matchedRecords(state) {
  return state.matched.map((item) => item.record);
}

function availableItems(state, window) {
  return state.matched.filter((item) => item.record.observedAt <= window.endAt);
}

export async function buildFailureReport({ registryStore, eventStore, days = 30, now = new Date() }) {
  validateDays(days);
  const state = await snapshot({ registryStore, eventStore });
  const window = reportWindow(now, days);
  const grouped = new Map();
  for (const item of availableItems(state, window)) {
    const key = groupKey(item);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }

  const failures = [];
  for (const items of grouped.values()) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!TERMINAL_FAILURES.has(item.record.status) || item.record.observedAt < window.startAt) continue;
      const passing = items.slice(index + 1).find((candidate) => completePass(candidate.record)) ?? null;
      failures.push({
        ...recordSummary(item.record, item.policy),
        unresolved: passing === null,
        resolvedBy: passing ? recordSummary(passing.record, passing.policy) : null,
      });
    }
  }
  failures.sort((left, right) => right.observedAt.localeCompare(left.observedAt) || left.repository.localeCompare(right.repository) || left.id.localeCompare(right.id));
  const truncated = failures.length > MAX_ENTRIES;
  const entries = failures.slice(0, MAX_ENTRIES);
  return {
    service: "proofwake",
    command: "failures",
    projectionVersion: 1,
    generatedAt: now.toISOString(),
    sourceCursor: sourceCursor(state.registry, matchedRecords(state)),
    window,
    summary: {
      total: failures.length,
      unresolved: failures.filter((failure) => failure.unresolved).length,
      resolved: failures.filter((failure) => !failure.unresolved).length,
      repositories: new Set(failures.map((failure) => failure.repository)).size,
    },
    truncated,
    failures: entries,
  };
}

export async function buildRecoveryReport({ registryStore, eventStore, days = 30, now = new Date() }) {
  validateDays(days);
  const state = await snapshot({ registryStore, eventStore });
  const window = reportWindow(now, days);
  const grouped = new Map();
  for (const item of availableItems(state, window)) {
    const key = groupKey(item);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }

  const recoveries = [];
  for (const items of grouped.values()) {
    let pendingFailure = null;
    for (const item of items) {
      if (TERMINAL_FAILURES.has(item.record.status)) {
        pendingFailure = item;
        continue;
      }
      if (!pendingFailure || !completePass(item.record)) continue;
      if (item.record.observedAt >= window.startAt) {
        const revisionScoped = item.policy.subject === "revision";
        recoveries.push({
          type: revisionScoped ? "same-revision-rerun" : "same-subject-rerun",
          relation: revisionScoped ? "same-revision" : "same-subject",
          causality: "sequence-only",
          repository: item.record.relationships.repository ?? null,
          revision: revisionScoped ? item.record.relationships.revision ?? null : null,
          kind: item.record.kind,
          policy: item.policy,
          from: recordSummary(pendingFailure.record, pendingFailure.policy),
          to: recordSummary(item.record, item.policy),
          sourceIntervalMs: elapsed(pendingFailure.record, item.record, "observedAt"),
          ingestionIntervalMs: elapsed(pendingFailure.record, item.record, "ingestedAt"),
        });
      }
      pendingFailure = null;
    }
  }
  recoveries.sort((left, right) => right.to.observedAt.localeCompare(left.to.observedAt) || left.repository.localeCompare(right.repository) || left.to.id.localeCompare(right.to.id));
  const truncated = recoveries.length > MAX_ENTRIES;
  const entries = recoveries.slice(0, MAX_ENTRIES);
  return {
    service: "proofwake",
    command: "recoveries",
    projectionVersion: 1,
    generatedAt: now.toISOString(),
    sourceCursor: sourceCursor(state.registry, matchedRecords(state)),
    window,
    summary: {
      total: recoveries.length,
      repositories: new Set(recoveries.map((recovery) => recovery.repository)).size,
      medianSourceIntervalMs: median(recoveries.map((recovery) => recovery.sourceIntervalMs)),
    },
    truncated,
    recoveries: entries,
  };
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : Math.floor((ordered[middle - 1] + ordered[middle]) / 2);
}
