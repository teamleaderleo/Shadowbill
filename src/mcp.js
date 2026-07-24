import { createHash } from "node:crypto";
import { buildDailyReport, dateInTimeZone, DEFAULT_WORKING_PROFILE } from "./estimate.js";
import { buildRangeReport } from "./range.js";
import { buildRepositoryAllocationReport } from "./repositories.js";

const SERVER_VERSION = "0.3.0";
const CURRENT_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  CURRENT_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max", "unknown"]);
const MODEL_SLUG = /^[a-z0-9][a-z0-9._:-]{0,99}$/i;
const MAX_STDIO_LINE_BYTES = 1_000_000;

const DAILY_REPORT_TOOL = {
  name: "shadowbill_daily_report",
  title: "Shadowbill Daily Report",
  description: "Read API-equivalent AI cost and software-delivery metrics for one calendar day.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      date: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "Calendar date in YYYY-MM-DD format. Defaults to today in the selected timezone.",
      },
      timezone: {
        type: "string",
        minLength: 1,
        maxLength: 100,
        description: "IANA timezone such as America/Los_Angeles. Defaults to the server configuration.",
      },
    },
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execution: { taskSupport: "forbidden" },
};

const RANGE_REPORT_TOOL = {
  name: "shadowbill_range_report",
  title: "Shadowbill Rolling Report",
  description: "Read aggregate AI cost and software-delivery metrics for a rolling calendar-day range.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      endDate: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "Inclusive end date in YYYY-MM-DD format. Defaults to today in the selected timezone.",
      },
      days: {
        type: "integer",
        minimum: 1,
        maximum: 365,
        description: "Number of inclusive calendar days. Defaults to 7.",
      },
      timezone: {
        type: "string",
        minLength: 1,
        maxLength: 100,
        description: "IANA timezone such as America/Los_Angeles. Defaults to the server configuration.",
      },
    },
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execution: { taskSupport: "forbidden" },
};

const REPOSITORY_REPORT_TOOL = {
  name: "shadowbill_repository_report",
  title: "Shadowbill Repository Allocation Report",
  description: "Read heuristic repository-level cost allocation and software-delivery metrics for a rolling calendar-day range.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      endDate: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "Inclusive end date in YYYY-MM-DD format. Defaults to today in the selected timezone.",
      },
      days: {
        type: "integer",
        minimum: 1,
        maximum: 365,
        description: "Number of inclusive calendar days. Defaults to 7.",
      },
      timezone: {
        type: "string",
        minLength: 1,
        maxLength: 100,
        description: "IANA timezone such as America/Los_Angeles. Defaults to the server configuration.",
      },
    },
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execution: { taskSupport: "forbidden" },
};

