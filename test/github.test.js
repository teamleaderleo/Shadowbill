import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeGitHubWebhook, verifyGitHubSignature } from "../src/github.js";

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

function signature(body, secret) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("verifies GitHub signatures without accepting malformed values", () => {
  const body = Buffer.from('{"hello":"world"}');
  assert.equal(verifyGitHubSignature(body, signature(body, "secret"), "secret"), true);
  assert.equal(verifyGitHubSignature(body, "sha256=bad", "secret"), false);
  assert.equal(verifyGitHubSignature(body, undefined, "secret"), false);
});

test("preserves the legacy GitHub webhook normalizer compatibility export", async () => {
  const push = normalizeGitHubWebhook("push", "delivery-1", await fixture("push"));
  assert.equal(push.type, "github_push");
  assert.equal(push.branch, "main");
  assert.equal(push.commitCount, 5);

  const pullRequest = normalizeGitHubWebhook("pull_request", "delivery-2", await fixture("pull_request"));
  assert.equal(pullRequest.type, "github_pull_request");
  assert.equal(pullRequest.merged, true);
  assert.equal(pullRequest.changedFiles, 5);

  const workflow = normalizeGitHubWebhook("workflow_run", "delivery-3", await fixture("workflow_run"));
  assert.equal(workflow.type, "github_workflow_run");
  assert.equal(workflow.conclusion, "success");
  assert.equal(workflow.durationMs, 210_000);

  const deployment = normalizeGitHubWebhook("deployment_status", "delivery-4", await fixture("deployment_status"));
  assert.equal(deployment.type, "github_deployment");
  assert.equal(deployment.environment, "production");
  assert.equal(deployment.state, "success");

  assert.equal(normalizeGitHubWebhook("ping", "delivery-5", {}), null);
});
