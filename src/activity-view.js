import { createHash } from "node:crypto";

const OBSERVATION_SCHEMA = "urn:proofwake:schema:observation:v1";
const OBSERVATION_RECORD = "proofwake_observation";

export const ACTIVITY_OBSERVATION_TYPES = Object.freeze({
  gitCommit: "dev.proofwake.git.commit.v1",
  githubPush: "dev.proofwake.github.push.v1",
  githubPullRequest: "dev.proofwake.github.pull-request.v1",
  githubWorkflowRun: "dev.proofwake.github.workflow-run.v1",
  githubDeploymentStatus: "dev.proofwake.github.deployment-status.v1",
});

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function observationFromRecord(record) {
  if (!isObject(record) || record.type !== OBSERVATION_RECORD || !isObject(record.observation)) return null;
  const observation = record.observation;
  if (observation.specversion !== "1.0" || observation.dataschema !== OBSERVATION_SCHEMA ||
      typeof observation.id !== "string" || typeof observation.source !== "string" ||
      typeof observation.type !== "string" || typeof observation.time !== "string" ||
      Number.isNaN(Date.parse(observation.time)) || new Date(observation.time).toISOString() !== observation.time ||
      !isObject(observation.data) || !isObject(observation.data.adapter) ||
      !isObject(observation.data.relationships) || !Array.isArray(observation.data.facts)) {
    return null;
  }
  return observation;
}

function factsOf(observation) {
  const facts = new Map();
  for (const fact of observation.data.facts) {
    if (!isObject(fact) || typeof fact.name !== "string" || facts.has(fact.name)) return null;
    const value = fact.value;
    if (typeof value !== "string" && typeof value !== "boolean" && !Number.isSafeInteger(value)) return null;
    facts.set(fact.name, value);
  }
  return facts;
}

function stringFact(facts, name, fallback = "") {
  const value = facts.get(name);
  return typeof value === "string" ? value : fallback;
}

