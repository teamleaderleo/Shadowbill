import { buildEvaluationProjection, EvaluationProjectionError } from "./evaluation-projection.js";
import { buildFleetProjection } from "./fleet-projection.js";
import { buildRevisionProjection } from "./inspect-projection.js";

const REPOSITORY_SELECTOR = /^[a-z0-9](?:[a-z0-9._/-]{0,199})$/u;
const EVALUATION_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const EVALUATION_TASK_CLASS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const EVALUATION_TARGET_RUN = /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,123}$/u;
const FULL_REVISION = /^[a-f0-9]{40}$/u;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const FLEET_STATUS_TOOL = {
  name: "proofwake_fleet_status",
  title: "Proofwake Fleet Status",
  description: "Read the current evidence-backed status of every enrolled repository.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  annotations: READ_ONLY_ANNOTATIONS,
  execution: { taskSupport: "forbidden" },
};

const REPOSITORY_STATUS_TOOL = {
  name: "proofwake_repository_status",
  title: "Proofwake Repository Status",
  description: "Read the current selected-revision evidence projection for one enrolled repository identity or label.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["repository"],
    properties: {
      repository: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        pattern: "^[a-z0-9](?:[a-z0-9._/-]{0,199})$",
        description: "Bounded enrolled repository identity or label.",
      },
    },
  },
  annotations: READ_ONLY_ANNOTATIONS,
  execution: { taskSupport: "forbidden" },
};

const REVISION_EVIDENCE_TOOL = {
  name: "proofwake_revision_evidence",
  title: "Proofwake Revision Evidence",
  description: "Read the evidence projection for one explicit full revision selected by enrolled repository identity or label.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["repository", "revision"],
    properties: {
      repository: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        pattern: "^[a-z0-9](?:[a-z0-9._/-]{0,199})$",
        description: "Bounded enrolled repository identity or label.",
      },
      revision: {
        type: "string",
        pattern: "^[a-f0-9]{40}$",
        description: "Full lowercase SHA-1 revision.",
      },
    },
  },
  annotations: READ_ONLY_ANNOTATIONS,
  execution: { taskSupport: "forbidden" },
};

const EVALUATION_EVIDENCE_TOOL = {
  name: "proofwake_evaluation_evidence",
  title: "Proofwake Evaluation Evidence",
  description: "Read one deterministic task-specific evaluation evidence projection without creating a score or authority decision.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["repository", "taskClass"],
    properties: {
      repository: {
        type: "string",
        minLength: 3,
        maxLength: 200,
        pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
        description: "Exact repository owner/name identity.",
      },
      taskClass: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        description: "Bounded evaluation task class.",
      },
      targetRun: {
        type: "string",
        minLength: 5,
        maxLength: 128,
        pattern: "^run_[A-Za-z0-9][A-Za-z0-9._-]{0,123}$",
        description: "Optional exact target run reference.",
      },
    },
  },
  annotations: READ_ONLY_ANNOTATIONS,
  execution: { taskSupport: "forbidden" },
};

export const PROOFWAKE_PROJECTION_TOOLS = Object.freeze([
  FLEET_STATUS_TOOL,
  REPOSITORY_STATUS_TOOL,
  REVISION_EVIDENCE_TOOL,
  EVALUATION_EVIDENCE_TOOL,
]);

class ProofwakeMcpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProofwakeMcpError";
    this.code = code;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateFleetArguments(value) {
  const args = value === undefined ? {} : value;
  if (!isObject(args) || Object.keys(args).length !== 0) {
    throw new ProofwakeMcpError("PROOFWAKE_MCP_INVALID_ARGUMENTS", "Arguments must be an empty object.");
  }
  return args;
}

function validateRepositorySelector(value) {
  if (typeof value !== "string" || !REPOSITORY_SELECTOR.test(value)) {
    throw new ProofwakeMcpError(
      "PROOFWAKE_MCP_INVALID_REPOSITORY",
      "repository must be a bounded enrolled identity or label.",
    );
  }
  return value;
}

