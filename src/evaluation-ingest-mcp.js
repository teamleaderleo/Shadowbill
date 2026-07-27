import { EvaluationObservationError } from "./evaluation-observation.js";
import { ingestEvaluationReceipt } from "./evaluation-ingest.js";
import { ObservationError } from "./observation.js";
import { discloseProofwakeProjection } from "./projection-mcp-disclosure.js";

export const EVALUATION_INGEST_TOOL = Object.freeze({
  name: "proofwake_submit_evaluation_receipt",
  title: "Submit Proofwake Evaluation Receipt",
  description: "Validate and append one bounded evaluation receipt JSON document. This records evidence only and grants no routing, approval, assurance, or remediation authority.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["receiptJson"],
    properties: {
      receiptJson: {
        type: "string",
        minLength: 2,
        maxLength: 65_536,
        description: "One complete Proofwake evaluation observation v1 JSON document.",
      },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execution: { taskSupport: "forbidden" },
});

class EvaluationIngestMcpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EvaluationIngestMcpError";
    this.code = code;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateArguments(value) {
  if (!isObject(value) || Object.keys(value).some((key) => key !== "receiptJson")) {
    throw new EvaluationIngestMcpError(
      "PROOFWAKE_MCP_INVALID_ARGUMENTS",
      "Arguments must contain only receiptJson.",
    );
  }
  if (!Object.hasOwn(value, "receiptJson")) {
    throw new EvaluationIngestMcpError(
      "PROOFWAKE_MCP_RECEIPT_REQUIRED",
      "receiptJson is required.",
    );
  }
  if (typeof value.receiptJson !== "string") {
    throw new EvaluationIngestMcpError(
      "PROOFWAKE_MCP_INVALID_RECEIPT_JSON",
      "receiptJson must be a JSON string.",
    );
  }
  return value.receiptJson;
}

function toolResult(value) {
  const disclosed = discloseProofwakeProjection(value);
  return {
    content: [{ type: "text", text: JSON.stringify(disclosed, null, 2) }],
    structuredContent: disclosed,
    isError: false,
  };
}

function toolError(code, message) {
  const value = { error: { code, message } };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: true,
  };
}

function boundedError(error) {
  if (error instanceof EvaluationIngestMcpError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof EvaluationObservationError || error instanceof ObservationError) {
    if (error.code === "OBSERVATION_ID_CONFLICT") {
      return {
        code: error.code,
        message: "Evaluation receipt identity conflicts with accepted evidence.",
      };
    }
    return {
      code: typeof error.code === "string" ? error.code : "EVALUATION_RECEIPT_INVALID",
      message: "Evaluation receipt verification failed.",
    };
  }
  return {
    code: "PROOFWAKE_MCP_EVALUATION_INGEST_FAILED",
    message: "Evaluation receipt could not be accepted.",
  };
}

/**
 * @param {{store?: object, now?: () => Date}} options
 */
export function createEvaluationIngestMcp(options) {
  return {
    tools: [EVALUATION_INGEST_TOOL],
    async callTool(name, args) {
      if (name !== EVALUATION_INGEST_TOOL.name) return null;
      try {
        const receiptJson = validateArguments(args);
        if (!options.store || typeof options.store.appendIdempotent !== "function") {
          throw new EvaluationIngestMcpError(
            "PROOFWAKE_MCP_LEDGER_UNAVAILABLE",
            "Proofwake ledger is unavailable.",
          );
        }
        const now = typeof options.now === "function" ? options.now() : new Date();
        return toolResult(await ingestEvaluationReceipt({
          store: options.store,
          receiptJson,
          now,
        }));
      } catch (error) {
        const bounded = boundedError(error);
        return toolError(bounded.code, bounded.message);
      }
    },
  };
}