function integerFact(facts, name, fallback = 0) {
  const value = facts.get(name);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function booleanFact(facts, name, fallback = false) {
  const value = facts.get(name);
  return typeof value === "boolean" ? value : fallback;
}

function repositoryOf(observation) {
  const repository = observation.data.relationships.repository;
  return typeof repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
    ? repository
    : null;
}

function revisionOf(observation) {
  const revision = observation.data.relationships.revision;
  return typeof revision === "string" && /^[a-f0-9]{40}$/u.test(revision) ? revision : null;
}

function eventId(observation) {
  const digest = createHash("sha256")
    .update(`${observation.source}\u0000${observation.id}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `activity_${digest}`;
}

function workflowConclusion(status) {
  if (status === "passed") return "success";
  if (status === "failed") return "failure";
  if (status === "cancelled") return "cancelled";
  if (status === "warning") return "neutral";
  if (status === "unavailable") return "skipped";
  return null;
}

function deploymentState(status) {
  if (status === "passed") return "success";
  if (status === "failed") return "failure";
  if (status === "cancelled") return "inactive";
  if (status === "warning") return "pending";
  return "unknown";
}

function mapGitCommit(observation, facts) {
  const repository = repositoryOf(observation);
  const revision = revisionOf(observation);
  if (!repository || !revision) return null;
  return {
    type: "git_commit",
    id: eventId(observation),
    timestamp: observation.time,
    repository,
    branch: "",
    sha: revision,
    subject: "",
    additions: integerFact(facts, "git.additions"),
    deletions: integerFact(facts, "git.deletions"),
    changedFiles: integerFact(facts, "git.changed-files"),
    addedCodeTokens: integerFact(facts, "git.added-code-tokens"),
    collectorVersion: "observation-v1",
  };
}

function mapGitHubPush(observation, facts) {
  const repository = repositoryOf(observation);
  if (!repository) return null;
  return {
    type: "github_push",
    id: eventId(observation),
    timestamp: observation.time,
    repository,
    ref: "",
    branch: "",
    before: stringFact(facts, "github.push.before"),
    after: stringFact(facts, "github.push.after", revisionOf(observation) ?? ""),
    commitCount: integerFact(facts, "github.push.commit-count"),
    created: booleanFact(facts, "github.push.created"),
    deleted: booleanFact(facts, "github.push.deleted"),
    forced: booleanFact(facts, "github.push.forced"),
    deliveryId: observation.id,
  };
}

function mapGitHubPullRequest(observation, facts) {
  const repository = repositoryOf(observation);
  const number = integerFact(facts, "github.pull-request.number", -1);
  if (!repository || number < 0) return null;
  return {
    type: "github_pull_request",
    id: eventId(observation),
    timestamp: observation.time,
    repository,
    action: stringFact(facts, "github.pull-request.action", "unknown"),
    number,
    state: stringFact(facts, "github.pull-request.state", "unknown"),
    merged: booleanFact(facts, "github.pull-request.merged"),
    draft: booleanFact(facts, "github.pull-request.draft"),
    headSha: stringFact(facts, "github.pull-request.head-sha"),
    baseSha: stringFact(facts, "github.pull-request.base-sha"),
    mergeCommitSha: facts.has("github.pull-request.merge-commit-sha")
      ? stringFact(facts, "github.pull-request.merge-commit-sha")
      : null,
    additions: integerFact(facts, "github.pull-request.additions"),
    deletions: integerFact(facts, "github.pull-request.deletions"),
    changedFiles: integerFact(facts, "github.pull-request.changed-files"),
    deliveryId: observation.id,
  };
}

function mapGitHubWorkflowRun(observation, facts) {
  const repository = repositoryOf(observation);
  const runId = integerFact(facts, "github.workflow-run.id", -1);
  const headSha = stringFact(facts, "github.workflow-run.head-sha", revisionOf(observation) ?? "");
  if (!repository || runId < 0) return null;
  const conclusion = workflowConclusion(observation.data.status);
  return {
    type: "github_workflow_run",
    id: eventId(observation),
    timestamp: observation.time,
    repository,
    runId,
    workflow: "",
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    headSha,
    runAttempt: Number.isSafeInteger(observation.data.relationships.workflowAttempt) &&
        observation.data.relationships.workflowAttempt >= 1
      ? observation.data.relationships.workflowAttempt
      : 1,
    durationMs: facts.has("github.workflow-run.duration-ms")
      ? integerFact(facts, "github.workflow-run.duration-ms")
      : null,
    deliveryId: observation.id,
  };
}

function mapGitHubDeployment(observation, facts) {
  const repository = repositoryOf(observation);
  const deploymentId = integerFact(facts, "github.deployment.id", -1);
  const sha = stringFact(facts, "github.deployment.sha", revisionOf(observation) ?? "");
  if (!repository || deploymentId < 0) return null;
  return {
    type: "github_deployment",
    id: eventId(observation),
    timestamp: observation.time,
    repository,
    deploymentId,
    state: deploymentState(observation.data.status),
    environment: "",
    sha,
    ref: "",
    deliveryId: observation.id,
  };
}

const SOURCE_REQUIREMENTS = new Map([
  [ACTIVITY_OBSERVATION_TYPES.gitCommit, { adapter: "git", trust: "local-operator" }],
  [ACTIVITY_OBSERVATION_TYPES.githubPush, { adapter: "github", trust: "signed-provider" }],
  [ACTIVITY_OBSERVATION_TYPES.githubPullRequest, { adapter: "github", trust: "signed-provider" }],
  [ACTIVITY_OBSERVATION_TYPES.githubWorkflowRun, { adapter: "github", trust: "signed-provider" }],
  [ACTIVITY_OBSERVATION_TYPES.githubDeploymentStatus, { adapter: "github", trust: "signed-provider" }],
]);

const MAPPERS = new Map([
  [ACTIVITY_OBSERVATION_TYPES.gitCommit, mapGitCommit],
  [ACTIVITY_OBSERVATION_TYPES.githubPush, mapGitHubPush],
  [ACTIVITY_OBSERVATION_TYPES.githubPullRequest, mapGitHubPullRequest],
  [ACTIVITY_OBSERVATION_TYPES.githubWorkflowRun, mapGitHubWorkflowRun],
  [ACTIVITY_OBSERVATION_TYPES.githubDeploymentStatus, mapGitHubDeployment],
]);

export function activityEventFromObservationRecord(record) {
  const observation = observationFromRecord(record);
  if (!observation) return null;
  const mapper = MAPPERS.get(observation.type);
  const source = SOURCE_REQUIREMENTS.get(observation.type);
  if (!mapper || !source || observation.data.adapter.name !== source.adapter ||
      observation.data.adapter.trust !== source.trust) return null;
  const facts = factsOf(observation);
  return facts === null ? null : mapper(observation, facts);
}

function deliveryKey(event) {
  if (!isObject(event) || typeof event.type !== "string") return null;
  if (event.type === "git_commit" && typeof event.repository === "string" && typeof event.sha === "string") {
    return `git:${event.repository}:${event.sha}`;
  }
  if (event.type.startsWith("github_") && typeof event.deliveryId === "string" && event.deliveryId.length > 0) {
    return `github:${event.deliveryId}`;
  }
  return null;
}

/**
 * Builds the read-only compatibility view used by estimate reports during the
 * legacy-to-observation migration. Observation-backed activity replaces a
 * matching legacy delivery so a dual representation is counted once.
 */
export function buildActivityReportView(events) {
  const mappedByIndex = new Map();
  const observationKeys = new Set();

  events.forEach((record, index) => {
    const mapped = activityEventFromObservationRecord(record);
    if (!mapped) return;
    mappedByIndex.set(index, mapped);
    const key = deliveryKey(mapped);
    if (key !== null) observationKeys.add(key);
  });

  const result = [];
  events.forEach((event, index) => {
    const mapped = mappedByIndex.get(index);
    if (mapped) {
      result.push(mapped);
      return;
    }
    if (event?.type === OBSERVATION_RECORD) return;
    const key = deliveryKey(event);
    if (key !== null && observationKeys.has(key)) return;
    result.push(event);
  });
  return result;
}
