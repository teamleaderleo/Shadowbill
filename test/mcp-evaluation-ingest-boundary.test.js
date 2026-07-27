import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createEvaluationIngestMcp } from "../src/evaluation-ingest-mcp.js";

async function fixture() {
  return readFile(
    new URL("./fixtures/observations/stensibly-work-evaluation-repair-v1.json", import.meta.url),
    "utf8",
  );
}

test("invalid receipt content is rejected before ledger availability is inspected", async () => {
  const receipt = JSON.parse(await fixture());
  receipt.data.facts.push({
    name: "proofwake.evaluation.prompt",
    value: "private-before-ledger-sentinel",
  });
  const mcp = createEvaluationIngestMcp({ store: undefined });
  const result = await mcp.callTool("proofwake_submit_evaluation_receipt", {
    receiptJson: JSON.stringify(receipt),
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "EVALUATION_UNKNOWN_FACT");
  assert.equal(result.structuredContent.error.message, "Evaluation receipt verification failed.");
  assert.equal(JSON.stringify(result).includes("private-before-ledger-sentinel"), false);
});

test("a valid receipt reports fixed ledger unavailability without receipt disclosure", async () => {
  const receiptJson = await fixture();
  const mcp = createEvaluationIngestMcp({ store: undefined });
  const result = await mcp.callTool("proofwake_submit_evaluation_receipt", { receiptJson });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "PROOFWAKE_MCP_LEDGER_UNAVAILABLE");
  assert.equal(result.structuredContent.error.message, "Proofwake ledger is unavailable.");
  assert.equal(JSON.stringify(result).includes("proofwake.work.evaluation.observed.v1"), false);
});
