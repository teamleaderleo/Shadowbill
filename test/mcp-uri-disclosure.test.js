import assert from "node:assert/strict";
import test from "node:test";
import { discloseProofwakeProjection } from "../src/projection-mcp-disclosure.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function evidence(uri, digest) {
  return {
    uri,
    digest,
    mediaType: "application/json",
    producer: "test",
    schema: "test.receipt.v1",
    state: "verified",
    disclosure: "restricted-reference",
  };
}

test("MCP disclosure hashes unreviewed observation sources and evidence URIs", () => {
  const privateSource = "urn:private:/home/operator/checkout?token=PRIVATE_SOURCE_TOKEN";
  const privateUrn = "urn:private:/home/operator/receipt.json";
  const secretHttps = "https://example.test/evidence?token=PRIVATE_QUERY_TOKEN";
  const publicHttps = "https://example.test/evidence/receipt.json";
  const projection = {
    configuration: { source: "committed" },
    signals: [{
      latest: {
        source: privateSource,
        adapter: { name: "test", trust: "authenticated-client" },
        coverage: { state: "complete", redacted: false, truncated: false, omitted: [] },
        evidence: [
          evidence(privateUrn, DIGEST_A),
          evidence(secretHttps, DIGEST_B),
          evidence(publicHttps, DIGEST_A),
        ],
      },
    }],
  };

  const disclosed = discloseProofwakeProjection(projection);
  assert.match(disclosed.signals[0].latest.source, /^urn:proofwake:source:sha256:[a-f0-9]{64}$/u);
  assert.equal(disclosed.configuration.source, "committed");
  assert.equal(disclosed.signals[0].latest.evidence[0].uri, `urn:proofwake:evidence:${DIGEST_A}`);
  assert.equal(disclosed.signals[0].latest.evidence[1].uri, `urn:proofwake:evidence:${DIGEST_B}`);
  assert.equal(disclosed.signals[0].latest.evidence[2].uri, publicHttps);
  assert.equal(disclosed.signals[0].latest.evidence[0].digest, DIGEST_A);
  assert.equal(disclosed.signals[0].latest.adapter.trust, "authenticated-client");
  assert.equal(disclosed.signals[0].latest.coverage.state, "complete");
  const text = JSON.stringify(disclosed);
  assert.equal(text.includes("/home/operator"), false);
  assert.equal(text.includes("PRIVATE_SOURCE_TOKEN"), false);
  assert.equal(text.includes("PRIVATE_QUERY_TOKEN"), false);
});

test("MCP disclosure preserves reviewed Proofwake and GitHub source namespaces", () => {
  const projection = {
    signals: [{ latest: { source: "urn:proofwake:adapter:renderprove", evidence: [] } }],
    repositories: [{ currentFailure: { observation: { source: "https://api.github.com/hooks/123", evidence: [] } } }],
  };
  const disclosed = discloseProofwakeProjection(projection);
  assert.equal(disclosed.signals[0].latest.source, "urn:proofwake:adapter:renderprove");
  assert.equal(disclosed.repositories[0].currentFailure.observation.source, "https://api.github.com/hooks/123");
});