function validateRepositoryArguments(value) {
  if (!isObject(value) || !hasOnlyKeys(value, new Set(["repository"]))) {
    throw new ProofwakeMcpError(
      "PROOFWAKE_MCP_INVALID_ARGUMENTS",
      "Arguments must contain only repository.",
    );
  }
  if (!Object.hasOwn(value, "repository")) {
    throw new ProofwakeMcpError("PROOFWAKE_MCP_REPOSITORY_REQUIRED", "repository is required.");
  }
  return { repository: validateRepositorySelector(value.repository) };
}

function validateRevisionArguments(value) {
  if (!isObject(value) || !hasOnlyKeys(value, new Set(["repository", "revision"]))) {
    throw new ProofwakeMcpError(
      "PROOFWAKE_MCP_INVALID_ARGUMENTS",
      "Arguments must contain only repository and revision.",
    );
  }
  if (!Object.hasOwn(value, "repository")) {
    throw new ProofwakeMcpError("PROOFWAKE_MCP_REPOSITORY_REQUIRED", "repository is required.");
  }
  if (!Object.hasOwn(value, "revision")) {
    throw new ProofwakeMcpError("PROOFWAKE_MCP_REVISION_REQUIRED", "revision is required.");
  }
  const repository = validateRepositorySelector(value.repository);
  if (typeof value.revision !== "string" || !FULL_REVISION.test(value.revision)) {
    throw new ProofwakeMcpError(
      "PROOFWAKE_MCP_INVALID_REVISION",
      "revision must be a full lowercase SHA-1.",
    );
  }
  return { repository, revision: value.revision };
}

function validateEvaluationArguments(value) {
  const allowed = new Set(["repository", "taskClass", "targetRun"]);
  if (!isObject(value) || !hasOnlyKeys(value, allowed)) {
    throw new ProofwakeMcpError(
      "PROOFWAKE_MCP_INVALID_ARGUMENTS",
      "Arguments must contain only repository, taskClass, and optional targetRun.",
    );
  }
  if (!Object.hasOwn(value, "repository")) {
    throw new ProofwakeMcpError("PROOFWAKE_MCP_REPOSITORY_REQUIRED", "repository is required.");
  }
  if (!Object.hasOwn(value, "taskClass")) {
    throw new ProofwakeMcpError("PROOFWAKE_MCP_TASK_CLASS_REQUIRED", "taskClass is required.");
  }
  if (
    typeof value.repository !== "string"
    || value.repository.length > 200
    || !EVALUATION_REPOSITORY.test(value.repository)
  ) {
    throw new ProofwakeMcpError(
      "PROOFWAKE_MCP_INVALID_REPOSITORY",
      "repository must be an exact bounded owner/name identity.",
    );
  }
  if (typeof value.taskClass !== "string" || !EVALUATION_TASK_CLASS.test(value.taskClass)) {
    throw new ProofwakeMcpError(
      "PROOFWAKE_MCP_INVALID_TASK_CLASS",
      "taskClass must be a bounded evaluation token.",
    );
  }
  if (
    Object.hasOwn(value, "targetRun")
    && (typeof value.targetRun !== "string" || !EVALUATION_TARGET_RUN.test(value.targetRun))
  ) {
    throw new ProofwakeMcpError(
      "PROOFWAKE_MCP_INVALID_TARGET_RUN",
      "targetRun must be an exact run_ reference.",
    );
  }
  return {
    repository: value.repository,
    taskClass: value.taskClass,
    ...(Object.hasOwn(value, "targetRun") ? { targetRun: value.targetRun } : {}),
  };
}

function deepFreeze(value) {
  if (!isObject(value) && !Array.isArray(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function immutableSnapshot(value) {
  return deepFreeze(structuredClone(value));
}

function proofwakeToolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false,
  };
}

function proofwakeToolError(code, message) {
  const value = { error: { code, message } };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: true,
  };
}

function registryError(error) {
  const code = typeof error?.code === "string" && error.code.startsWith("REPOSITORY_REGISTRY_")
    ? error.code
    : "PROOFWAKE_MCP_REGISTRY_UNAVAILABLE";
  const unavailable = new Set([
    "REPOSITORY_REGISTRY_UNAVAILABLE",
    "REPOSITORY_REGISTRY_CHANGED",
    "REPOSITORY_REGISTRY_LOCK_TIMEOUT",
    "PROOFWAKE_MCP_REGISTRY_UNAVAILABLE",
  ]);
  return {
    code,
    message: unavailable.has(code) ? "Repository registry is unavailable." : "Repository registry is invalid.",
  };
}

