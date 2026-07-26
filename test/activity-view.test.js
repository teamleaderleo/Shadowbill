import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_OBSERVATION_TYPES,
  activityEventFromObservationRecord,
  buildActivityReportView,
} from "../src/activity-view.js";
import { observationFingerprint } from "../src/observation.js";

const REVISION = "a".repeat(40);

function githubEventName(type) {
  if (type === ACTIVITY_OBSERVATION_TYPES.githubPush) return "push";
  if (type === ACTIVITY_OBSERVATION_TYPES.githubPullRequest) return "pull_request";
  if (type === ACTIVITY_OBSERVATION_TYPES.githubWorkflowRun) return "workflow_run";
  return "deployment_status";
}

function observationRecord({ id, type, kind, status = "passed", facts = [], relationships = {}, durationMs }) {
  const repository = relationships.repository ?? "acme/repo";
  const revision = relationships.revision;
  const github = type.includes("github");
  const observation = {
    specversion: "1.0",
    id: github ? `github-${githubEventName(type)}-${id}` : id,
    source: github ? "urn:proofwake:provider:github" : "urn:proofwake:adapter:git",
    type,
    subject: revision ? `repo:${repository}@sha:${revision}` : `repo:${repository}`,
    time: "2026-07-26T13:00:00.000Z",
    dataschema: "urn:proofwake:schema:observation:v1",
    data: {
      schemaVersion: 1,
      adapter: {
        name: github ? "github" : "git",
        version: "1.0.0",
        mappingVersion: 1,
        trust: github ? "signed-provider" : "local-operator",
        sourceSchema: "activity.test",
        sourceSchemaVersion: "1",
      },
      kind,
      status,
      timeSource: github ? "provider" : "producer",
      observedAt: "2026-07-26T13:00:00.000Z",
      ingestedAt: "2026-07-26T13:00:01.000Z",
      ...(durationMs === undefined ? {} : { durationMs }),
      relationships: { repository, ...relationships },
      facts: facts.map(([name, value]) => ({ name, value })),
      evidence: [],
      coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
    },
  };
  return {
    type: "proofwake_observation",
    id: `record-${id}`,
    timestamp: observation.data.ingestedAt,
    requestFingerprint: observationFingerprint(observation),
    observationIdentity: { source: observation.source, id: observation.id },
    observation,
  };
}

test("maps the pure activity mapper contract into legacy report events", () => {
  const records = [
    observationRecord({
      id: "local-commit",
      type: ACTIVITY_OBSERVATION_TYPES.gitCommit,
      kind: "verify",
      relationships: { revision: REVISION },
      facts: [
        ["git.commit.additions", 10],
        ["git.commit.deletions", 2],
        ["git.commit.changed-files", 3],
        ["proofwake.retained-code-tokens", 100],
      ],
    }),
    observationRecord({
      id: "push-delivery",
      type: ACTIVITY_OBSERVATION_TYPES.githubPush,
      kind: "verify",
      relationships: { revision: REVISION },
      facts: [
        ["github.push.commit-count", 2],
        ["github.push.created", false],
        ["github.push.deleted", false],
        ["github.push.forced", false],
      ],
    }),
    observationRecord({
      id: "pr-delivery",
      type: ACTIVITY_OBSERVATION_TYPES.githubPullRequest,
      kind: "verify",
      relationships: { revision: REVISION },
      facts: [
        ["github.pull-request.number", 7],
        ["github.pull-request.additions", 10],
        ["github.pull-request.deletions", 2],
        ["github.pull-request.changed-files", 3],
      ],
    }),
    observationRecord({
      id: "workflow-delivery",
      type: ACTIVITY_OBSERVATION_TYPES.githubWorkflowRun,
      kind: "github-ci",
      relationships: { revision: REVISION, run: "github-workflow-99", workflowAttempt: 2 },
      durationMs: 1234,
      facts: [["github.workflow.rerun", true]],
    }),
    observationRecord({
      id: "deployment-delivery",
      type: ACTIVITY_OBSERVATION_TYPES.githubDeploymentStatus,
      kind: "deployment",
      relationships: { revision: REVISION, deployment: "github-deployment-42" },
      facts: [],
    }),
  ];

  assert.deepEqual(records.map(activityEventFromObservationRecord).map((event) => event.type), [
    "git_commit",
    "github_push",
    "github_pull_request",
    "github_workflow_run",
    "github_deployment",
  ]);
  const commit = activityEventFromObservationRecord(records[0]);
  assert.equal(commit.additions, 10);
  assert.equal(commit.addedCodeTokens, 100);
  const pullRequest = activityEventFromObservationRecord(records[2]);
  assert.equal(pullRequest.number, 7);
  assert.equal(pullRequest.merged, true);
  assert.equal(pullRequest.mergeCommitSha, REVISION);
  const workflow = activityEventFromObservationRecord(records[3]);
  assert.equal(workflow.runId, 99);
  assert.equal(workflow.runAttempt, 2);
  assert.equal(workflow.durationMs, 1234);
  assert.equal(workflow.conclusion, "success");
  assert.equal(workflow.workflow, "");
  const deployment = activityEventFromObservationRecord(records[4]);
  assert.equal(deployment.deploymentId, 42);
  assert.equal(deployment.state, "success");
  assert.equal(deployment.environment, "");
});

