import { dirname, join } from "node:path";
import { buildFleetProjection } from "./fleet-projection.js";
import { buildFailureReport, buildRecoveryReport } from "./history-reports.js";
import { buildRevisionProjection } from "./inspect-projection.js";
import { createShadowbillMcpSession } from "./mcp.js";
import { RepositoryRegistryStore } from "./repository-registry.js";

const SERVER_VERSION = "0.3.0";
const MAX_STDIO_LINE_BYTES = 1_000_000;
const REPOSITORY = /^[a-z0-9](?:[a-z0-9._-]{0,99})\/[a-z0-9](?:[a-z0-9._-]{0,99})$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const FLEET_TOOL = {
  name: "proofwake_fleet_status",
  title: "Proofwake Fleet Status",
  description: "Read current green, red, yellow, and grey revision-evidence status for every enrolled repository.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  annotations: READ_ONLY_ANNOTATIONS,
  execution: { taskSupport: "forbidden" },
};

const REPOSITORY_TOOL = {
  name: "proofwake_repository_status",
  title: "Proofwake Repository Status",
  description: "Read the current selected revision and expected-signal matrix for one enrolled repository.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["repository"],
    properties: {
      repository: {
        type: "string",
        pattern: "^[a-z0-9](?:[a-z0-9._-]{0,99})/[a-z0-9](?:[a-z0-9._-]{0,99})$",
        description: "Canonical lower-case owner/name repository identity.",
      },
    },
  },
  annotations: READ_ONLY_ANNOTATIONS,
  execution: { taskSupport: "forbidden" },
};

const REVISION_TOOL = {
  name: "proofwake_revision_evidence",
  title: "Proofwake Revision Evidence",
  description: "Read exact expected-signal, observation, evidence-reference, failure, and recovery details for one repository revision.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["repository", "revision"],
    properties: {
      repository: {
        type: "string",
        pattern: "^[a-z0-9](?:[a-z0-9._-]{0,99})/[a-z0-9](?:[a-z0-9._-]{0,99})$",
        description: "Canonical lower-case owner/name repository identity.",
      },
      revision: {
        type: "string",
        pattern: "^[a-f0-9]{40}$",
        description: "Full lower-case SHA-1 revision.",
      },
    },
  },
  annotations: READ_ONLY_ANNOTATIONS,
  execution: { taskSupport: "forbidden" },
};

const FAILURES_TOOL = {
  name: "proofwake_recent_failures",
  title: "Proofwake Recent Failures",
  description: "Read policy-matched terminal failures and their resolved or unresolved state in a rolling observed-time window.",
  inputSchema: historyInputSchema(),
  annotations: READ_ONLY_ANNOTATIONS,
  execution: { taskSupport: "forbidden" },
};

const RECOVERIES_TOOL = {
  name: "proofwake_recovery_report",
  title: "Proofwake Recovery Report",
  description: "Read explicit same-revision and same-subject rerun recoveries in a rolling observed-time window.",
  inputSchema: historyInputSchema(),
  annotations: READ_ONLY_ANNOTATIONS,
  execution: { taskSupport: "forbidden" },
};

export const PROOFWAKE_EVIDENCE_TOOLS = Object.freeze([
  FLEET_TOOL,
  REPOSITORY_TOOL,
  REVISION_TOOL,
  FAILURES_TOOL,
  RECOVERIES_TOOL,
]);

const TOOL_NAMES = new Set(PROOFWAKE_EVIDENCE_TOOLS.map((tool) => tool.name));

function historyInputSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      days: {
        type: "integer",
        minimum: 1,
        maximum: 365,
        description: "Rolling observed-time days. Defaults to 30.",
      },
    },
  };
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validRequestId(value) {
  return typeof value === "string" || Number.isSafeInteger(value);
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: validRequestId(id) ? id : null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(code, message) {
  const value = { service: "proofwake", status: "error", error: { code, message } };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: true,
  };
}

function resolveRegistryStore(options) {
  if (options.registryStore !== undefined) return options.registryStore;
  if (typeof options.store?.path !== "string") return null;
  return new RepositoryRegistryStore(join(dirname(options.store.path), "repositories.json"));
}

function validateEmptyArguments(value) {
  const args = value === undefined ? {} : value;
  if (!isObject(args) || Object.keys(args).length > 0) return { error: "Arguments must be an empty object." };
  return { value: args };
}

function validateRepositoryArguments(value, { revision = false } = {}) {
  const allowed = revision ? new Set(["repository", "revision"]) : new Set(["repository"]);
  if (!isObject(value) || !hasOnlyKeys(value, allowed)) {
    return { error: revision ? "Arguments must contain only repository and revision." : "Arguments must contain only repository." };
  }
  if (typeof value.repository !== "string" || !REPOSITORY.test(value.repository)) {
    return { error: "repository must use canonical lower-case owner/name form." };
  }
  if (revision && (typeof value.revision !== "string" || !REVISION.test(value.revision))) {
    return { error: "revision must be a full lower-case SHA-1." };
  }
  return { value };
}

function validateHistoryArguments(value) {
  const args = value === undefined ? {} : value;
  if (!isObject(args) || !hasOnlyKeys(args, new Set(["days"]))) {
    return { error: "Arguments must contain only days." };
  }
  const days = args.days ?? 30;
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    return { error: "days must be an integer between 1 and 365." };
  }
  return { value: { days } };
}

