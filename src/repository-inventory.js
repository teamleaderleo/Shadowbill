import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { inspectRepositoryEnrollment } from "./repository-enrollment.js";
import { repositoryPolicyFingerprint } from "./repository-policy.js";
import { readRepositoryPolicyFile } from "./repository-policy-file.js";

function isCode(error, code) {
  return error && typeof error === "object" && "code" in error && error.code === code;
}

function newest(observations) {
  return [...observations].sort((left, right) => {
    const leftTime = left.data?.observedAt ?? left.time ?? "";
    const rightTime = right.data?.observedAt ?? right.time ?? "";
    return rightTime.localeCompare(leftTime);
  })[0] ?? null;
}

function acceptedSource(observation, sources) {
  const adapter = observation.data?.adapter?.name;
  return sources.some((source) => source.startsWith("adapter:")
    ? adapter === source.slice("adapter:".length)
    : adapter === source);
}

function signalState(signal, observations, context, now) {
  let candidates = observations.filter((observation) =>
    observation.data?.kind === signal.kind && acceptedSource(observation, signal.acceptedSources));
  if (signal.subject === "revision") {
    if (!["every-revision", "default-branch"].includes(signal.appliesTo)) {
      return {
        kind: signal.kind,
        requirement: signal.requirement,
        subject: signal.subject,
        appliesTo: signal.appliesTo,
        state: "selection-unavailable",
        observation: null,
        reason: `${signal.appliesTo} selection is not implemented yet.`,
      };
    }
    if (!context.revision) {
      return {
        kind: signal.kind,
        requirement: signal.requirement,
        subject: signal.subject,
        appliesTo: signal.appliesTo,
        state: "selection-unavailable",
        observation: null,
        reason: "No current revision is available.",
      };
    }
    candidates = candidates.filter((observation) => observation.data?.relationships?.revision === context.revision);
  }
  const latest = newest(candidates);
  if (!latest) {
    return {
      kind: signal.kind,
      requirement: signal.requirement,
      subject: signal.subject,
      appliesTo: signal.appliesTo,
      state: "missing",
      observation: null,
      reason: "No accepted observation matches this policy signal.",
    };
  }
  const status = latest.data.status;
  const coverage = latest.data.coverage?.state ?? "unavailable";
  let state;
  let reason;
  if (["failed", "cancelled"].includes(status)) {
    state = "failing";
    reason = `Latest accepted observation is ${status}.`;
  } else if (status === "unavailable") {
    state = "unavailable";
    reason = "Latest accepted observation is unavailable.";
  } else if (["warning", "unknown"].includes(status)) {
    state = "warning";
    reason = `Latest accepted observation is ${status}.`;
  } else if (coverage !== "complete") {
    state = coverage === "partial" ? "partial" : "unavailable";
    reason = `Latest accepted observation has ${coverage} coverage.`;
  } else if (signal.freshness.mode === "duration") {
    const observedAt = Date.parse(latest.data.observedAt);
    const maximumAge = signal.freshness.hours * 60 * 60 * 1000;
    if (now.getTime() - observedAt > maximumAge) {
      state = "stale";
      reason = `Latest accepted observation is older than ${signal.freshness.hours} hours.`;
    } else {
      state = "passed";
      reason = "Fresh passing observation is present.";
    }
  } else {
    state = "passed";
    reason = "Passing observation is present.";
  }
  return {
    kind: signal.kind,
    requirement: signal.requirement,
    subject: signal.subject,
    appliesTo: signal.appliesTo,
    state,
    observation: {
      source: latest.source,
      id: latest.id,
      status,
      observedAt: latest.data.observedAt,
      coverage,
      revision: latest.data.relationships?.revision ?? null,
    },
    reason,
  };
}

function repositoryObservations(events, repository) {
  if (repository.kind !== "remote") return [];
  return events
    .filter((event) => event?.type === "proofwake_observation" && event.observation?.data?.relationships?.repository === repository.id)
    .map((event) => event.observation);
}

function healthFromSignals(lifecycle, signals, problems) {
  if (problems.length > 0) return "yellow";
  if (lifecycle === "dormant") return "grey";
  const required = signals.filter((signal) => signal.requirement === "required");
  if (required.some((signal) => signal.state === "failing")) return "red";
  if (required.some((signal) => signal.state !== "passed")) return "yellow";
  return "green";
}

function attentionReason(health, signals, problems) {
  if (problems.length > 0) return problems[0].message;
  if (health === "red") return signals.find((signal) => signal.requirement === "required" && signal.state === "failing")?.reason ?? null;
  if (health === "yellow") return signals.find((signal) => signal.requirement === "required" && signal.state !== "passed")?.reason ?? null;
  return null;
}

function problemFrom(error, fallbackCode = "REPOSITORY_INSPECTION_FAILED") {
  return {
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    ...(typeof error?.path === "string" ? { path: error.path } : {}),
  };
}

