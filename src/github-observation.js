import {
  boundedToken,
  canonicalRepository,
  createActivityObservation,
  fullRevision,
  githubDeliveryEvidence,
  mappedTimes,
  mappingFailure,
  nonNegativeInteger,
  optionalFullRevision,
  partialCoverage,
} from "./activity-observation.js";

const SUPPORTED_EVENTS = new Set(["push", "pull_request", "workflow_run", "deployment_status", "release"]);
const ADAPTER = Object.freeze({
  name: "github",
  version: "1.0.0",
  mappingVersion: 1,
  trust: "signed-provider",
  sourceSchema: "github-webhook",
  sourceSchemaVersion: "2022-11-28",
});

function object(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) mappingFailure(code, message);
  return value;
}

function repository(payload) {
  return canonicalRepository(payload?.repository?.full_name, "GITHUB_OBSERVATION_INVALID_REPOSITORY");
}

function providerTimes(sourceTime, options) {
  if (typeof options.receivedAt !== "string") {
    mappingFailure("GITHUB_OBSERVATION_RECEIVED_AT_REQUIRED", "receivedAt is required for GitHub observations.");
  }
  return mappedTimes(sourceTime, options.receivedAt, options.ingestedAt ?? options.receivedAt);
}

function optionalCount(value, factName, field) {
  const count = nonNegativeInteger(value, "GITHUB_OBSERVATION_INVALID_COUNT", field, { optional: true });
  return count === undefined ? null : { name: factName, value: count };
}

function retainedCodeFact(options) {
  const count = nonNegativeInteger(
    options.retainedCodeTokens,
    "GITHUB_OBSERVATION_INVALID_RETAINED_CODE",
    "retainedCodeTokens",
    { optional: true },
  );
  return count === undefined ? null : { name: "proofwake.retained-code-tokens", value: count };
}

function base({ eventName, deliveryId, payload, times, type, subject, kind, status, durationMs, relationships, facts, omitted }) {
  return createActivityObservation({
    id: `github-${eventName}-${deliveryId}`,
    source: "urn:proofwake:provider:github",
    type,
    subject,
    time: times.time,
    adapter: ADAPTER,
    kind,
    status,
    timeSource: "provider",
    observedAt: times.observedAt,
    ingestedAt: times.ingestedAt,
    durationMs,
    relationships,
    facts,
    evidence: githubDeliveryEvidence(eventName, deliveryId, payload),
    coverage: partialCoverage(omitted),
  });
}

function mapPush(deliveryId, payload, options) {
  const repo = repository(payload);
  const revision = optionalFullRevision(payload.after, "GITHUB_OBSERVATION_INVALID_REVISION");
  const sourceTime = payload?.head_commit?.timestamp ?? options.receivedAt;
  const times = providerTimes(sourceTime, options);
  const commitCount = payload.size === undefined
    ? Array.isArray(payload.commits) ? payload.commits.length : 0
    : nonNegativeInteger(payload.size, "GITHUB_OBSERVATION_INVALID_COUNT", "size");
  const facts = [
    { name: "github.push.commit-count", value: commitCount },
    { name: "github.push.created", value: Boolean(payload.created) },
    { name: "github.push.deleted", value: Boolean(payload.deleted) },
    { name: "github.push.forced", value: Boolean(payload.forced) },
    retainedCodeFact(options),
  ].filter(Boolean);
  const relationships = revision ? { repository: repo, revision } : { repository: repo };
  return base({
    eventName: "push",
    deliveryId,
    payload,
    times,
    type: "dev.proofwake.github.push.v1",
    subject: revision ? `repo:${repo}@sha:${revision}` : `repo:${repo}`,
    kind: "verify",
    status: "passed",
    relationships,
    facts,
    omitted: [
      "github.payload.redacted",
      "github.commit-prose.redacted",
      "github.patch.redacted",
      "github.paths.redacted",
      "github.ref-name.redacted",
      "github.credentials.redacted",
    ],
  });
}

