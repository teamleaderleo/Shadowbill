import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { buildFailureReport, buildRecoveryReport } from "../src/history-reports.js";
import { createCollectorServer, listen } from "../src/server.js";

const repository = "acme/http-history";
const revision = "c".repeat(40);

function policy() {
  return {
    version: 1,
    repository: { kind: "remote", id: repository, provider: "github" },
    lifecycle: { state: "active", dormantAfterDays: 30 },
    signals: [{
      kind: "verify",
      requirement: "required",
      subject: "revision",
      appliesTo: "every-revision",
      freshness: { mode: "revision" },
      acceptedSources: ["local-command"],
    }],
    adapters: [],
  };
}

function event(id, status, observedAt) {
  return {
    type: "proofwake_observation",
    id: `ledger-${id}`,
    requestFingerprint: `sha256:${id === "failed" ? "1" : id === "passed" ? "2" : "3"}`.padEnd(71, "0"),
    observation: {
      source: "urn:proofwake:adapter:local-command",
      id,
      data: {
        kind: "verify",
        status,
        observedAt,
        ingestedAt: new Date(Date.parse(observedAt) + 1000).toISOString(),
        adapter: { name: "local-command", version: "1.0.0", trust: "local-operator" },
        relationships: { repository, revision, run: id },
        coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
        evidence: [],
      },
    },
  };
}

function stores() {
  const registryStore = {
    read: async () => ({
      version: 1,
      entries: [{
        root: "/private/checkout/path",
        repository: { identity: repository, label: repository },
        policy: policy(),
      }],
    }),
  };
  const now = Date.now();
  const events = [
    event("failed", "failed", new Date(now - 60_000).toISOString()),
    event("passed", "passed", new Date(now - 30_000).toISOString()),
    event("current-failure", "failed", new Date(now - 10_000).toISOString()),
  ];
  const eventStore = { readAll: async () => events };
  return { registryStore, eventStore };
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: { accept: "application/json" },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, headers: response.headers, text, body: JSON.parse(text) });
      });
    });
    req.once("error", reject);
    req.end();
  });
}

async function withServer(options, callback) {
  const server = createCollectorServer({
    store: options.eventStore,
    registryStore: options.registryStore,
    collectorToken: "history-http-token-with-more-than-thirty-two-characters",
    timeZone: "UTC",
    pricing: {},
    profile: {},
  });
  const port = await listen(server, 0);
  try {
    await callback(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("failure and recovery HTTP reports match the direct projection contract", async () => {
  const state = stores();
  await withServer(state, async (port) => {
    const failuresResponse = await get(port, "/v1/failures?days=30");
    assert.equal(failuresResponse.status, 200);
    assert.equal(failuresResponse.headers["cache-control"], "no-store");
    assert.equal(failuresResponse.headers["access-control-allow-origin"], undefined);
    const failureDirect = await buildFailureReport({
      registryStore: state.registryStore,
      eventStore: state.eventStore,
      days: 30,
      now: new Date(failuresResponse.body.generatedAt),
    });
    assert.equal(failuresResponse.body.sourceCursor, failureDirect.sourceCursor);
    assert.deepEqual(failuresResponse.body.summary, failureDirect.summary);
    assert.deepEqual(failuresResponse.body.failures, failureDirect.failures);

    const recoveriesResponse = await get(port, "/v1/recoveries?days=30");
    assert.equal(recoveriesResponse.status, 200);
    const recoveryDirect = await buildRecoveryReport({
      registryStore: state.registryStore,
      eventStore: state.eventStore,
      days: 30,
      now: new Date(recoveriesResponse.body.generatedAt),
    });
    assert.equal(recoveriesResponse.body.sourceCursor, recoveryDirect.sourceCursor);
    assert.deepEqual(recoveriesResponse.body.summary, recoveryDirect.summary);
    assert.deepEqual(recoveriesResponse.body.recoveries, recoveryDirect.recoveries);

    for (const response of [failuresResponse, recoveriesResponse]) {
      assert.equal(response.text.includes("/private/checkout/path"), false);
    }
  });
});

test("history HTTP query validation returns stable machine errors", async () => {
  const state = stores();
  await withServer(state, async (port) => {
    for (const path of [
      "/v1/failures?days=0",
      "/v1/failures?days=abc",
      "/v1/recoveries?days=1&days=2",
      "/v1/recoveries?range=30",
    ]) {
      const response = await get(port, path);
      assert.equal(response.status, 400);
      assert.equal(response.body.status, "error");
      assert.equal(response.body.error.code, "HISTORY_REPORT_INVALID_QUERY");
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    }
  });
});

test("history HTTP routes require a registry location", async () => {
  const eventStore = { readAll: async () => [] };
  await withServer({ eventStore, registryStore: null }, async (port) => {
    for (const path of ["/v1/failures", "/v1/recoveries"]) {
      const response = await get(port, path);
      assert.equal(response.status, 503);
      assert.equal(response.body.status, "error");
      assert.equal(response.body.error.code, "HISTORY_REPORT_REGISTRY_UNAVAILABLE");
    }
  });
});
