import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { buildRepositoryInventory } from "./repository-inventory.js";
import { repositoryPolicyFingerprint } from "./repository-policy.js";

const execFileAsync = promisify(execFile);
const REVISION = /^[a-f0-9]{40}$/u;
const HISTORY_LIMIT = 50;
const RECOVERY_CANDIDATE_LIMIT = 32;
const TERMINAL_FAILURES = new Set(["failed", "cancelled", "unavailable"]);

export class ProjectionError extends Error {
  constructor(code, message, path = "$") {
    super(message);
    this.name = "ProjectionError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "$") {
  throw new ProjectionError(code, message, path);
}

function iso(value) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function elapsed(start, end) {
  if (!start || !end) return null;
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function statusFromWorkflow(event) {
  if (event.status !== "completed") return "unknown";
  if (event.conclusion === "success") return "passed";
  if (event.conclusion === "cancelled") return "cancelled";
  if (["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(event.conclusion)) return "failed";
  return "unknown";
}

function statusFromDeployment(event) {
  if (["success", "active"].includes(event.state)) return "passed";
  if (["failure", "error"].includes(event.state)) return "failed";
  if (event.state === "inactive") return "warning";
  return "unknown";
}

function fromObservation(event) {
  const observation = event.observation;
  if (!observation?.data) return null;
  return {
    source: observation.source,
    id: observation.id,
    kind: observation.data.kind,
    status: observation.data.status,
    time: iso(observation.time) ?? observation.time,
    observedAt: iso(observation.data.observedAt) ?? observation.data.observedAt,
    ingestedAt: iso(observation.data.ingestedAt) ?? observation.data.ingestedAt,
    adapter: {
      name: observation.data.adapter?.name ?? "unknown",
      version: observation.data.adapter?.version ?? null,
      trust: observation.data.adapter?.trust ?? "untrusted-observation",
    },
    relationships: observation.data.relationships ?? {},
    coverage: observation.data.coverage ?? { state: "unavailable", redacted: false, truncated: false, omitted: [] },
    evidence: observation.data.evidence ?? [],
    workflowAttempt: observation.data.relationships?.workflowAttempt ?? null,
    requestFingerprint: event.requestFingerprint ?? null,
    cursorKey: `${event.id}|${event.requestFingerprint ?? ""}`,
    nativeType: event.type,
  };
}

function fromLegacyEvent(event) {
  if (event.type === "github_workflow_run") {
    return {
      source: "urn:proofwake:adapter:github",
      id: event.id,
      kind: "github-ci",
      status: statusFromWorkflow(event),
      time: iso(event.timestamp) ?? event.timestamp,
      observedAt: iso(event.timestamp) ?? event.timestamp,
      ingestedAt: iso(event.timestamp) ?? event.timestamp,
      adapter: { name: "github", version: null, trust: "signed-provider" },
      relationships: {
        repository: event.repository,
        revision: event.headSha,
        run: `github-workflow-${event.runId}`,
        workflowAttempt: event.runAttempt,
      },
      coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
      evidence: [],
      workflowAttempt: event.runAttempt,
      requestFingerprint: null,
      cursorKey: `${event.id}|${event.runAttempt}|${event.status}|${event.conclusion ?? ""}`,
      nativeType: event.type,
    };
  }
  if (event.type === "github_deployment") {
    return {
      source: "urn:proofwake:adapter:github",
      id: event.id,
      kind: "deployment",
      status: statusFromDeployment(event),
      time: iso(event.timestamp) ?? event.timestamp,
      observedAt: iso(event.timestamp) ?? event.timestamp,
      ingestedAt: iso(event.timestamp) ?? event.timestamp,
      adapter: { name: "github", version: null, trust: "signed-provider" },
      relationships: {
        repository: event.repository,
        revision: event.sha,
        deployment: `github-${event.deploymentId}`,
      },
      coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
      evidence: [],
      workflowAttempt: null,
      requestFingerprint: null,
      cursorKey: `${event.id}|${event.state}`,
      nativeType: event.type,
    };
  }
  return null;
}

function repositoryRecords(events, repository) {
  const records = [];
  for (const event of events) {
    let record = null;
    if (event?.type === "proofwake_observation") record = fromObservation(event);
    else record = fromLegacyEvent(event);
    if (record?.relationships?.repository === repository) records.push(record);
  }
  return records.sort(compareRecords);
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

function summarizeRecord(record) {
  return {
    source: record.source,
    id: record.id,
    kind: record.kind,
    status: record.status,
    time: record.time,
    observedAt: record.observedAt,
    ingestedAt: record.ingestedAt,
    adapter: record.adapter,
    relationships: record.relationships,
    coverage: record.coverage,
    evidence: record.evidence,
    workflowAttempt: record.workflowAttempt,
    nativeType: record.nativeType,
  };
}

async function git(root, args) {
  if (!root) return { ok: false, output: "", code: null };
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, output: stdout.trim(), code: 0 };
  } catch (error) {
    return { ok: false, output: "", code: typeof error?.code === "number" ? error.code : null };
  }
}

function ancestryChecker(root) {
  const cache = new Map();
  return async (ancestor, descendant) => {
    const key = `${ancestor}\u0000${descendant}`;
    if (cache.has(key)) return cache.get(key);
    const result = await git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
    const value = result.ok ? true : result.code === 1 ? false : null;
    cache.set(key, value);
    return value;
  };
}

async function inspectRevision(root, selectedRevision, currentRevision, currentBranch, now) {
  if (!root) {
    return {
      confidence: "unavailable",
      relationToCheckout: "unknown",
      timestamp: null,
      ageMs: null,
      defaultBranch: null,
      defaultBranchSelected: false,
      defaultBranchConfidence: "unavailable",
    };
  }

  const exists = await git(root, ["cat-file", "-e", `${selectedRevision}^{commit}`]);
  if (!exists.ok) {
    return {
      confidence: "object-missing",
      relationToCheckout: "unknown",
      timestamp: null,
      ageMs: null,
      defaultBranch: null,
      defaultBranchSelected: false,
      defaultBranchConfidence: "unavailable",
    };
  }

  let relationToCheckout = "unknown";
  let confidence = "verified-object";
  if (currentRevision === selectedRevision) {
    relationToCheckout = "current";
    confidence = "verified-current";
  } else if (currentRevision && REVISION.test(currentRevision)) {
    const check = ancestryChecker(root);
    const selectedAncestor = await check(selectedRevision, currentRevision);
    const currentAncestor = await check(currentRevision, selectedRevision);
    if (selectedAncestor === true) relationToCheckout = "ancestor";
    else if (currentAncestor === true) relationToCheckout = "descendant";
    else if (selectedAncestor === false && currentAncestor === false) relationToCheckout = "diverged";
    confidence = selectedAncestor === null || currentAncestor === null ? "verified-object" : "verified-ancestry";
  }

  const timestampResult = await git(root, ["show", "-s", "--format=%cI", selectedRevision]);
  const revisionTimestamp = timestampResult.ok ? iso(timestampResult.output) : null;
  const remoteHead = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  let defaultBranch = null;
  let defaultBranchConfidence = "unavailable";
  if (remoteHead.ok && remoteHead.output.startsWith("origin/")) {
    defaultBranch = remoteHead.output.slice("origin/".length);
    defaultBranchConfidence = "remote-head";
  } else if (["main", "master"].includes(currentBranch)) {
    defaultBranch = currentBranch;
    defaultBranchConfidence = "conventional-current";
  }

  return {
    confidence,
    relationToCheckout,
    timestamp: revisionTimestamp,
    ageMs: revisionTimestamp ? Math.max(0, now.getTime() - Date.parse(revisionTimestamp)) : null,
    defaultBranch,
    defaultBranchSelected: selectedRevision === currentRevision && currentBranch !== null && currentBranch === defaultBranch,
    defaultBranchConfidence,
  };
}

function signalSelector(signal, selectedRevision, revisionInfo) {
  if (signal.subject === "revision") {
    if (signal.appliesTo === "every-revision") return { available: true, revision: selectedRevision, confidence: "exact" };
    if (signal.appliesTo === "default-branch") {
      if (revisionInfo.defaultBranchSelected) {
        return { available: true, revision: selectedRevision, confidence: revisionInfo.defaultBranchConfidence };
      }
      return { available: false, reason: "Default-branch selection is unavailable for this revision." };
    }
    return { available: false, reason: `${signal.appliesTo} revision selection is unavailable.` };
  }
  if (signal.subject === "repository") return { available: true, confidence: "repository" };
  return { available: false, reason: `${signal.subject} selection is unavailable in revision projection v1.` };
}

function latestState(signal, history, now) {
  const latest = history.at(-1) ?? null;
  if (!latest) return { state: "missing", reason: "No accepted observation matches this policy signal." };
  if (["failed", "cancelled"].includes(latest.status)) return { state: "failing", reason: `Latest accepted observation is ${latest.status}.` };
  if (latest.status === "unavailable") return { state: "unavailable", reason: "Latest accepted observation is unavailable." };
  if (["warning", "unknown"].includes(latest.status)) return { state: "warning", reason: `Latest accepted observation is ${latest.status}.` };
  if (latest.coverage.state !== "complete") {
    return {
      state: latest.coverage.state === "partial" ? "partial" : "unavailable",
      reason: `Latest accepted observation has ${latest.coverage.state} coverage.`,
    };
  }
  if (signal.freshness.mode === "duration" && now.getTime() - Date.parse(latest.observedAt) > signal.freshness.hours * 3_600_000) {
    return { state: "stale", reason: `Latest accepted observation is older than ${signal.freshness.hours} hours.` };
  }
  return { state: "passed", reason: "Passing evidence satisfies the selected policy signal." };
}

function terminalFailuresAfterLastPass(history) {
  let lastPass = -1;
  for (let index = 0; index < history.length; index += 1) if (history[index].status === "passed") lastPass = index;
  return history.slice(lastPass + 1).filter((record) => TERMINAL_FAILURES.has(record.status));
}

function sameRevisionRecovery(history) {
  let passingIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].status === "passed") { passingIndex = index; break; }
  }
  if (passingIndex < 0) return null;
  for (let index = passingIndex - 1; index >= 0; index -= 1) {
    if (!TERMINAL_FAILURES.has(history[index].status)) continue;
    return {
      type: "same-revision-rerun",
      relation: "same-revision",
      causality: "sequence-only",
      from: summarizeRecord(history[index]),
      to: summarizeRecord(history[passingIndex]),
      sourceIntervalMs: elapsed(history[index].observedAt, history[passingIndex].observedAt),
      ingestionIntervalMs: elapsed(history[index].ingestedAt, history[passingIndex].ingestedAt),
    };
  }
  return null;
}