function mapPullRequest(deliveryId, payload, options) {
  const pullRequest = object(
    payload.pull_request,
    "GITHUB_OBSERVATION_INVALID_PULL_REQUEST",
    "GitHub pull_request payload is missing pull_request.",
  );
  if (payload.action !== "closed" || pullRequest.merged !== true) return null;
  const repo = repository(payload);
  const revision = fullRevision(pullRequest.merge_commit_sha, "GITHUB_OBSERVATION_INVALID_REVISION");
  const number = nonNegativeInteger(payload.number, "GITHUB_OBSERVATION_INVALID_PULL_REQUEST", "number", { minimum: 1 });
  const times = providerTimes(pullRequest.merged_at ?? pullRequest.updated_at, options);
  const facts = [
    { name: "github.pull-request.number", value: number },
    optionalCount(pullRequest.additions, "github.pull-request.additions", "pull_request.additions"),
    optionalCount(pullRequest.deletions, "github.pull-request.deletions", "pull_request.deletions"),
    optionalCount(pullRequest.changed_files, "github.pull-request.changed-files", "pull_request.changed_files"),
    retainedCodeFact(options),
  ].filter(Boolean);
  return base({
    eventName: "pull_request",
    deliveryId,
    payload,
    times,
    type: "dev.proofwake.github.pull-request-merged.v1",
    subject: `repo:${repo}@sha:${revision}`,
    kind: "verify",
    status: "passed",
    relationships: {
      repository: repo,
      revision,
      correlations: [`github-pull-request-${number}`],
    },
    facts,
    omitted: [
      "github.payload.redacted",
      "github.pull-request-prose.redacted",
      "github.patch.redacted",
      "github.paths.redacted",
      "github.comments.redacted",
      "github.credentials.redacted",
    ],
  });
}