function publicToolFailure(error) {
  const code = typeof error?.code === "string" ? error.code : "PROOFWAKE_EVIDENCE_TOOL_FAILED";
  const message = code === "PROJECTION_REPOSITORY_UNKNOWN"
    ? "Repository is not enrolled."
    : code === "PROJECTION_INVALID_REVISION"
      ? "Revision selector is invalid."
      : "Proofwake evidence report is unavailable.";
  return toolError(code, message);
}

async function callEvidenceTool(name, args, options, registryStore) {
  if (!registryStore) return toolError("PROOFWAKE_REGISTRY_UNAVAILABLE", "Repository registry is unavailable.");
  try {
    if (name === FLEET_TOOL.name) {
      const validated = validateEmptyArguments(args);
      if (validated.error) return toolError("PROOFWAKE_INVALID_ARGUMENTS", validated.error);
      return toolResult(await buildFleetProjection({
        registryStore,
        eventStore: options.store,
        now: new Date(),
      }));
    }
    if (name === REPOSITORY_TOOL.name) {
      const validated = validateRepositoryArguments(args);
      if (validated.error) return toolError("PROOFWAKE_INVALID_ARGUMENTS", validated.error);
      return toolResult(await buildRevisionProjection({
        repository: validated.value.repository,
        registryStore,
        eventStore: options.store,
        now: new Date(),
      }));
    }
    if (name === REVISION_TOOL.name) {
      const validated = validateRepositoryArguments(args, { revision: true });
      if (validated.error) return toolError("PROOFWAKE_INVALID_ARGUMENTS", validated.error);
      return toolResult(await buildRevisionProjection({
        repository: validated.value.repository,
        revision: validated.value.revision,
        registryStore,
        eventStore: options.store,
        now: new Date(),
      }));
    }
    if (name === FAILURES_TOOL.name || name === RECOVERIES_TOOL.name) {
      const validated = validateHistoryArguments(args);
      if (validated.error) return toolError("PROOFWAKE_INVALID_ARGUMENTS", validated.error);
      const report = name === FAILURES_TOOL.name
        ? await buildFailureReport({ registryStore, eventStore: options.store, days: validated.value.days, now: new Date() })
        : await buildRecoveryReport({ registryStore, eventStore: options.store, days: validated.value.days, now: new Date() });
      return toolResult(report);
    }
  } catch (error) {
    return publicToolFailure(error);
  }
  return null;
}

/**
 * Wraps the compatibility Shadowbill MCP session with Proofwake evidence tools.
 * @param {Parameters<typeof createShadowbillMcpSession>[0] & {registryStore?: object|null}} options
 */
export function createProofwakeMcpSession(options) {
  const base = createShadowbillMcpSession(options);
  const registryStore = resolveRegistryStore(options);

  return {
    async handle(message) {
      if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        return base.handle(message);
      }

      if (message.method === "initialize") {
        const response = await base.handle(message);
        if (response?.result) {
          response.result.serverInfo = { name: "proofwake", version: SERVER_VERSION };
          response.result.instructions = "Use proofwake_fleet_status for fleet attention, proofwake_repository_status or proofwake_revision_evidence for exact signal evidence, and proofwake_recent_failures or proofwake_recovery_report for bounded history. Shadowbill estimate tools remain optional secondary reports. Aggregate writes appear only with explicit write access.";
        }
        return response;
      }

      if (message.method === "tools/list") {
        const response = await base.handle(message);
        if (response?.result?.tools) response.result.tools = [...PROOFWAKE_EVIDENCE_TOOLS, ...response.result.tools];
        return response;
      }

      if (message.method === "tools/call" && isObject(message.params) && TOOL_NAMES.has(message.params.name)) {
        const validation = await base.handle(message);
        if (validation === null) return null;
        if (validation.error?.code !== -32601 || validation.error?.message !== "Tool not found") return validation;
        const result = await callEvidenceTool(message.params.name, message.params.arguments, options, registryStore);
        return rpcResult(message.id, result);
      }

      return base.handle(message);
    },
    get protocolVersion() {
      return base.protocolVersion;
    },
  };
}

function writeJsonLine(output, message) {
  const line = `${JSON.stringify(message)}\n`;
  return new Promise((resolve, reject) => {
    try {
      output.write(line, (error) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Runs one newline-delimited Proofwake MCP JSON-RPC session over stdio-compatible streams.
 */
export async function runProofwakeMcpStdioServer(options, streams = {}) {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const maximumLineBytes = streams.maximumLineBytes ?? MAX_STDIO_LINE_BYTES;
  const session = createProofwakeMcpSession(options);
  let buffer = "";
  let queue = Promise.resolve();

  const processLine = (line) => {
    queue = queue.then(async () => {
      if (line.trim().length === 0) return;
      if (Buffer.byteLength(line, "utf8") > maximumLineBytes) {
        await writeJsonLine(output, rpcError(null, -32700, "Parse error", "Message exceeds the stdio size limit"));
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        await writeJsonLine(output, rpcError(null, -32700, "Parse error"));
        return;
      }

      try {
        const response = await session.handle(message);
        if (response !== null) await writeJsonLine(output, response);
      } catch {
        const id = isObject(message) && Object.hasOwn(message, "id") ? message.id : null;
        await writeJsonLine(output, rpcError(id, -32603, "Internal error"));
      }
    });
  };

  await new Promise((resolve, reject) => {
    input.setEncoding?.("utf8");
    input.on("data", (chunk) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > maximumLineBytes && !buffer.includes("\n")) {
        processLine(buffer);
        buffer = "";
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        processLine(line);
      }
    });
    input.once("end", resolve);
    input.once("error", reject);
  });

  if (buffer.trim().length > 0) processLine(buffer.replace(/\r$/, ""));
  await queue;
}