function projectionError(error) {
  if (error instanceof ProofwakeMcpError || error instanceof EvaluationProjectionError) {
    return { code: error.code, message: error.message };
  }
  const messages = new Map([
    ["PROJECTION_REPOSITORY_REQUIRED", "Repository identity or label is required."],
    ["PROJECTION_REPOSITORY_UNKNOWN", "Repository is not enrolled."],
    ["PROJECTION_INVALID_REVISION", "Revision must be a full lowercase SHA-1."],
    ["PROJECTION_REVISION_UNAVAILABLE", "Selected revision is unavailable."],
    ["PROJECTION_POLICY_UNAVAILABLE", "Repository policy is unavailable."],
  ]);
  const code = typeof error?.code === "string" ? error.code : "PROOFWAKE_MCP_PROJECTION_FAILED";
  if (code.startsWith("REPOSITORY_REGISTRY_")) return registryError(error);
  return {
    code: messages.has(code) ? code : "PROOFWAKE_MCP_PROJECTION_FAILED",
    message: messages.get(code) ?? "Proofwake projection generation failed.",
  };
}

async function readEventSnapshot(options) {
  if (!options.eventStore || typeof options.eventStore.readAll !== "function") {
    throw new ProofwakeMcpError("PROOFWAKE_MCP_LEDGER_UNAVAILABLE", "Proofwake ledger is unavailable.");
  }
  try {
    return immutableSnapshot(await options.eventStore.readAll());
  } catch {
    throw new ProofwakeMcpError("PROOFWAKE_MCP_LEDGER_UNAVAILABLE", "Proofwake ledger is unavailable.");
  }
}

async function readProjectionSnapshot(options) {
  if (!options.registryStore || typeof options.registryStore.read !== "function") {
    throw new ProofwakeMcpError("PROOFWAKE_MCP_REGISTRY_UNAVAILABLE", "Repository registry is unavailable.");
  }

  const [registryResult, eventResult] = await Promise.allSettled([
    options.registryStore.read(),
    readEventSnapshot(options),
  ]);
  if (registryResult.status === "rejected") {
    const bounded = registryError(registryResult.reason);
    throw new ProofwakeMcpError(bounded.code, bounded.message);
  }
  if (eventResult.status === "rejected") throw eventResult.reason;

  const registry = immutableSnapshot(registryResult.value);
  const events = eventResult.value;
  return {
    registryStore: { read: async () => registry },
    eventStore: { readAll: async () => events },
  };
}

function projectionTime(options) {
  const value = typeof options.now === "function" ? options.now() : new Date();
  const time = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(time.getTime())) return new Date();
  return time;
}

/**
 * @param {{
 *   registryStore?: {read(): Promise<unknown>},
 *   eventStore?: {readAll(): Promise<unknown[]>},
 *   now?: () => Date
 * }} options
 */
export function createProofwakeProjectionMcp(options) {
  return {
    tools: PROOFWAKE_PROJECTION_TOOLS,
    async callTool(name, args) {
      if (!PROOFWAKE_PROJECTION_TOOLS.some((tool) => tool.name === name)) return null;
      try {
        if (name === EVALUATION_EVIDENCE_TOOL.name) {
          const input = validateEvaluationArguments(args);
          const events = await readEventSnapshot(options);
          return proofwakeToolResult(buildEvaluationProjection({ events, ...input }));
        }

        let input;
        if (name === FLEET_STATUS_TOOL.name) input = validateFleetArguments(args);
        else if (name === REPOSITORY_STATUS_TOOL.name) input = validateRepositoryArguments(args);
        else input = validateRevisionArguments(args);

        const snapshot = await readProjectionSnapshot(options);
        const now = projectionTime(options);
        const report = name === FLEET_STATUS_TOOL.name
          ? await buildFleetProjection({ ...snapshot, now })
          : await buildRevisionProjection({ ...snapshot, ...input, now });
        return proofwakeToolResult(report);
      } catch (error) {
        const bounded = projectionError(error);
        return proofwakeToolError(bounded.code, bounded.message);
      }
    },
  };
}
