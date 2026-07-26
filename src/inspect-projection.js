import { createHash } from "node:crypto";
import { buildRevisionProjection as buildRawRevisionProjection } from "./revision-projection.js";
import { inspectRepositoryEnrollment } from "./repository-enrollment.js";

const ATTENTION_PRIORITY = [
  "failing",
  "unavailable",
  "partial",
  "stale",
  "missing",
  "warning",
  "selection-unavailable",
];

function compareEvents(left, right) {
  return left.record.observedAt.localeCompare(right.record.observedAt) ||
    left.record.ingestedAt.localeCompare(right.record.ingestedAt) ||
    left.record.source.localeCompare(right.record.source) ||
    left.record.id.localeCompare(right.record.id) ||
    left.signalIndex - right.signalIndex;
}

function passingAt(signal, record, time) {
  if (!record || record.status !== "passed" || record.coverage.state !== "complete") return false;
  if (signal.policy.freshness.mode !== "duration") return true;
  return Date.parse(time) - Date.parse(record.observedAt) <= signal.policy.freshness.hours * 3_600_000;
}

function firstGreenTimeline(report) {
  const required = report.signals.filter((signal) => signal.policy.requirement === "required");
  if (required.length === 0 || required.some((signal) => !signal.selector.available)) {
    return { firstGreenAt: null, timeToGreenMs: null, confidence: "complete" };
  }

  const events = [];
  for (let signalIndex = 0; signalIndex < required.length; signalIndex += 1) {
    for (const record of required[signalIndex].history) events.push({ signalIndex, record });
  }
  events.sort(compareEvents);
  const latest = Array.from({ length: required.length }, () => null);
  let firstGreenAt = null;

  for (let index = 0; index < events.length;) {
    const observedAt = events[index].record.observedAt;
    while (index < events.length && events[index].record.observedAt === observedAt) {
      latest[events[index].signalIndex] = events[index].record;
      index += 1;
    }
    if (required.every((signal, signalIndex) => passingAt(signal, latest[signalIndex], observedAt))) {
      firstGreenAt = observedAt;
      break;
    }
  }

  const confidence = required.some((signal) => signal.historyTruncated) ? "bounded-history" : "complete";
  return {
    firstGreenAt,
    timeToGreenMs: firstGreenAt && report.firstObservationAt
      ? Math.max(0, Date.parse(firstGreenAt) - Date.parse(report.firstObservationAt))
      : null,
    confidence,
  };
}

function unavailableSignal(signal, reason) {
  return {
    ...signal,
    selector: { available: false, reason },
    state: "selection-unavailable",
    reason,
    attempts: 0,
    reruns: 0,
    workflowAttempts: [],
    firstObservationAt: null,
    firstPassingAt: null,
    timeToPassingMs: null,
    latest: null,
    unresolvedFailures: [],
    recovery: null,
    ambiguousRecoveryCandidates: [],
    history: [],
    historyTruncated: false,
  };
}

function markDefaultBranchUnavailable(report, reason) {
  report.signals = report.signals.map((signal) =>
    signal.policy.subject === "revision" && signal.policy.appliesTo === "default-branch"
      ? unavailableSignal(signal, reason)
      : signal);
  report.revision.defaultBranch = null;
  report.revision.defaultBranchSelected = false;
  report.revision.defaultBranchConfidence = "unavailable";
}

async function enforceDefaultBranchAuthority(report, options) {
  const hasDefaultBranchSignal = report.signals.some((signal) =>
    signal.policy.subject === "revision" && signal.policy.appliesTo === "default-branch");
  if (!hasDefaultBranchSignal) return;

  if (report.revision.defaultBranchConfidence === "conventional-current") {
    markDefaultBranchUnavailable(report, "Default-branch selection requires an explicit local remote HEAD.");
    return;
  }
  if (report.revision.defaultBranchConfidence !== "remote-head") return;
  if (report.repository.value.kind !== "remote") {
    markDefaultBranchUnavailable(report, "Default-branch selection requires a verified remote repository identity.");
    return;
  }

  try {
    const registry = await options.registryStore.read();
    const entry = registry.entries.find((candidate) => candidate.repository.identity === report.repository.identity);
    if (!entry) throw new Error("registry entry unavailable");
    const inspection = await inspectRepositoryEnrollment(entry.root, {
      globalPolicy: entry.configuration.source === "global" ? entry.policy : undefined,
      lifecycle: entry.policy.lifecycle.state,
    });
    const origin = inspection.remotes.find((remote) => remote.name === "origin");
    if (origin?.repository !== report.repository.value.id) {
      markDefaultBranchUnavailable(report, "The local origin remote HEAD does not belong to the enrolled repository identity.");
    }
  } catch {
    markDefaultBranchUnavailable(report, "Default-branch remote identity could not be verified.");
  }
}

function projectionStatus(report) {
  if (report.repositoryState === "dormant") return "grey";
  if (report.repositoryState === "unobserved" && report.observationCount === 0) return "grey";
  if (report.repositoryState === "misconfigured" || report.configuration.problems.length > 0) return "yellow";
  const required = report.signals.filter((signal) => signal.policy.requirement === "required");
  if (required.some((signal) => signal.state === "failing")) return "red";
  if (required.length > 0 && required.every((signal) => signal.state === "passed")) return "green";
  return "yellow";
}

function projectionAttention(report) {
  const problem = report.configuration.problems[0];
  if (problem) {
    return { type: "configuration", reason: problem.message, signal: null, observation: null };
  }
  if (report.status === "grey") {
    const reason = report.repositoryState === "dormant"
      ? "Repository policy declares this repository dormant."
      : "No accepted evidence has been observed for this repository.";
    return { type: report.repositoryState, reason, signal: null, observation: null };
  }
  for (const state of ATTENTION_PRIORITY) {
    const signal = report.signals.find((entry) => entry.policy.requirement === "required" && entry.state === state);
    if (signal) return { type: state, reason: signal.reason, signal: signal.policy.kind, observation: signal.latest };
  }
  return null;
}

function contextualCursor(report) {
  const payload = {
    base: report.sourceCursor,
    repositoryState: report.repositoryState,
    revision: report.revision,
    configuration: {
      source: report.configuration.source,
      fingerprint: report.configuration.fingerprint,
      changedSinceEnrolment: report.configuration.changedSinceEnrolment,
      problems: report.configuration.problems.map((problem) => ({ code: problem.code, path: problem.path ?? null })),
    },
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex")}`;
}

export async function buildRevisionProjection(options) {
  const report = await buildRawRevisionProjection(options);
  await enforceDefaultBranchAuthority(report, options);
  report.status = projectionStatus(report);
  report.attention = projectionAttention(report);
  const timeline = firstGreenTimeline(report);
  report.firstGreenAt = timeline.firstGreenAt;
  report.timeToGreenMs = timeline.timeToGreenMs;
  report.timeToGreenConfidence = timeline.confidence;
  report.sourceCursor = contextualCursor(report);
  return report;
}
