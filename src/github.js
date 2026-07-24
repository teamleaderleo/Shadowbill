import { createHmac, timingSafeEqual } from "node:crypto";

function string(value) {
  return typeof value === "string" ? value : "";
}

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

function repository(payload) {
  const fullName = payload?.repository?.full_name;
  if (typeof fullName !== "string" || fullName.length === 0) {
    throw new Error("GitHub payload is missing repository.full_name");
  }
  return fullName;
}

function timestamp(value, fallback) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function deliveryEventId(eventName, deliveryId) {
  if (!/^[a-z0-9_]+$/i.test(eventName)) throw new Error("Invalid GitHub event name");
  if (!/^[a-z0-9-]+$/i.test(deliveryId)) throw new Error("Invalid GitHub delivery ID");
  return `github_${eventName}_${deliveryId}`;
}

/**
 * @param {Buffer} body
 * @param {string|undefined} signature
 * @param {string} secret
 */
export function verifyGitHubSignature(body, signature, secret) {
  if (!Buffer.isBuffer(body) || typeof signature !== "string" || typeof secret !== "string" || secret.length === 0) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(signature, "utf8");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

/**
 * Converts supported GitHub webhook payloads into content-minimized ledger events.
 * @param {string} eventName
 * @param {string} deliveryId
 * @param {any} payload
 * @param {string} [receivedAt]
 * @returns {import('./types.js').ShadowbillEvent|null}
 */
export function normalizeGitHubWebhook(eventName, deliveryId, payload, receivedAt = new Date().toISOString()) {
  const id = deliveryEventId(eventName, deliveryId);

  if (eventName === "push") {
    const repo = repository(payload);
    const ref = string(payload.ref);
    return {
      type: "github_push",
      id,
      timestamp: timestamp(payload.head_commit?.timestamp, receivedAt),
      repository: repo,
      ref,
      branch: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref,
      before: string(payload.before),
      after: string(payload.after),
      commitCount: number(payload.size) || (Array.isArray(payload.commits) ? payload.commits.length : 0),
      created: Boolean(payload.created),
      deleted: Boolean(payload.deleted),
      forced: Boolean(payload.forced),
      deliveryId,
    };
  }

  if (eventName === "pull_request") {
    const repo = repository(payload);
    const pullRequest = payload.pull_request;
    if (!pullRequest || typeof pullRequest !== "object") throw new Error("GitHub pull_request payload is missing pull_request");
    return {
      type: "github_pull_request",
      id,
      timestamp: timestamp(pullRequest.updated_at, receivedAt),
      repository: repo,
      action: string(payload.action),
      number: number(payload.number),
      state: string(pullRequest.state),
      merged: Boolean(pullRequest.merged),
      draft: Boolean(pullRequest.draft),
      headSha: string(pullRequest.head?.sha),
      baseSha: string(pullRequest.base?.sha),
      mergeCommitSha: typeof pullRequest.merge_commit_sha === "string" ? pullRequest.merge_commit_sha : null,
      additions: number(pullRequest.additions),
      deletions: number(pullRequest.deletions),
      changedFiles: number(pullRequest.changed_files),
      deliveryId,
    };
  }

  if (eventName === "workflow_run") {
    const repo = repository(payload);
    const run = payload.workflow_run;
    if (!run || typeof run !== "object") throw new Error("GitHub workflow_run payload is missing workflow_run");
    const startedAt = Date.parse(run.run_started_at ?? "");
    const completedAt = Date.parse(run.updated_at ?? "");
    return {
      type: "github_workflow_run",
      id,
      timestamp: timestamp(run.updated_at, receivedAt),
      repository: repo,
      runId: number(run.id),
      workflow: string(run.name),
      status: string(run.status),
      conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
      headSha: string(run.head_sha),
      runAttempt: Math.max(1, number(run.run_attempt)),
      durationMs: Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt
        ? completedAt - startedAt
        : null,
      deliveryId,
    };
  }

  if (eventName === "deployment_status") {
    const repo = repository(payload);
    const deployment = payload.deployment;
    const status = payload.deployment_status;
    if (!deployment || typeof deployment !== "object" || !status || typeof status !== "object") {
      throw new Error("GitHub deployment_status payload is missing deployment data");
    }
    return {
      type: "github_deployment",
      id,
      timestamp: timestamp(status.updated_at ?? status.created_at, receivedAt),
      repository: repo,
      deploymentId: number(deployment.id),
      state: string(status.state),
      environment: string(deployment.environment ?? status.environment),
      sha: string(deployment.sha),
      ref: string(deployment.ref),
      deliveryId,
    };
  }

  return null;
}