function workflowStatus(run) {
  if (run.status !== "completed") return "unknown";
  if (run.conclusion === "success") return "passed";
  if (run.conclusion === "cancelled") return "cancelled";
  if (["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(run.conclusion)) return "failed";
  if (["neutral", "skipped"].includes(run.conclusion)) return "warning";
  return "unknown";
}

function workflowDuration(run) {
  if (typeof run.run_started_at !== "string" || typeof run.updated_at !== "string") return undefined;
  const start = Date.parse(run.run_started_at);
  const end = Date.parse(run.updated_at);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
}

function mapWorkflowRun(deliveryId, payload, options) {
  const run = object(
    payload.workflow_run,
    "GITHUB_OBSERVATION_INVALID_WORKFLOW_RUN",
    "GitHub workflow_run payload is missing workflow_run.",
  );
  const repo = repository(payload);
  const revision = fullRevision(run.head_sha, "GITHUB_OBSERVATION_INVALID_REVISION");
  const runId = nonNegativeInteger(run.id, "GITHUB_OBSERVATION_INVALID_WORKFLOW_RUN", "workflow_run.id", { minimum: 1 });
  const attempt = nonNegativeInteger(
    run.run_attempt,
    "GITHUB_OBSERVATION_INVALID_WORKFLOW_RUN",
    "workflow_run.run_attempt",
    { minimum: 1 },
  );
  const times = providerTimes(run.updated_at, options);
  return base({
    eventName: "workflow_run",
    deliveryId,
    payload,
    times,
    type: "dev.proofwake.github.workflow-run.v1",
    subject: `repo:${repo}@sha:${revision}`,
    kind: "github-ci",
    status: workflowStatus(run),
    durationMs: workflowDuration(run),
    relationships: {
      repository: repo,
      revision,
      run: `github-workflow-${runId}`,
      workflowAttempt: attempt,
    },
    facts: [{ name: "github.workflow.rerun", value: attempt > 1 }],
    omitted: [
      "github.payload.redacted",
      "github.workflow-name.redacted",
      "github.workflow-path.redacted",
      "github.logs.redacted",
      "github.jobs.redacted",
      "github.credentials.redacted",
    ],
  });
}

function deploymentStatus(state) {
  if (["success", "active"].includes(state)) return "passed";
  if (["failure", "error"].includes(state)) return "failed";
  if (state === "inactive") return "warning";
  return "unknown";
}

function mapDeploymentStatus(deliveryId, payload, options) {
  const deployment = object(
    payload.deployment,
    "GITHUB_OBSERVATION_INVALID_DEPLOYMENT",
    "GitHub deployment_status payload is missing deployment.",
  );
  const deploymentState = object(
    payload.deployment_status,
    "GITHUB_OBSERVATION_INVALID_DEPLOYMENT",
    "GitHub deployment_status payload is missing deployment_status.",
  );
  const repo = repository(payload);
  const revision = fullRevision(deployment.sha, "GITHUB_OBSERVATION_INVALID_REVISION");
  const deploymentId = nonNegativeInteger(
    deployment.id,
    "GITHUB_OBSERVATION_INVALID_DEPLOYMENT",
    "deployment.id",
    { minimum: 1 },
  );
  const times = providerTimes(deploymentState.updated_at ?? deploymentState.created_at, options);
  return base({
    eventName: "deployment_status",
    deliveryId,
    payload,
    times,
    type: "dev.proofwake.github.deployment-status.v1",
    subject: `repo:${repo}@sha:${revision}`,
    kind: "deployment",
    status: deploymentStatus(deploymentState.state),
    relationships: {
      repository: repo,
      revision,
      deployment: `github-deployment-${deploymentId}`,
    },
    facts: [],
    omitted: [
      "github.payload.redacted",
      "github.environment.redacted",
      "github.deployment-url.redacted",
      "github.deployment-description.redacted",
      "github.logs.redacted",
      "github.credentials.redacted",
    ],
  });
}

function mapRelease(deliveryId, payload, options) {
  const release = object(
    payload.release,
    "GITHUB_OBSERVATION_INVALID_RELEASE",
    "GitHub release payload is missing release.",
  );
  if (payload.action !== "published" || release.draft === true) return null;
  const revision = optionalFullRevision(release.target_commitish, "GITHUB_OBSERVATION_INVALID_REVISION");
  if (revision === null || typeof release.published_at !== "string") return null;
  const repo = repository(payload);
  const releaseId = nonNegativeInteger(release.id, "GITHUB_OBSERVATION_INVALID_RELEASE", "release.id", { minimum: 1 });
  const times = providerTimes(release.published_at, options);
  return base({
    eventName: "release",
    deliveryId,
    payload,
    times,
    type: "dev.proofwake.github.release-published.v1",
    subject: `repo:${repo}@sha:${revision}`,
    kind: "verify",
    status: "passed",
    relationships: {
      repository: repo,
      revision,
      correlations: [`github-release-${releaseId}`],
    },
    facts: [
      { name: "github.release.id", value: releaseId },
      { name: "github.release.prerelease", value: Boolean(release.prerelease) },
    ],
    omitted: [
      "github.payload.redacted",
      "github.release-prose.redacted",
      "github.release-name.redacted",
      "github.release-tag.redacted",
      "github.release-url.redacted",
      "github.credentials.redacted",
    ],
  });
}

/**
 * Maps one already-verified GitHub delivery into Proofwake observation v1.
 * Unsupported event families and authority-insufficient release variants return
 * null. The caller remains responsible for signature verification.
 *
 * @param {string} eventName
 * @param {string} deliveryId
 * @param {Record<string, unknown>} payload
 * @param {{signatureVerified: boolean, receivedAt: string, ingestedAt?: string, retainedCodeTokens?: number}} options
 */
export function mapGitHubWebhookObservation(eventName, deliveryId, payload, options = {}) {
  if (!SUPPORTED_EVENTS.has(eventName)) return null;
  if (options.signatureVerified !== true) {
    mappingFailure("GITHUB_OBSERVATION_UNVERIFIED_DELIVERY", "GitHub delivery signature must be verified before mapping.");
  }
  object(payload, "GITHUB_OBSERVATION_INVALID_PAYLOAD", "GitHub payload must be an object.");
  boundedToken(deliveryId, "GITHUB_OBSERVATION_INVALID_DELIVERY", "deliveryId");

  if (eventName === "push") return mapPush(deliveryId, payload, options);
  if (eventName === "pull_request") return mapPullRequest(deliveryId, payload, options);
  if (eventName === "workflow_run") return mapWorkflowRun(deliveryId, payload, options);
  if (eventName === "deployment_status") return mapDeploymentStatus(deliveryId, payload, options);
  return mapRelease(deliveryId, payload, options);
}