const RECORD_CHAT_TURN_TOOL = {
  name: "shadowbill_record_chat_turn",
  title: "Record Aggregate Chat Turn",
  description: "Append aggregate chat telemetry. Accepts counts and identifiers only; prompt and response text fields are unsupported.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["conversationKey", "model", "visibleInputTokens", "visibleOutputTokens", "timestamp"],
    properties: {
      conversationKey: {
        type: "string",
        minLength: 1,
        maxLength: 2048,
        description: "Stable conversation identifier. Shadowbill hashes it before storage.",
      },
      model: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$" },
      reasoningEffort: {
        type: "string",
        enum: ["none", "low", "medium", "high", "xhigh", "max", "unknown"],
      },
      visibleInputTokens: { type: "integer", minimum: 0 },
      visibleOutputTokens: { type: "integer", minimum: 0 },
      toolActivityCount: { type: "integer", minimum: 0 },
      responseDurationMs: { type: "integer", minimum: 0 },
      timestamp: {
        type: "string",
        description: "Stable ISO-8601 event timestamp used for idempotent retries.",
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
};

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validRequestId(value) {
  return typeof value === "string" || Number.isSafeInteger(value);
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validTimeZone(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
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

function validateInitializeParams(params) {
  return isObject(params) && typeof params.protocolVersion === "string" &&
    isObject(params.capabilities) && isObject(params.clientInfo) &&
    typeof params.clientInfo.name === "string" && typeof params.clientInfo.version === "string";
}

function validateReportArguments(value) {
  const args = value === undefined ? {} : value;
  if (!isObject(args) || !hasOnlyKeys(args, new Set(["date", "timezone"]))) {
    return { error: "Arguments must contain only date and timezone." };
  }
  if (args.date !== undefined && !validDate(args.date)) return { error: "date must be a real YYYY-MM-DD calendar date." };
  if (args.timezone !== undefined && !validTimeZone(args.timezone)) return { error: "timezone must be a valid IANA timezone." };
  return { value: args };
}

function validateRangeArguments(value) {
  const args = value === undefined ? {} : value;
  if (!isObject(args) || !hasOnlyKeys(args, new Set(["endDate", "days", "timezone"]))) {
    return { error: "Arguments must contain only endDate, days, and timezone." };
  }
  if (args.endDate !== undefined && !validDate(args.endDate)) {
    return { error: "endDate must be a real YYYY-MM-DD calendar date." };
  }
  if (args.days !== undefined && (!Number.isSafeInteger(args.days) || args.days < 1 || args.days > 365)) {
    return { error: "days must be an integer between 1 and 365." };
  }
  if (args.timezone !== undefined && !validTimeZone(args.timezone)) {
    return { error: "timezone must be a valid IANA timezone." };
  }
  return { value: { ...args, days: args.days ?? 7 } };
}

function validateChatArguments(value) {
  const allowed = new Set([
    "conversationKey",
    "model",
    "reasoningEffort",
    "visibleInputTokens",
    "visibleOutputTokens",
    "toolActivityCount",
    "responseDurationMs",
    "timestamp",
  ]);
  if (!isObject(value) || !hasOnlyKeys(value, allowed)) return { error: "Arguments contain unsupported fields." };
  if (typeof value.conversationKey !== "string" || value.conversationKey.length < 1 || value.conversationKey.length > 2048) {
    return { error: "conversationKey must contain 1 to 2048 characters." };
  }
  if (typeof value.model !== "string" || !MODEL_SLUG.test(value.model)) return { error: "model must be a valid model slug." };
  const reasoningEffort = value.reasoningEffort ?? "unknown";
  if (!REASONING_EFFORTS.has(reasoningEffort)) return { error: "reasoningEffort is unsupported." };
  if (!safeInteger(value.visibleInputTokens) || !safeInteger(value.visibleOutputTokens)) {
    return { error: "visible token counts must be nonnegative safe integers." };
  }
  if (value.toolActivityCount !== undefined && !safeInteger(value.toolActivityCount)) {
    return { error: "toolActivityCount must be a nonnegative safe integer." };
  }
  if (value.responseDurationMs !== undefined && !safeInteger(value.responseDurationMs)) {
    return { error: "responseDurationMs must be a nonnegative safe integer." };
  }
  if (typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))) {
    return { error: "timestamp must be ISO-8601 compatible." };
  }
  return { value: { ...value, reasoningEffort, timestamp: new Date(value.timestamp).toISOString() } };
}

/**
 * Creates a stateful MCP JSON-RPC session for one stdio connection.
 * @param {{
 *   store: import('./store.js').JsonlEventStore,
 *   pricing: import('./types.js').ModelPricing,
 *   profile?: import('./types.js').EstimationProfile,
 *   timeZone: string,
 *   allowWrites?: boolean
 * }} options
 */
export function createShadowbillMcpSession(options) {
  const profile = options.profile ?? DEFAULT_WORKING_PROFILE;
  let initialized = false;
  let selectedProtocolVersion = CURRENT_PROTOCOL_VERSION;

  async function callTool(name, args) {
    if (name === DAILY_REPORT_TOOL.name) {
      const validated = validateReportArguments(args);
      if (validated.error) return toolError(validated.error);
      const timeZone = validated.value.timezone ?? options.timeZone;
      const date = validated.value.date ?? dateInTimeZone(new Date().toISOString(), timeZone);
      const report = buildDailyReport(await options.store.readAll(), date, options.pricing, profile, timeZone);
      return toolResult({ ...report, timezone: timeZone });
    }

    if (name === RANGE_REPORT_TOOL.name) {
      const validated = validateRangeArguments(args);
      if (validated.error) return toolError(validated.error);
      const timeZone = validated.value.timezone ?? options.timeZone;
      const endDate = validated.value.endDate ?? dateInTimeZone(new Date().toISOString(), timeZone);
      const report = buildRangeReport(
        await options.store.readAll(),
        endDate,
        validated.value.days,
        options.pricing,
        profile,
        timeZone,
      );
      return toolResult(report);
    }

    if (name === REPOSITORY_REPORT_TOOL.name) {
      const validated = validateRangeArguments(args);
      if (validated.error) return toolError(validated.error);
      const timeZone = validated.value.timezone ?? options.timeZone;
      const endDate = validated.value.endDate ?? dateInTimeZone(new Date().toISOString(), timeZone);
      const report = buildRepositoryAllocationReport(
        await options.store.readAll(),
        endDate,
        validated.value.days,
        options.pricing,
        profile,
        timeZone,
      );
      return toolResult(report);
    }

    if (name === RECORD_CHAT_TURN_TOOL.name && options.allowWrites) {
      const validated = validateChatArguments(args);
      if (validated.error) return toolError(validated.error);
      const input = validated.value;
      const conversationHash = hash(input.conversationKey);
      const eventKey = hash(JSON.stringify({
        conversationHash,
        timestamp: input.timestamp,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        visibleInputTokens: input.visibleInputTokens,
        visibleOutputTokens: input.visibleOutputTokens,
        toolActivityCount: input.toolActivityCount ?? null,
        responseDurationMs: input.responseDurationMs ?? null,
      }));
      const event = {
        type: "chat_turn",
        id: `mcp_chat_${eventKey}`,
        timestamp: input.timestamp,
        conversationHash,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        visibleInputTokens: input.visibleInputTokens,
        visibleOutputTokens: input.visibleOutputTokens,
        ...(input.toolActivityCount === undefined ? {} : { toolActivityCount: input.toolActivityCount }),
        ...(input.responseDurationMs === undefined ? {} : { responseDurationMs: input.responseDurationMs }),
        collectorVersion: SERVER_VERSION,
      };
      const inserted = await options.store.append(event);
      return toolResult({ accepted: true, duplicate: !inserted, id: event.id, conversationHash });
    }

    return null;
  }

  return {
    async handle(message) {
      if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        return rpcError(isObject(message) ? message.id : null, -32600, "Invalid Request");
      }

      const isRequest = Object.hasOwn(message, "id");
      if (!isRequest) return null;
      if (!validRequestId(message.id)) return rpcError(null, -32600, "Invalid Request ID");

      if (message.method === "initialize") {
        if (initialized) return rpcError(message.id, -32600, "Server is already initialized");
        if (!validateInitializeParams(message.params)) return rpcError(message.id, -32602, "Invalid initialize parameters");
        selectedProtocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(message.params.protocolVersion)
          ? message.params.protocolVersion
          : CURRENT_PROTOCOL_VERSION;
        initialized = true;
        return rpcResult(message.id, {
          protocolVersion: selectedProtocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "shadowbill", version: SERVER_VERSION },
          instructions: "Use shadowbill_daily_report for one day, shadowbill_range_report for rolling aggregate metrics, or shadowbill_repository_report for heuristic repository allocation. Aggregate writes appear only when the server is explicitly started with write access.",
        });
      }

      if (!initialized) return rpcError(message.id, -32002, "Server not initialized");
      if (message.method === "ping") return rpcResult(message.id, {});

      if (message.method === "tools/list") {
        if (message.params !== undefined && !isObject(message.params)) {
          return rpcError(message.id, -32602, "Invalid tools/list parameters");
        }
        if (message.params?.cursor !== undefined && typeof message.params.cursor !== "string") {
          return rpcError(message.id, -32602, "tools/list cursor must be a string");
        }
        const readTools = [DAILY_REPORT_TOOL, RANGE_REPORT_TOOL, REPOSITORY_REPORT_TOOL];
        const tools = options.allowWrites ? [...readTools, RECORD_CHAT_TURN_TOOL] : readTools;
        return rpcResult(message.id, { tools });
      }

      if (message.method === "tools/call") {
        if (!isObject(message.params) || typeof message.params.name !== "string" ||
            (message.params.arguments !== undefined && !isObject(message.params.arguments))) {
          return rpcError(message.id, -32602, "Invalid tools/call parameters");
        }
        if (message.params.task !== undefined) {
          return rpcError(message.id, -32601, "Task-augmented tool calls are unsupported");
        }

        let result;
        try {
          result = await callTool(message.params.name, message.params.arguments);
        } catch (error) {
          result = toolError(error instanceof Error ? error.message : String(error));
        }
        if (result === null) return rpcError(message.id, -32601, `Unknown tool: ${message.params.name}`);
        return rpcResult(message.id, result);
      }

      return rpcError(message.id, -32601, `Method not found: ${message.method}`);
    },
    get protocolVersion() {
      return selectedProtocolVersion;
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
 * Runs one newline-delimited MCP JSON-RPC session over stdio-compatible streams.
 * @param {Parameters<typeof createShadowbillMcpSession>[0]} options
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, maximumLineBytes?: number}} [streams]
 */
export async function runShadowbillMcpStdioServer(options, streams = {}) {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const maximumLineBytes = streams.maximumLineBytes ?? MAX_STDIO_LINE_BYTES;
  const session = createShadowbillMcpSession(options);
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
      } catch (error) {
        const id = isObject(message) && Object.hasOwn(message, "id") ? message.id : null;
        await writeJsonLine(output, rpcError(id, -32603, "Internal error", error instanceof Error ? error.message : String(error)));
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