async function descendantRecovery({ signal, selectedHistory, allRecords, selectedRevision, root }) {
  const passing = [...selectedHistory].reverse().find((record) => record.status === "passed");
  if (!passing || !root) return { recovery: null, ambiguous: [] };
  const candidates = allRecords
    .filter((record) => record.kind === signal.kind && acceptedSource(record, signal.acceptedSources))
    .filter((record) => TERMINAL_FAILURES.has(record.status))
    .filter((record) => record.relationships.revision && record.relationships.revision !== selectedRevision)
    .filter((record) => record.observedAt <= passing.observedAt)
    .sort(compareRecords)
    .reverse()
    .slice(0, RECOVERY_CANDIDATE_LIMIT);
  const check = ancestryChecker(root);
  const ambiguous = [];
  for (const failure of candidates) {
    const relation = await check(failure.relationships.revision, selectedRevision);
    if (relation === true) {
      return {
        recovery: {
          type: "descendant-correction",
          relation: "verified-ancestor",
          causality: "unproven",
          from: summarizeRecord(failure),
          to: summarizeRecord(passing),
          sourceIntervalMs: elapsed(failure.observedAt, passing.observedAt),
          ingestionIntervalMs: elapsed(failure.ingestedAt, passing.ingestedAt),
        },
        ambiguous,
      };
    }
    if (relation === null) ambiguous.push({ observation: summarizeRecord(failure), reason: "ancestry-unavailable" });
  }
  return { recovery: null, ambiguous };
}