test("observation activity replaces matching legacy deliveries exactly once", () => {
  const observation = observationRecord({
    id: "same-delivery",
    type: ACTIVITY_OBSERVATION_TYPES.githubWorkflowRun,
    kind: "github-ci",
    relationships: { revision: REVISION, run: "github-workflow-9", workflowAttempt: 1 },
    facts: [["github.workflow.rerun", false]],
  });
  const legacy = {
    type: "github_workflow_run",
    id: "legacy",
    timestamp: "2026-07-26T13:00:00.000Z",
    repository: "acme/repo",
    runId: 9,
    workflow: "private workflow name",
    status: "completed",
    conclusion: "success",
    headSha: REVISION,
    runAttempt: 1,
    durationMs: null,
    deliveryId: "same-delivery",
  };
  const chat = { type: "chat_turn", id: "chat", timestamp: "2026-07-26T12:00:00.000Z" };

  const view = buildActivityReportView([legacy, chat, observation]);
  assert.equal(view.length, 2);
  assert.equal(view[0], chat);
  assert.equal(view[1].type, "github_workflow_run");
  assert.equal(view[1].deliveryId, "same-delivery");
  assert.equal(JSON.stringify(view).includes("private workflow name"), false);
});

test("unknown, malformed, untrusted, or unbound observations do not hide legacy activity", () => {
  const legacy = {
    type: "git_commit",
    id: "legacy",
    timestamp: "2026-07-26T13:00:00.000Z",
    repository: "acme/repo",
    sha: REVISION,
  };
  const unknown = observationRecord({ id: "unknown", type: "dev.proofwake.other.v1", kind: "verify" });
  const malformed = { type: "proofwake_observation", observation: { id: "bad" } };
  const untrusted = observationRecord({
    id: "untrusted",
    type: ACTIVITY_OBSERVATION_TYPES.githubWorkflowRun,
    kind: "github-ci",
    relationships: { revision: REVISION, run: "github-workflow-1", workflowAttempt: 1 },
    facts: [["github.workflow.rerun", false]],
  });
  untrusted.observation.data.adapter.trust = "untrusted-observation";
  const unbound = observationRecord({
    id: "unbound",
    type: ACTIVITY_OBSERVATION_TYPES.githubWorkflowRun,
    kind: "github-ci",
    relationships: { revision: REVISION, run: "github-workflow-2", workflowAttempt: 1 },
    facts: [],
  });
  unbound.requestFingerprint = `sha256:${"0".repeat(64)}`;

  assert.deepEqual(buildActivityReportView([legacy, unknown, malformed, untrusted, unbound]), [legacy]);
});

test("malformed provider delivery and relationship identities fail closed", () => {
  const badDelivery = observationRecord({
    id: "bad-delivery",
    type: ACTIVITY_OBSERVATION_TYPES.githubWorkflowRun,
    kind: "github-ci",
    relationships: { revision: REVISION, run: "github-workflow-9", workflowAttempt: 1 },
    facts: [],
  });
  badDelivery.observation.id = "github-workflow_run-bad delivery";
  badDelivery.observationIdentity.id = badDelivery.observation.id;
  badDelivery.requestFingerprint = observationFingerprint(badDelivery.observation);
  const badRun = observationRecord({
    id: "run-delivery",
    type: ACTIVITY_OBSERVATION_TYPES.githubWorkflowRun,
    kind: "github-ci",
    relationships: { revision: REVISION, run: "github-workflow-09", workflowAttempt: 1 },
    facts: [],
  });
  assert.equal(activityEventFromObservationRecord(badDelivery), null);
  assert.equal(activityEventFromObservationRecord(badRun), null);
});
