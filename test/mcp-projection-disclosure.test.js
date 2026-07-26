import assert from "node:assert/strict";
import test from "node:test";
import { discloseProofwakeProjection } from "../src/projection-mcp-disclosure.js";

const REVISION = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

test("MCP projection disclosure preserves evidence semantics while excluding local and content-derived detail", () => {
  const privatePath = "/private/worktree/.proofwake/receipt.json";
  const projection = {
    service: "proofwake",
    command: "inspect",
    projectionVersion: 1,
    sourceCursor: `sha256:${"c".repeat(64)}`,
    repository: { identity: "acme/private", label: "acme/private", value: { kind: "remote", id: "acme/private", provider: "github" } },
    repositoryState: "misconfigured",
    selectedRevision: REVISION,
    selectedRevisionSource: "explicit",
    configuration: {
      source: "committed",
      fingerprint: `sha256:${"d".repeat(64)}`,
      changedSinceEnrolment: false,
      problems: [{
        code: "REPOSITORY_POLICY_UNKNOWN_FIELD",
        message: `Unknown source content from ${privatePath}`,
        path: "$.adapters[0].privateField",
      }],
    },
    policy: {
      version: 1,
      repository: { kind: "remote", id: "acme/private", provider: "github" },
      lifecycle: { state: "active", dormantAfterDays: 30 },
      signals: [{
        kind: "verify",
        requirement: "required",
        subject: "revision",
        appliesTo: "every-revision",
        freshness: { mode: "revision" },
        acceptedSources: ["local-command"],
      }],
      adapters: [{
        name: "renderprove",
        type: "receipt-file",
        path: ".proofwake/renderprove.json",
        schema: "renderprove.receipt.v1",
        trust: "verified-receipt",
      }],
    },
    status: "yellow",
    attention: {
      type: "configuration",
      reason: `Unknown source content from ${privatePath}`,
      signal: null,
      observation: null,
    },
    signals: [{
      policy: {
        kind: "verify",
        requirement: "required",
        subject: "revision",
        appliesTo: "every-revision",
        freshness: { mode: "revision" },
        acceptedSources: ["local-command"],
      },
      state: "passed",
      reason: "Passing evidence satisfies the selected policy signal.",
      attempts: 2,
      reruns: 1,
      latest: {
        source: "urn:proofwake:adapter:local-command",
        id: "verify-passed",
        adapter: { name: "local-command", version: "1.0.0", trust: "local-operator" },
        relationships: { repository: "acme/private", revision: REVISION },
        coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
        evidence: [{
          uri: `file://${privatePath}`,
          digest: DIGEST,
          mediaType: "application/json",
          producer: "renderprove",
          schema: "renderprove.receipt.v1",
          state: "verified",
          disclosure: "restricted-reference",
        }],
      },
      recovery: {
        type: "same-revision-rerun",
        relation: "same-revision",
        causality: "sequence-only",
      },
    }],
  };

  const disclosed = discloseProofwakeProjection(projection);

  assert.equal(disclosed.projectionVersion, projection.projectionVersion);
  assert.equal(disclosed.sourceCursor, projection.sourceCursor);
  assert.deepEqual(disclosed.repository, projection.repository);
  assert.equal(disclosed.selectedRevision, REVISION);
  assert.equal(disclosed.repositoryState, "misconfigured");
  assert.equal(disclosed.status, "yellow");
  assert.equal(disclosed.signals[0].attempts, 2);
  assert.equal(disclosed.signals[0].reruns, 1);
  assert.deepEqual(disclosed.signals[0].recovery, projection.signals[0].recovery);
  assert.equal(disclosed.signals[0].latest.adapter.trust, "local-operator");
  assert.equal(disclosed.signals[0].latest.coverage.state, "complete");
  assert.equal(disclosed.signals[0].latest.evidence[0].digest, DIGEST);
  assert.equal(disclosed.signals[0].latest.evidence[0].uri, `urn:proofwake:evidence:${DIGEST}`);
  assert.deepEqual(disclosed.policy.adapters[0], {
    name: "renderprove",
    type: "receipt-file",
    schema: "renderprove.receipt.v1",
    trust: "verified-receipt",
  });
  assert.deepEqual(disclosed.configuration.problems, [{
    code: "REPOSITORY_POLICY_UNKNOWN_FIELD",
    message: "Repository policy is invalid.",
  }]);
  assert.equal(disclosed.attention.reason, "Repository policy is invalid.");
  assert.equal(JSON.stringify(disclosed).includes(privatePath), false);
  assert.equal(JSON.stringify(disclosed).includes("privateField"), false);
});

test("fleet projection errors retain stable codes with bounded attention text", () => {
  const privatePath = "/private/worktree";
  const projection = {
    projectionVersion: 1,
    sourceCursor: `sha256:${"e".repeat(64)}`,
    repositories: [{
      repository: { identity: "acme/broken" },
      classification: "misconfigured",
      status: "yellow",
      panelError: { code: "PROJECTION_PANEL_FAILED", message: `git failed at ${privatePath}` },
      attention: { type: "projection-error", reason: `git failed at ${privatePath}`, signal: null, observation: null },
    }],
  };

  const disclosed = discloseProofwakeProjection(projection);
  assert.deepEqual(disclosed.repositories[0].panelError, {
    code: "PROJECTION_PANEL_FAILED",
    message: "Repository projection is unavailable.",
  });
  assert.equal(disclosed.repositories[0].attention.reason, "Repository projection is unavailable.");
  assert.equal(JSON.stringify(disclosed).includes(privatePath), false);
});
