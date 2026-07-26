import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_OBSERVATION_TYPES,
  activityEventFromObservationRecord,
  buildActivityReportView,
} from "../src/activity-view.js";

const REVISION = "a".repeat(40);

function observationRecord({ id, type, kind, status = "passed", facts = [], relationships = {} }) {
  const repository = relationships.repository ?? "acme/repo";
  const revision = relationships.revision;
  return {
    type: "proofwake_observation",
    id: `record-${id}`,
    timestamp: "2026-07-26T13:00:01.000Z",
    observation: {
      specversion: "1.0",
      id,
      source: "https://api.github.com/hooks/proofwake",
      type,
      subject: revision ? `repo:${repository}@sha:${revision}` : `repo:${repository}`,
      time: "2026-07-26T13:00:00.000Z",
      dataschema: "urn:proofwake:schema:observation:v1",
      data: {
        schemaVersion: 1,
        adapter: {
          name: type.includes("github") ? "github" : "git",
          version: "1.0.0",
          mappingVersion: 1,
          trust: type.includes("github") ? "signed-provider" : "local-operator",
          sourceSchema: "activity.test",
          sourceSchemaVersion: "1",
        },
        kind,
        status,
        timeSource: "provider",
        observedAt: "2026-07-26T13:00:00.000Z",
        ingestedAt: "2026-07-26T13:00:01.000Z",
        relationships: { repository, ...relationships },
        facts: facts.map(([name, value]) => ({ name, value })),
        evidence: [],
        coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
      },
    },
  };
}

test("maps bounded observation activity into legacy report events", () => {
  const records = [
    observationRecord({
      id: "local-commit",
      type: ACTIVITY_OBSERVATION_TYPES.gitCommit,
      kind: "verify",
      relationships: { revision: REVISION },
      facts: [
        ["git.additions", 10],
        ["git.deletions", 2],
        ["git.changed-files", 3],
        ["git.added-code-tokens", 100],
      ],
    }),
    observationRecord({
      id: "push-delivery",
      type: ACTIVITY_OBSERVATION_TYPES.githubPush,
      kind: "verify",
      relationships: { revision: REVISION },
      facts: [
        ["github.push.before", "b".repeat(40)],
        ["github.push.after", REVISION],
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
        ["github.pull-request.action", "closed"],
        ["github.pull-request.state", "closed"],
        ["github.pull-request.merged", true],
        ["github.pull-request.draft", false],
        ["github.pull-request.head-sha", REVISION],
        ["github.pull-request.base-sha", "b".repeat(40)],
        ["github.pull-request.merge-commit-sha", "c".repeat(40)],
        ["github.pull-request.additions", 10],
        ["github.pull-request.deletions", 2],
        ["github.pull-request.changed-files", 3],
      ],
    }),
    observationRecord({
      id: "workflow-delivery",
      type: ACTIVITY_OBSERVATION_TYPES.githubWorkflowRun,
      kind: "github-ci",
      relationships: { revision: REVISION, workflowAttempt: 2 },
      facts: [
        ["github.workflow-run.id", 99],
        ["github.workflow-run.head-sha", REVISION],
        ["github.workflow-run.duration-ms", 1234],
      ],
    }),
    observationRecord({
      id: "deployment-delivery",
      type: ACTIVITY_OBSERVATION_TYPES.githubDeploymentStatus,
      kind: "deployment",
      relationships: { revision: REVISION },
      facts: [
        ["github.deployment.id", 42],
        ["github.deployment.sha", REVISION],
      ],
    }),
  ];

  assert.deepEqual(records.map(activityEventFromObservationRecord).map((event) => event.type), [
    "git_commit",
    "github_push",
    "github_pull_request",
    "github_workflow_run",
    "github_deployment",
  ]);
  const workflow = activityEventFromObservationRecord(records[3]);
  assert.equal(workflow.runId, 99);
  assert.equal(workflow.runAttempt, 2);
  assert.equal(workflow.conclusion, "success");
  assert.equal(workflow.workflow, "");
  const deployment = activityEventFromObservationRecord(records[4]);
  assert.equal(deployment.state, "success");
  assert.equal(deployment.environment, "");
});

test("observation activity replaces matching legacy deliveries exactly once", () => {
  const observation = observationRecord({
    id: "same-delivery",
    type: ACTIVITY_OBSERVATION_TYPES.githubWorkflowRun,
    kind: "github-ci",
    relationships: { revision: REVISION, workflowAttempt: 1 },
    facts: [["github.workflow-run.id", 9]],
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

test("unknown, malformed, or untrusted observations do not hide legacy activity", () => {
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
    relationships: { revision: REVISION },
    facts: [["github.workflow-run.id", 1]],
  });
  untrusted.observation.data.adapter.trust = "untrusted-observation";

  assert.deepEqual(buildActivityReportView([legacy, unknown, malformed, untrusted]), [legacy]);
});