async function projectSignal({ signal, records, selectedRevision, revisionInfo, root, now }) {
  const selector = signalSelector(signal, selectedRevision, revisionInfo);
  if (!selector.available) {
    return {
      policy: signal,
      selector,
      state: "selection-unavailable",
      reason: selector.reason,
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

  let history = records.filter((record) => record.kind === signal.kind && acceptedSource(record, signal.acceptedSources));
  if (signal.subject === "revision") history = history.filter((record) => record.relationships.revision === selectedRevision);
  history = history.sort(compareRecords);
  const state = latestState(signal, history, now);
  const first = history[0] ?? null;
  const firstPass = history.find((record) => record.status === "passed") ?? null;
  const unresolved = terminalFailuresAfterLastPass(history);
  const sameRevision = sameRevisionRecovery(history);
  const descendant = sameRevision ? { recovery: null, ambiguous: [] } : await descendantRecovery({
    signal,
    selectedHistory: history,
    allRecords: records,
    selectedRevision,
    root,
  });

  return {
    policy: signal,
    selector,
    state: state.state,
    reason: state.reason,
    attempts: history.length,
    reruns: Math.max(0, history.length - 1),
    workflowAttempts: [...new Set(history.map((record) => record.workflowAttempt).filter(Number.isInteger))].sort((a, b) => a - b),
    firstObservationAt: first?.observedAt ?? null,
    firstPassingAt: firstPass?.observedAt ?? null,
    timeToPassingMs: first && firstPass ? elapsed(first.observedAt, firstPass.observedAt) : null,
    latest: history.length > 0 ? summarizeRecord(history.at(-1)) : null,
    unresolvedFailures: unresolved.slice(-20).map(summarizeRecord),
    recovery: sameRevision ?? descendant.recovery,
    ambiguousRecoveryCandidates: descendant.ambiguous,
    history: history.slice(-HISTORY_LIMIT).map(summarizeRecord),
    historyTruncated: history.length > HISTORY_LIMIT,
  };
}

function projectionStatus(signals) {
  const required = signals.filter((signal) => signal.policy.requirement === "required");
  if (required.some((signal) => signal.state === "failing")) return "red";
  if (required.length > 0 && required.every((signal) => signal.state === "passed")) return "green";
  return "yellow";
}

function attention(signals, problems) {
  if (problems.length > 0) return { type: "configuration", reason: problems[0].message, signal: null, observation: null };
  const priority = ["failing", "unavailable", "partial", "stale", "missing", "warning", "selection-unavailable"];
  for (const state of priority) {
    const signal = signals.find((entry) => entry.policy.requirement === "required" && entry.state === state);
    if (signal) return { type: state, reason: signal.reason, signal: signal.policy.kind, observation: signal.latest };
  }
  return null;
}

function cursor(policy, records, selectedRevision) {
  const payload = {
    policy: repositoryPolicyFingerprint(policy),
    revision: selectedRevision,
    records: records.map((record) => record.cursorKey).sort(),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex")}`;
}

function selectLatestRevision(records) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const revision = records[index].relationships.revision;
    if (REVISION.test(revision ?? "")) return revision;
  }
  return null;
}

async function projectInventoryItem({ item, events, requestedRevision, now }) {
  if (!item.policy) fail("PROJECTION_POLICY_UNAVAILABLE", "Repository has no readable policy.");
  const repository = item.repository.value.kind === "remote" ? item.repository.value.id : item.repository.identity;
  const records = item.repository.value.kind === "remote" ? repositoryRecords(events, repository) : [];
  const selectedRevision = requestedRevision ?? item.revision ?? selectLatestRevision(records);
  if (!selectedRevision || !REVISION.test(selectedRevision)) fail("PROJECTION_REVISION_UNAVAILABLE", "A full selected revision is required.", "$.revision");

  const revisionSource = requestedRevision ? "explicit" : item.revision ? "checkout" : "observation";
  const revisionInfo = await inspectRevision(item.root, selectedRevision, item.revision, item.branch, now);
  const signals = [];
  for (const signal of item.policy.signals) {
    signals.push(await projectSignal({ signal, records, selectedRevision, revisionInfo, root: item.root, now }));
  }
  const required = signals.filter((signal) => signal.policy.requirement === "required");
  const firstTimes = required.map((signal) => signal.firstObservationAt).filter(Boolean).sort();
  const passingTimes = required.map((signal) => signal.firstPassingAt).filter(Boolean).sort();
  const firstObservationAt = firstTimes[0] ?? null;
  const firstGreenAt = passingTimes.length === required.length && passingTimes.length > 0 ? passingTimes.at(-1) : null;

  return {
    projectionVersion: 1,
    sourceCursor: cursor(item.policy, records, selectedRevision),
    repository: item.repository,
    repositoryState: item.classification,
    selectedRevision,
    selectedRevisionSource: revisionSource,
    revision: revisionInfo,
    configuration: {
      source: item.policySource,
      fingerprint: repositoryPolicyFingerprint(item.policy),
      changedSinceEnrolment: item.policyChanged,
      problems: item.problems,
    },
    policy: item.policy,
    status: projectionStatus(signals),
    attention: attention(signals, item.problems),
    firstObservationAt,
    firstGreenAt,
    timeToGreenMs: firstObservationAt && firstGreenAt ? elapsed(firstObservationAt, firstGreenAt) : null,
    signalCount: signals.length,
    observationCount: records.length,
    signals,
  };
}

export async function buildRevisionProjection({ repository, revision, registryStore, eventStore, now = new Date() }) {
  if (typeof repository !== "string" || repository.length === 0) fail("PROJECTION_REPOSITORY_REQUIRED", "Repository identity is required.", "$.repository");
  if (revision !== undefined && !REVISION.test(revision)) fail("PROJECTION_INVALID_REVISION", "Revision must be a full lowercase SHA-1.", "$.revision");
  const inventory = await buildRepositoryInventory({ registryStore, eventStore, now });
  const item = inventory.repositories.find((entry) =>
    entry.repository.identity === repository.toLowerCase() || entry.repository.label === repository.toLowerCase());
  if (!item) fail("PROJECTION_REPOSITORY_UNKNOWN", "Repository is not enrolled.", "$.repository");
  const events = await eventStore.readAll();
  const projection = await projectInventoryItem({ item, events, requestedRevision: revision, now });
  return {
    service: "proofwake",
    command: "inspect",
    generatedAt: now.toISOString(),
    ...projection,
  };
}

function fleetStatus(item, projection) {
  if (item.classification === "dormant") return "grey";
  if (item.classification === "unobserved" && (!projection || projection.observationCount === 0)) return "grey";
  if (item.classification === "misconfigured") return "yellow";
  return projection?.status ?? "grey";
}

function fleetAttention(item, projection, status) {
  if (status === "grey") {
    return { type: item.classification, reason: item.attentionReason ?? `Repository is ${item.classification}.`, signal: null, observation: null };
  }
  return projection?.attention ?? null;
}

function rank(status) {
  return { red: 0, yellow: 1, grey: 2, green: 3 }[status] ?? 4;
}

export async function buildFleetProjection({ registryStore, eventStore, now = new Date() }) {
  const inventory = await buildRepositoryInventory({ registryStore, eventStore, now });
  const events = await eventStore.readAll();
  const repositories = [];

  for (const item of inventory.repositories) {
    let projection = null;
    let panelError = null;
    try {
      if (item.policy) projection = await projectInventoryItem({ item, events, requestedRevision: undefined, now });
    } catch (error) {
      panelError = {
        code: typeof error?.code === "string" ? error.code : "PROJECTION_PANEL_FAILED",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const status = fleetStatus(item, projection);
    const currentFailure = projection?.signals.find((signal) => signal.policy.requirement === "required" && signal.state === "failing") ?? null;
    const missingOrStale = projection?.signals.find((signal) => signal.policy.requirement === "required" && ["missing", "stale", "partial", "unavailable", "selection-unavailable", "warning"].includes(signal.state)) ?? null;
    const recoveries = (projection?.signals ?? []).map((signal) => signal.recovery).filter(Boolean).sort((left, right) => right.to.observedAt.localeCompare(left.to.observedAt));
    repositories.push({
      repository: item.repository,
      classification: item.classification,
      status,
      selectedRevision: projection?.selectedRevision ?? item.revision ?? null,
      revision: projection?.revision ?? null,
      policySource: item.policySource ?? null,
      sourceCursor: projection?.sourceCursor ?? null,
      currentFailure: currentFailure ? { signal: currentFailure.policy.kind, reason: currentFailure.reason, observation: currentFailure.latest } : null,
      missingOrStale: missingOrStale ? { signal: missingOrStale.policy.kind, state: missingOrStale.state, reason: missingOrStale.reason } : null,
      recentRecovery: recoveries[0] ?? null,
      attention: panelError ? { type: "projection-error", reason: panelError.message, signal: null, observation: null } : fleetAttention(item, projection, status),
      panelError,
      requiredSignals: (projection?.signals ?? []).filter((signal) => signal.policy.requirement === "required").map((signal) => ({
        kind: signal.policy.kind,
        state: signal.state,
        latest: signal.latest,
      })),
    });
  }

  repositories.sort((left, right) => left.repository.identity.localeCompare(right.repository.identity));
  const attentionOrder = repositories
    .filter((repository) => repository.status !== "green")
    .sort((left, right) => rank(left.status) - rank(right.status) || left.repository.identity.localeCompare(right.repository.identity))
    .map((repository) => repository.repository.identity);
  const sourceCursor = `sha256:${createHash("sha256").update(JSON.stringify({
    repositories: repositories.map((repository) => [repository.repository.identity, repository.sourceCursor]).sort(),
  }), "utf8").digest("hex")}`;

  return {
    service: "proofwake",
    command: "fleet",
    projectionVersion: 1,
    sourceCursor,
    generatedAt: now.toISOString(),
    summary: {
      total: repositories.length,
      green: repositories.filter((repository) => repository.status === "green").length,
      red: repositories.filter((repository) => repository.status === "red").length,
      yellow: repositories.filter((repository) => repository.status === "yellow").length,
      grey: repositories.filter((repository) => repository.status === "grey").length,
    },
    attentionOrder,
    repositories,
  };
}
