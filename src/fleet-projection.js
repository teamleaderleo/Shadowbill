import { createHash } from "node:crypto";
import { buildRepositoryInventory } from "./repository-inventory.js";
import { buildFleetProjection as buildRawFleetProjection } from "./revision-projection.js";

const INCOMPLETE_STATES = new Set([
  "missing",
  "stale",
  "partial",
  "unavailable",
  "selection-unavailable",
  "warning",
]);

function configurationAttention(item) {
  const problem = item.problems?.[0];
  return {
    type: "configuration",
    reason: problem?.message ?? item.attentionReason ?? "Repository configuration requires attention.",
    signal: null,
    observation: null,
  };
}

function defaultBranchSignalKinds(item) {
  return new Set((item.policy?.signals ?? [])
    .filter((signal) => signal.requirement === "required" && signal.subject === "revision" && signal.appliesTo === "default-branch")
    .map((signal) => signal.kind));
}

function enforceDefaultBranchAuthority(repository, item) {
  if (repository.revision?.defaultBranchConfidence !== "conventional-current") return;
  const kinds = defaultBranchSignalKinds(item);
  const reason = "Default-branch selection requires an explicit local remote HEAD.";
  repository.requiredSignals = repository.requiredSignals.map((signal) => kinds.has(signal.kind)
    ? { ...signal, state: "selection-unavailable", latest: null }
    : signal);
  if (repository.recentRecovery && kinds.has(repository.recentRecovery.from?.kind)) repository.recentRecovery = null;
  repository.revision.defaultBranch = null;
  repository.revision.defaultBranchSelected = false;
  repository.revision.defaultBranchConfidence = "unavailable";
  repository.selectorCorrection = { code: "PROJECTION_DEFAULT_BRANCH_UNVERIFIED", reason };
}

function repositoryStatus(repository, item) {
  if (repository.classification === "dormant") return "grey";
  if (repository.classification === "unobserved" && repository.status === "grey") return "grey";
  if (repository.classification === "misconfigured" || item.problems?.length > 0 || repository.panelError) return "yellow";
  if (repository.requiredSignals.some((signal) => signal.state === "failing")) return "red";
  if (repository.requiredSignals.length > 0 && repository.requiredSignals.every((signal) => signal.state === "passed")) return "green";
  return "yellow";
}

function repositoryAttention(repository, item) {
  if (item.problems?.length > 0 || repository.classification === "misconfigured") return configurationAttention(item);
  if (repository.panelError) {
    return { type: "projection-error", reason: repository.panelError.message, signal: null, observation: null };
  }
  if (repository.status === "grey") return repository.attention;
  const failing = repository.requiredSignals.find((signal) => signal.state === "failing");
  if (failing) {
    return {
      type: "failing",
      reason: `Latest accepted ${failing.kind} observation is failing.`,
      signal: failing.kind,
      observation: failing.latest,
    };
  }
  const incomplete = repository.requiredSignals.find((signal) => INCOMPLETE_STATES.has(signal.state));
  if (incomplete) {
    const reason = repository.selectorCorrection && incomplete.state === "selection-unavailable"
      ? repository.selectorCorrection.reason
      : `${incomplete.kind} evidence is ${incomplete.state}.`;
    return { type: incomplete.state, reason, signal: incomplete.kind, observation: incomplete.latest };
  }
  return null;
}

function contextualRepositoryCursor(repository, item) {
  const payload = {
    base: repository.sourceCursor,
    classification: repository.classification,
    status: repository.status,
    revision: repository.revision,
    problems: (item.problems ?? []).map((problem) => ({ code: problem.code, path: problem.path ?? null })),
    requiredSignals: repository.requiredSignals.map((signal) => ({ kind: signal.kind, state: signal.state, latest: signal.latest?.id ?? null })),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex")}`;
}

function rank(status) {
  return { red: 0, yellow: 1, grey: 2, green: 3 }[status] ?? 4;
}

export async function buildFleetProjection(options) {
  const [report, inventory] = await Promise.all([
    buildRawFleetProjection(options),
    buildRepositoryInventory(options),
  ]);
  const inventoryByIdentity = new Map(inventory.repositories.map((item) => [item.repository.identity, item]));

  for (const repository of report.repositories) {
    const item = inventoryByIdentity.get(repository.repository.identity) ?? repository;
    repository.problems = item.problems ?? [];
    enforceDefaultBranchAuthority(repository, item);
    repository.status = repositoryStatus(repository, item);
    const currentFailure = repository.requiredSignals.find((signal) => signal.state === "failing") ?? null;
    const missingOrStale = repository.requiredSignals.find((signal) => INCOMPLETE_STATES.has(signal.state)) ?? null;
    repository.currentFailure = currentFailure
      ? { signal: currentFailure.kind, reason: `Latest accepted ${currentFailure.kind} observation is failing.`, observation: currentFailure.latest }
      : null;
    repository.missingOrStale = missingOrStale
      ? {
        signal: missingOrStale.kind,
        state: missingOrStale.state,
        reason: repository.selectorCorrection && missingOrStale.state === "selection-unavailable"
          ? repository.selectorCorrection.reason
          : `${missingOrStale.kind} evidence is ${missingOrStale.state}.`,
      }
      : null;
    repository.attention = repositoryAttention(repository, item);
    repository.sourceCursor = contextualRepositoryCursor(repository, item);
  }

  report.summary = {
    total: report.repositories.length,
    green: report.repositories.filter((repository) => repository.status === "green").length,
    red: report.repositories.filter((repository) => repository.status === "red").length,
    yellow: report.repositories.filter((repository) => repository.status === "yellow").length,
    grey: report.repositories.filter((repository) => repository.status === "grey").length,
  };
  report.attentionOrder = report.repositories
    .filter((repository) => repository.status !== "green")
    .sort((left, right) => rank(left.status) - rank(right.status) || left.repository.identity.localeCompare(right.repository.identity))
    .map((repository) => repository.repository.identity);
  report.sourceCursor = `sha256:${createHash("sha256").update(JSON.stringify({
    repositories: report.repositories.map((repository) => [repository.repository.identity, repository.sourceCursor]).sort(),
  }), "utf8").digest("hex")}`;
  return report;
}
