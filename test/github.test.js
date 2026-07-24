import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeGitHubWebhook, verifyGitHubSignature } from "../src/github.js";
import { DEFAULT_WORKING_PROFILE } from "../src/estimate.js";
import { createCollectorServer, listen } from "../src/server.js";
import { JsonlEventStore } from "../src/store.js";

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const pricing = {
  inputPerMillion: 5,
  cachedInputPerMillion: 0.5,
  cacheWritePerMillion: 6.25,
  outputPerMillion: 30,
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: 2,
  longContextOutputMultiplier: 1.5,
};

function signature(body, secret) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("verifies GitHub signatures without accepting malformed values", () => {
  const body = Buffer.from('{"hello":"world"}');
  assert.equal(verifyGitHubSignature(body, signature(body, "secret"), "secret"), true);
  assert.equal(verifyGitHubSignature(body, "sha256=bad", "secret"), false);
  assert.equal(verifyGitHubSignature(body, undefined, "secret"), false);
});

test("normalizes supported GitHub webhook fixtures", async () => {
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

test("accepts signed webhook deliveries once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadowbill-webhook-"));
  const store = new JsonlEventStore(join(directory, "events.jsonl"));
  const secret = "test-secret";
  const server = createCollectorServer({
    store,
    pricing,
    profile: DEFAULT_WORKING_PROFILE,
    githubWebhookSecret: secret,
    timeZone: "America/Los_Angeles",
  });
  const port = await listen(server, 0);

  try {
    const body = Buffer.from(JSON.stringify(await fixture("push")));
    const send = () => fetch(`http://127.0.0.1:${port}/v1/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "delivery-http-1",
        "x-hub-signature-256": signature(body, secret),
      },
      body,
    });

    const first = await send();
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { accepted: true, duplicate: false, id: "github_push_delivery-http-1" });

    const second = await send();
    assert.equal(second.status, 202);
    assert.deepEqual(await second.json(), { accepted: true, duplicate: true, id: "github_push_delivery-http-1" });
    assert.equal((await store.readAll()).length, 1);

    const rejected = await fetch(`http://127.0.0.1:${port}/v1/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "delivery-http-2",
        "x-hub-signature-256": "sha256=wrong",
      },
      body,
    });
    assert.equal(rejected.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
