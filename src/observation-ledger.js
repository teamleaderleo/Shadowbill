import { createHash } from "node:crypto";
import { EventIdConflictError } from "./store.js";
import { ObservationError, observationFingerprint, validateObservation } from "./observation.js";

function ledgerIdentity(observation) {
  const digest = createHash("sha256")
    .update(`${observation.source}\u0000${observation.id}`, "utf8")
    .digest("hex");
  return `proofwake_observation_${digest}`;
}

export function observationLedgerRecord(observation) {
  validateObservation(observation);
  return {
    type: "proofwake_observation",
    id: ledgerIdentity(observation),
    timestamp: observation.data.ingestedAt,
    requestFingerprint: observationFingerprint(observation),
    observationIdentity: {
      source: observation.source,
      id: observation.id,
    },
    observation,
  };
}

export class ObservationLedger {
  constructor(store) {
    this.store = store;
  }

  async append(observation) {
    const record = observationLedgerRecord(observation);
    try {
      const result = await this.store.appendIdempotent(record);
      return {
        status: result.status,
        fingerprint: result.event.requestFingerprint,
        observation: result.event.observation,
      };
    } catch (error) {
      if (error instanceof EventIdConflictError || error?.code === "EVENT_ID_CONFLICT") {
        throw new ObservationError(
          "OBSERVATION_ID_CONFLICT",
          "Observation identity was reused with different semantics.",
          "$.id",
        );
      }
      throw error;
    }
  }
}