async function inspectEntry(entry, now) {
  const problems = [];
  let rootMetadata;
  try {
    rootMetadata = await lstat(entry.root);
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return {
        repository: entry.repository,
        root: entry.root,
        classification: "misconfigured",
        health: "yellow",
        problems: [{ code: "REPOSITORY_ROOT_MISSING", message: "Enrolled repository root is missing." }],
        signals: [],
        attentionReason: "Enrolled repository root is missing.",
      };
    }
    throw error;
  }
  if (!rootMetadata.isDirectory()) problems.push({ code: "REPOSITORY_ROOT_INVALID", message: "Enrolled repository root is not a directory." });
  if (String(rootMetadata.dev) !== entry.rootIdentity.device || String(rootMetadata.ino) !== entry.rootIdentity.inode) {
    problems.push({ code: "REPOSITORY_ROOT_REPLACED", message: "Enrolled repository root identity changed." });
  }

  let committed = null;
  try {
    committed = await readRepositoryPolicyFile(join(entry.root, ".proofwake.json"));
  } catch (error) {
    problems.push(problemFrom(error, "REPOSITORY_POLICY_INVALID"));
  }

  let effectivePolicy = entry.policy;
  let effectiveSource = entry.configuration.source;
  let policyChanged = false;
  let globalPolicyShadowed = false;

  if (entry.configuration.source === "committed") {
    if (!committed) {
      if (!problems.some((problem) => problem.code.startsWith("REPOSITORY_POLICY_"))) {
        problems.push({ code: "REPOSITORY_POLICY_MISSING", message: "Committed policy is missing." });
      }
    } else {
      effectivePolicy = committed;
      policyChanged = repositoryPolicyFingerprint(committed) !== entry.configuration.fingerprint;
    }
  } else if (committed) {
    const committedFingerprint = repositoryPolicyFingerprint(committed);
    if (committedFingerprint !== entry.configuration.fingerprint) {
      problems.push({ code: "REPOSITORY_CONFIGURATION_CONFLICT", message: "Committed and approved global policies differ." });
      effectivePolicy = committed;
      effectiveSource = "committed";
    } else {
      effectivePolicy = committed;
      effectiveSource = "committed";
      globalPolicyShadowed = true;
    }
  }

  let inspection = null;
  try {
    inspection = await inspectRepositoryEnrollment(entry.root, {
      globalPolicy: effectiveSource === "global" ? effectivePolicy : undefined,
      lifecycle: effectivePolicy.lifecycle.state,
    });
  } catch (error) {
    problems.push(problemFrom(error));
  }

  return {
    repository: entry.repository,
    root: entry.root,
    policy: effectivePolicy,
    policySource: effectiveSource,
    policyChanged,
    globalPolicyShadowed,
    revision: inspection?.revision ?? null,
    branch: inspection?.branch ?? null,
    adapterReadiness: inspection?.adapterReadiness ?? {},
    problems,
    enrolledAt: entry.enrolledAt,
    updatedAt: entry.updatedAt,
    inspectedAt: now.toISOString(),
  };
}

export async function buildRepositoryInventory({ registryStore, eventStore, now = new Date() }) {
  const [registry, events] = await Promise.all([registryStore.read(), eventStore.readAll()]);
  const repositories = [];
  for (const entry of registry.entries) {
    const inspected = await inspectEntry(entry, now);
    if (!inspected.policy) {
      repositories.push({ ...inspected, classification: "misconfigured", health: "yellow", signals: [], attentionReason: inspected.problems[0]?.message ?? null });
      continue;
    }
    const observations = repositoryObservations(events, inspected.policy.repository);
    const latest = newest(observations);
    const signals = inspected.policy.signals.map((signal) => signalState(signal, observations, { revision: inspected.revision }, now));
    let classification;
    if (inspected.problems.length > 0) classification = "misconfigured";
    else if (inspected.policy.lifecycle.state === "dormant") classification = "dormant";
    else if (observations.length === 0) classification = "unobserved";
    else if (inspected.policy.lifecycle.dormantAfterDays !== undefined && latest &&
        now.getTime() - Date.parse(latest.data.observedAt) > inspected.policy.lifecycle.dormantAfterDays * 86_400_000) classification = "dormant";
    else classification = "active";
    const health = healthFromSignals(classification === "dormant" ? "dormant" : "active", signals, inspected.problems);
    repositories.push({
      ...inspected,
      classification,
      health,
      latestObservedAt: latest?.data.observedAt ?? null,
      latestRevision: inspected.revision,
      observationCount: observations.length,
      signals,
      attentionReason: attentionReason(health, signals, inspected.problems),
    });
  }
  repositories.sort((left, right) => left.repository.identity.localeCompare(right.repository.identity));
  return {
    service: "proofwake",
    command: "repositories",
    generatedAt: now.toISOString(),
    summary: {
      total: repositories.length,
      active: repositories.filter((repository) => repository.classification === "active").length,
      dormant: repositories.filter((repository) => repository.classification === "dormant").length,
      unobserved: repositories.filter((repository) => repository.classification === "unobserved").length,
      misconfigured: repositories.filter((repository) => repository.classification === "misconfigured").length,
      green: repositories.filter((repository) => repository.health === "green").length,
      yellow: repositories.filter((repository) => repository.health === "yellow").length,
      red: repositories.filter((repository) => repository.health === "red").length,
      grey: repositories.filter((repository) => repository.health === "grey").length,
    },
    repositories,
  };
}
