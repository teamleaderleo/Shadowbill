import { lstat, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { inspectRepositoryEnrollment } from "./repository-enrollment.js";
import { inspectAdapterPaths, normalizeRepositoryPolicy } from "./repository-policy.js";

function asError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "REPOSITORY_INSPECTION_FAILED",
    message: error instanceof Error ? error.message : String(error),
    ...(typeof error?.path === "string" ? { path: error.path } : {}),
  };
}

function timestamp(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function observationFromRecord(record) {
  return record?.type === "proofwake_observation" && record.observation && typeof record.observation === "object"
    ? record.observation
    : null;
}

function relevantLegacyEvent(event, repository) {
  return event && typeof event === "object" && event.repository === repository &&
    ["git_commit", "github_push", "github_pull_request", "github_workflow_run", "github_deployment"].includes(event.type);
}

function latestBy(values, selector) {
  let latest = null;
  let latestTime = null;
  for (const value of values) {
    const candidateTime = timestamp(selector(value));
    if (candidateTime && (latestTime === null || candidateTime > latestTime)) {
      latest = value;
      latestTime = candidateTime;
    }
  }
  return { value: latest, time: latestTime };
}

function revisionCandidateFromLegacy(event) {
  if (event.type === "git_commit") return event.sha;
  if (event.type === "github_push") return event.after;
  if (event.type === "github_pull_request") return event.headSha;
  if (event.type === "github_workflow_run") return event.headSha;
  if (event.type === "github_deployment") return event.sha;
  return null;
}

function latestRevision(observations, legacy) {
  const candidates = [];
  for (const observation of observations) {
    const revision = observation.data?.relationships?.revision;
    if (typeof revision === "string") candidates.push({ revision, at: observation.data.observedAt ?? observation.time });
  }
  for (const event of legacy) {
    const revision = revisionCandidateFromLegacy(event);
    if (typeof revision === "string" && /^[a-f0-9]{40}$/.test(revision)) candidates.push({ revision, at: event.timestamp });
  }
  return latestBy(candidates, (candidate) => candidate.at).value?.revision ?? null;
}

function signalReport(signal, observations, currentRevision, now) {
  const candidates = observations.filter((observation) => {
    if (observation.data.kind !== signal.kind) return false;
    if (["revision", "default-branch"].includes(signal.scope) && currentRevision) {
      return observation.data.relationships?.revision === currentRevision;
    }
    return true;
  });
  const latest = latestBy(candidates, (observation) => observation.data.observedAt ?? observation.time).value;
  if (!latest) {
    return {
      ...signal,
      state: "missing",
      observation: null,
      ageHours: null,
      coverage: null,
    };
  }
  const observedAt = timestamp(latest.data.observedAt ?? latest.time);
  const ageHours = observedAt ? Math.max(0, (now.getTime() - new Date(observedAt).getTime()) / 3_600_000) : null;
  const stale = signal.staleAfterHours > 0 && ageHours !== null && ageHours > signal.staleAfterHours;
  return {
    ...signal,
    state: stale ? "stale" : latest.data.status,
    observation: {
      source: latest.source,
      id: latest.id,
      subject: latest.subject,
      sourceTime: latest.time,
      observedAt: latest.data.observedAt,
      ingestedAt: latest.data.ingestedAt,
    },
    ageHours,
    coverage: latest.data.coverage?.state ?? "unavailable",
  };
}

function healthFromSignals(lifecycle, signals) {
  if (lifecycle === "dormant") return "grey";
  const required = signals.filter((signal) => signal.required);
  if (required.length === 0) return "grey";
  if (required.some((signal) => signal.state === "failed")) return "red";
  if (required.some((signal) => signal.state !== "passed" || signal.coverage !== "complete")) return "yellow";
  return "green";
}

function attentionFromSignals(classification, signals) {
  if (classification === "misconfigured") return "repository configuration needs attention";
  if (classification === "dormant") return "repository is declared dormant";
  const failed = signals.find((signal) => signal.required && signal.state === "failed");
  if (failed) return `required ${failed.kind} evidence is failing`;
  const missing = signals.find((signal) => signal.required && signal.state === "missing");
  if (missing) return `required ${missing.kind} evidence is missing`;
  const stale = signals.find((signal) => signal.required && signal.state === "stale");
  if (stale) return `required ${stale.kind} evidence is stale`;
  const partial = signals.find((signal) => signal.required && signal.coverage !== "complete");
  if (partial) return `required ${partial.kind} evidence has ${partial.coverage} coverage`;
  if (classification === "unobserved") return "no repository observations have been accepted";
  return null;
}

async function inspectEntry(entry, events, now) {
  const problems = [];
  let rootMetadata;
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(entry.root);
    rootMetadata = await stat(canonicalRoot);
    if (!rootMetadata.isDirectory()) throw new Error("Repository root is not a directory.");
    if (canonicalRoot !== entry.root || String(rootMetadata.dev) !== entry.rootIdentity.device || String(rootMetadata.ino) !== entry.rootIdentity.inode) {
      problems.push({ code: "REPOSITORY_ROOT_IDENTITY_CHANGED", message: "Repository root identity changed after enrolment." });
    }
  } catch (error) {
    problems.push(asError(error));
  }

  let policy = normalizeRepositoryPolicy(entry.policy);
  let configuration = { ...entry.configuration };
  let adapterReadiness = {};
  let checkoutRevision = null;
  let checkoutBranch = null;
  if (problems.length === 0) {
    try {
      const configPath = join(entry.root, ".proofwake.json");
      let committedExists = false;
      try {
        const metadata = await lstat(configPath);
        committedExists = true;
        if (metadata.isSymbolicLink()) {
          const error = new Error(".proofwake.json must not be a symbolic link.");
          error.code = "REPOSITORY_POLICY_SYMLINK";
          throw error;
        }
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (entry.configuration.source === "committed") {
        const current = await inspectRepositoryEnrollment(entry.root, { repository: entry.repository });
        if (current.configuration.source !== "committed") {
          const error = new Error("Committed .proofwake.json is missing.");
          error.code = "REPOSITORY_POLICY_MISSING";
          throw error;
        }
        policy = current.policy;
        configuration = current.configuration;
        adapterReadiness = current.adapterReadiness;
        checkoutRevision = current.revision;
        checkoutBranch = current.branch;
      } else {
        if (committedExists) {
          const error = new Error("A committed .proofwake.json now conflicts with the approved global policy; enrol again to adopt it.");
          error.code = "REPOSITORY_CONFIGURATION_CONFLICT";
          throw error;
        }
        policy = normalizeRepositoryPolicy(entry.policy);
        adapterReadiness = await inspectAdapterPaths(entry.root, policy.adapters);
        const current = await inspectRepositoryEnrollment(entry.root, {
          repository: entry.repository,
          lifecycle: policy.lifecycle,
        });
        checkoutRevision = current.revision;
        checkoutBranch = current.branch;
      }
    } catch (error) {
      problems.push(asError(error));
    }
  }

  const acceptedObservations = events.map(observationFromRecord).filter(Boolean)
    .filter((observation) => observation.data?.relationships?.repository === entry.repository);
  const legacy = events.filter((event) => relevantLegacyEvent(event, entry.repository));
  const observedRevision = latestRevision(acceptedObservations, legacy);
  const currentRevision = checkoutRevision ?? observedRevision;
  const signals = problems.length === 0
    ? policy.expectedSignals.map((signal) => signalReport(signal, acceptedObservations, currentRevision, now))
    : [];
  const allActivity = [
    ...acceptedObservations.map((observation) => timestamp(observation.data.observedAt ?? observation.time)),
    ...legacy.map((event) => timestamp(event.timestamp)),
  ].filter(Boolean);
  const latestActivityAt = allActivity.sort().at(-1) ?? null;
  const latestIngestedAt = acceptedObservations.map((observation) => observation.data.ingestedAt).filter(Boolean).sort().at(-1) ?? null;
  const classification = problems.length > 0
    ? "misconfigured"
    : policy.lifecycle === "dormant"
      ? "dormant"
      : allActivity.length === 0
        ? "unobserved"
        : "active";
  const health = problems.length > 0 ? "grey" : healthFromSignals(policy.lifecycle, signals);

  return {
    repository: entry.repository,
    root: entry.root,
    classification,
    health,
    lifecycle: policy.lifecycle,
    latestRevision: currentRevision,
    latestRevisionSource: checkoutRevision ? "checkout" : observedRevision ? "observation" : null,
    checkoutBranch,
    latestActivityAt,
    latestIngestedAt,
    configuration: {
      source: configuration.source,
      path: configuration.path,
      digest: configuration.digest,
      approvedAt: entry.approvedAt,
      approval: entry.approval,
    },
    sourceCoverage: {
      acceptedObservations: acceptedObservations.length,
      legacyEvents: legacy.length,
      adapterReadiness,
    },
    signals,
    attentionReason: attentionFromSignals(classification, signals),
    problems,
  };
}

export async function buildRepositoryInventory({ registryStore, eventStore, now = new Date() }) {
  const [registry, events] = await Promise.all([registryStore.read(), eventStore.readAll()]);
  const repositories = [];
  for (const entry of registry.entries) repositories.push(await inspectEntry(entry, events, now));
  const summary = repositories.reduce((result, repository) => {
    result[repository.classification] += 1;
    result.health[repository.health] += 1;
    return result;
  }, {
    total: repositories.length,
    active: 0,
    dormant: 0,
    unobserved: 0,
    misconfigured: 0,
    health: { green: 0, red: 0, yellow: 0, grey: 0 },
  });
  return {
    service: "proofwake",
    report: "repositories",
    generatedAt: now.toISOString(),
    summary,
    repositories,
  };
}
