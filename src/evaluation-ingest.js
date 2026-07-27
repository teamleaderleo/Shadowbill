import { appendObservation } from "./emit.js";
import { validateEvaluationObservation } from "./evaluation-observation.js";
import { observationLedgerRecord } from "./observation-ledger.js";
import { parseObservationJson } from "./observation.js";

export function parseEvaluationReceiptJson(receiptJson) {
  const observation = parseObservationJson(receiptJson);
  validateEvaluationObservation(observation);
  return observation;
}

export async function ingestEvaluationReceipt({ store, receiptJson, now = new Date() }) {
  const observation = parseEvaluationReceiptJson(receiptJson);
  const result = await appendObservation({ store, observation, now });
  validateEvaluationObservation(result.observation);
  const record = observationLedgerRecord(result.observation);
  return {
    accepted: true,
    replayed: result.status === "duplicate",
    status: result.status,
    eventId: record.id,
    identity: {
      source: result.observation.source,
      id: result.observation.id,
    },
    type: result.observation.type,
    fingerprint: result.fingerprint,
    ingestedAt: result.observation.data.ingestedAt,
    schemaVersion: 1,
  };
}
