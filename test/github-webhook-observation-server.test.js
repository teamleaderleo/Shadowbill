import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_WORKING_PROFILE } from "../src/estimate.js";
import { mapGitHubWebhookObservation } from "../src/github-observation.js";
import { buildRevisionProjection } from "../src/inspect-projection.js";
import { observationLedgerRecord } from "../src/observation-ledger.js";
import { inspectRepositoryEnrollment } from "../src/repository-enrollment.js";
import { RepositoryRegistryStore } from "../src/repository-registry.js";
import { createCollectorServer, listen } from "../src/server.js";
import { JsonlEventStore } from "../src/store.js";

const exec = promisify(execFile);
const SECRET = "github-webhook-observation-secret";
const FIXED_NOW = "2026-07-25T20:00:00.000Z";
const pricing = {
  inputPerMillion: 5,
  cachedInputPerMillion: 0.5,
  cacheWritePerMillion: 6.25,
  outputPerMillion: 30,
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
};

async function fixtures() {
  return JSON.parse(await readFile(new URL("./fixtures/github-observations.json", import.meta.url), "utf8"));
}

function signature(body, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function requestWebhook(port, {
  eventName,
  deliveryId,
  payload,
  body = Buffer.from(JSON.stringify(payload)),
  signatureValue,
  includeEvent = true,
  includeDelivery = true,
} = {}) {
  const headers = {
    "content-type": "application/json",
    "x-hub-signature-256": signatureValue ?? signature(body),
  };
  if (includeEvent) headers["x-github-event"] = eventName;
  if (includeDelivery) headers["x-github-delivery"] = deliveryId;
  const response = await fetch(`http://127.0.0.1:${port}/v1/github/webhooks`, {
    method: "POST",
    headers,
    body,
  });
  const text = await response.text();
  return { status: response.status, value: text.length === 0 ? null : JSON.parse(text), text };
}

async function withServer(callback, { now = () => new Date(FIXED_NOW) } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "proofwake-live-github-webhooks-"));
  const store = new JsonlEventStore(join(directory, "events.jsonl"));
  const server = createCollectorServer({
    store,
    pricing,
    profile: DEFAULT_WORKING_PROFILE,
    githubWebhookSecret: SECRET,
    timeZone: "America/Los_Angeles",
    now,
  });
  const port = await listen(server, 0);
  try {
    await callback({ directory, port, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

function privateContent(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /PRIVATE_[A-Z0-9_]+_SENTINEL/u.test(text) ||
    text.includes("private.example.test") ||
    text.includes(".github/workflows/private-ci.yml") ||
    text.includes("refs/heads/private/customer-fix");
}

async function git(root, ...args) {
  const { stdout } = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function createProjectionRegistry(directory) {
  const root = join(directory, "projection-repository");
  await mkdir(root);
  await exec("git", ["init", "-q", "-b", "main", root]);
  await git(root, "config", "user.name", "Proofwake Test");
  await git(root, "config", "user.email", "proofwake@example.invalid");
  await git(root, "remote", "add", "origin", "https://github.com/owner/repo.git");
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, ".proofwake.json"), `${JSON.stringify({
    version: 1,
    repository: { kind: "remote", id: "owner/repo", provider: "github" },
    lifecycle: { state: "active", dormantAfterDays: 30 },
    signals: [{
      kind: "github-ci",
      requirement: "required",
      subject: "revision",
      appliesTo: "every-revision",
      freshness: { mode: "revision" },
      acceptedSources: ["github"],
    }],
    adapters: [],
  }, null, 2)}\n`);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "initial");
  const registryStore = new RepositoryRegistryStore(join(directory, "repositories.json"));
  await registryStore.enroll(await inspectRepositoryEnrollment(root), { now: new Date(FIXED_NOW) });
  return registryStore;
}

test("signature verification remains the authority gate and malformed input stays bounded", async () => {
  const data = await fixtures();
  await withServer(async ({ port, store }) => {
    const invalidSignature = await requestWebhook(port, {
      ...data.push,
      signatureValue: "sha256=wrong",
    });
    assert.equal(invalidSignature.status, 401);
    assert.equal(invalidSignature.value.error.code, "GITHUB_WEBHOOK_INVALID_SIGNATURE");
    assert.equal((await store.readAll()).length, 0);

    const missingHeader = await requestWebhook(port, { ...data.push, includeDelivery: false });
    assert.equal(missingHeader.status, 400);
    assert.equal(missingHeader.value.error.code, "GITHUB_WEBHOOK_INVALID_HEADERS");

    const malformedBody = Buffer.from('{"repository":');
    const malformed = await requestWebhook(port, {
      eventName: "push",
      deliveryId: "malformed-json",
      body: malformedBody,
      signatureValue: signature(malformedBody),
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.value.error.code, "GITHUB_WEBHOOK_INVALID_JSON");

    const hostile = structuredClone(data.push);
    hostile.deliveryId = "hostile-payload";
    hostile.payload.repository.full_name = "PRIVATE_ATTACKER_ERROR_SENTINEL";
    const invalidPayload = await requestWebhook(port, hostile);
    assert.equal(invalidPayload.status, 400);
    assert.equal(invalidPayload.value.error.code, "GITHUB_OBSERVATION_INVALID_REPOSITORY");
    assert.equal(privateContent(invalidPayload.text), false);

    const ignored = await requestWebhook(port, {
      eventName: "ping",
      deliveryId: "ignored-ping",
      payload: { secret: "PRIVATE_UNSUPPORTED_PAYLOAD_SENTINEL" },
    });
    assert.equal(ignored.status, 202);
    assert.deepEqual(ignored.value, { accepted: true, ignored: true, event: "ping" });
    assert.equal(privateContent(ignored.text), false);
    assert.equal((await store.readAll()).length, 0);
  });
});

test("verified supported deliveries append one observation each without legacy dual writes or private content", async () => {
  const data = await fixtures();
  const supported = [
    data.push,
    data.pullRequest,
    data.workflowSuccess,
    data.workflowFailure,
    data.workflowCancelled,
    data.workflowRerun,
    data.deploymentSuccess,
    data.deploymentFailure,
    data.release,
  ];

  await withServer(async ({ directory, port, store }) => {
    for (const entry of supported) {
      const result = await requestWebhook(port, entry);
      assert.equal(result.status, 202);
      assert.equal(result.value.accepted, true);
      assert.equal(result.value.duplicate, false);
      assert.equal(privateContent(result.text), false);
    }

    const unmerged = structuredClone(data.pullRequest);
    unmerged.deliveryId = "delivery-pr-unmerged";
    unmerged.payload.pull_request.merged = false;
    const unmergedResult = await requestWebhook(port, unmerged);
    assert.equal(unmergedResult.status, 202);
    assert.deepEqual(unmergedResult.value, { accepted: true, ignored: true, event: "pull_request" });

    const unsupportedRelease = await requestWebhook(port, data.releaseWithoutRevisionAuthority);
    assert.equal(unsupportedRelease.status, 202);
    assert.deepEqual(unsupportedRelease.value, { accepted: true, ignored: true, event: "release" });

    const events = await store.readAll();
    assert.equal(events.length, supported.length);
    assert.equal(events.every((event) => event.type === "proofwake_observation"), true);
    assert.equal(events.some((event) => event.type.startsWith("github_")), false);

    const observations = events.map((event) => event.observation);
    assert.equal(observations.every((observation) => observation.data.adapter.trust === "signed-provider"), true);
    assert.deepEqual(observations.map((observation) => observation.data.status), [
      "passed", "passed", "passed", "failed", "cancelled", "passed", "passed", "failed", "passed",
    ]);
    assert.equal(observations.find((observation) => observation.id.includes("workflow-rerun"))
      .data.relationships.workflowAttempt, 2);
    assert.equal(observations.find((observation) => observation.id.includes("release-1"))
      .data.relationships.revision, "d".repeat(40));

    const ledgerText = await readFile(join(directory, "events.jsonl"), "utf8");
    assert.equal(privateContent(ledgerText), false);
    for (const excluded of [
      "PRIVATE_CREDENTIAL_SENTINEL",
      "PRIVATE_PR_BODY_SENTINEL",
      "PRIVATE_RELEASE_BODY_SENTINEL",
      "PRIVATE_ENVIRONMENT_SENTINEL",
    ]) assert.equal(ledgerText.includes(excluded), false);
  });
});

test("exact replay is duplicate and changed delivery reuse returns bounded observation conflict", async () => {
  const data = await fixtures();
  const times = [
    new Date("2026-07-25T20:00:00.000Z"),
    new Date("2026-07-25T20:05:00.000Z"),
    new Date("2026-07-25T20:10:00.000Z"),
  ];
  let index = 0;
  await withServer(async ({ port, store }) => {
    const first = await requestWebhook(port, data.push);
    assert.equal(first.status, 202);
    assert.equal(first.value.duplicate, false);

    const replay = await requestWebhook(port, data.push);
    assert.equal(replay.status, 202);
    assert.equal(replay.value.duplicate, true);
    assert.equal((await store.readAll()).length, 1);

    const changed = structuredClone(data.push);
    changed.payload.forced = false;
    changed.payload.head_commit.message = "PRIVATE_CONFLICTING_COMMIT_SENTINEL";
    const conflict = await requestWebhook(port, changed);
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.value, {
      accepted: false,
      error: {
        code: "OBSERVATION_ID_CONFLICT",
        message: "Observation identity was reused with different semantics.",
      },
    });
    assert.equal(privateContent(conflict.text), false);
    assert.equal((await store.readAll()).length, 1);
  }, { now: () => times[Math.min(index++, times.length - 1)] });
});

test("reordered equal-time workflow attempts preserve mixed legacy and observation projection parity", async () => {
  const data = await fixtures();
  const equalTime = new Date("2026-07-25T20:00:00.000Z");
  await withServer(async ({ directory, port, store }) => {
    const rerun = structuredClone(data.workflowRerun);
    rerun.payload.workflow_run.updated_at = "2026-07-25T19:59:00.000Z";
    rerun.payload.workflow_run.run_started_at = "2026-07-25T19:58:00.000Z";
    const live = await requestWebhook(port, rerun);
    assert.equal(live.status, 202);
    const liveRecord = (await store.readAll())[0];

    const failure = structuredClone(data.workflowFailure);
    failure.payload.workflow_run.updated_at = "2026-07-25T19:59:00.000Z";
    failure.payload.workflow_run.run_started_at = "2026-07-25T19:58:30.000Z";
    const failureObservation = mapGitHubWebhookObservation(
      failure.eventName,
      failure.deliveryId,
      failure.payload,
      { signatureVerified: true, receivedAt: equalTime.toISOString() },
    );
    const failureRecord = observationLedgerRecord(failureObservation);
    const legacyFailure = {
      type: "github_workflow_run",
      id: "legacy-workflow-failure",
      timestamp: equalTime.toISOString(),
      repository: "owner/repo",
      runId: 9002,
      workflow: "PRIVATE_LEGACY_WORKFLOW_SENTINEL",
      status: "completed",
      conclusion: "failure",
      headSha: "c".repeat(40),
      runAttempt: 1,
      durationMs: 30_000,
      deliveryId: failure.deliveryId,
    };
    const registryStore = await createProjectionRegistry(directory);
    const project = (events) => buildRevisionProjection({
      repository: "owner/repo",
      revision: "c".repeat(40),
      registryStore,
      eventStore: { readAll: async () => events },
      now: equalTime,
    });
    const mixed = await project([liveRecord, legacyFailure]);
    const observations = await project([failureRecord, liveRecord]);

    for (const report of [mixed, observations]) {
      const signal = report.signals[0];
      assert.equal(report.status, "yellow");
      assert.equal(signal.state, "partial");
      assert.equal(signal.attempts, 2);
      assert.equal(signal.reruns, 1);
      assert.deepEqual(signal.workflowAttempts, [1, 2]);
      assert.equal(signal.latest.status, "passed");
      assert.equal(signal.recovery, null);
    }
    assert.deepEqual(
      {
        status: mixed.status,
        state: mixed.signals[0].state,
        attempts: mixed.signals[0].attempts,
        reruns: mixed.signals[0].reruns,
        workflowAttempts: mixed.signals[0].workflowAttempts,
        latestStatus: mixed.signals[0].latest.status,
        recovery: mixed.signals[0].recovery,
      },
      {
        status: observations.status,
        state: observations.signals[0].state,
        attempts: observations.signals[0].attempts,
        reruns: observations.signals[0].reruns,
        workflowAttempts: observations.signals[0].workflowAttempts,
        latestStatus: observations.signals[0].latest.status,
        recovery: observations.signals[0].recovery,
      },
    );
    assert.equal(JSON.stringify(mixed).includes("PRIVATE_LEGACY_WORKFLOW_SENTINEL"), false);
  }, { now: () => equalTime });
});
