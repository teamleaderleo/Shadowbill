import { createShadowbillMcpSession } from "./mcp.js";
import { createDisclosedProofwakeProjectionMcp } from "./disclosed-projection-mcp.js";
import { createEvaluationIngestMcp } from "./evaluation-ingest-mcp.js";

const MAX_STDIO_LINE_BYTES = 1_000_000;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function proofwakeInstructions(existing, allowEvaluationWrites) {
  const readPrefix = "Use proofwake_fleet_status, proofwake_repository_status, proofwake_revision_evidence, and proofwake_evaluation_evidence for read-only Proofwake evidence projections.";
  const writePrefix = allowEvaluationWrites
    ? "Use proofwake_submit_evaluation_receipt only to append one complete bounded evaluation receipt; it records evidence and grants no coordination authority."
    : "";
  const prefix = [readPrefix, writePrefix].filter(Boolean).join(" ");
  return typeof existing === "string" && existing.length > 0 ? `${prefix} ${existing}` : prefix;
}

function withProofwakeTools(tools, projectionTools, evaluationWriteTools) {
  const writeIndex = tools.findIndex((tool) => tool.name === "shadowbill_record_chat_turn");
  const proofwakeTools = [...projectionTools, ...evaluationWriteTools];
  if (writeIndex === -1) return [...tools, ...proofwakeTools];
  return [...tools.slice(0, writeIndex), ...proofwakeTools, ...tools.slice(writeIndex)];
}

/**
 * Creates the combined Proofwake and Shadowbill MCP session while leaving the
 * existing Shadowbill session contract intact.
 * @param {{
 *   store: import('./store.js').JsonlEventStore,
 *   registryStore?: import('./repository-registry.js').RepositoryRegistryStore,
 *   pricing: import('./types.js').ModelPricing,
 *   profile?: import('./types.js').EstimationProfile,
 *   timeZone: string,
 *   allowWrites?: boolean,
 *   allowEvaluationWrites?: boolean,
 *   now?: () => Date
 * }} options
 */
export function createProofwakeMcpSession(options) {
  const shadowbill = createShadowbillMcpSession(options);
  const projections = createDisclosedProofwakeProjectionMcp({
    registryStore: options.registryStore,
    eventStore: options.store,
    now: options.now,
  });
  const evaluationIngest = createEvaluationIngestMcp({
    store: options.store,
    now: options.now,
  });
  const evaluationWriteTools = options.allowEvaluationWrites ? evaluationIngest.tools : [];
  let initialized = false;

  return {
    async handle(message) {
      const response = await shadowbill.handle(message);
      if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return response;
      if (!Object.hasOwn(message, "id")) return response;

      if (message.method === "initialize") {
        if (response?.result) {
          initialized = true;
          return {
            ...response,
            result: {
              ...response.result,
              instructions: proofwakeInstructions(
                response.result.instructions,
                options.allowEvaluationWrites === true,
              ),
            },
          };
        }
        return response;
      }

      if (!initialized) return response;

      if (message.method === "tools/list" && response?.result?.tools) {
        return {
          ...response,
          result: {
            ...response.result,
            tools: withProofwakeTools(
              response.result.tools,
              projections.tools,
              evaluationWriteTools,
            ),
          },
        };
      }

      if (message.method === "tools/call" && response?.error?.code === -32601 &&
          isObject(message.params) && typeof message.params.name === "string" &&
          (message.params.arguments === undefined || isObject(message.params.arguments)) &&
          message.params.task === undefined) {
        const projectionResult = await projections.callTool(
          message.params.name,
          message.params.arguments,
        );
        if (projectionResult !== null) return rpcResult(message.id, projectionResult);
        if (options.allowEvaluationWrites) {
          const ingestResult = await evaluationIngest.callTool(
            message.params.name,
            message.params.arguments,
          );
          if (ingestResult !== null) return rpcResult(message.id, ingestResult);
        }
      }

      return response;
    },
    get protocolVersion() {
      return shadowbill.protocolVersion;
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

function resolvedStdioOptions(options) {
  if (Object.hasOwn(options, "allowEvaluationWrites")) return options;
  return {
    ...options,
    allowEvaluationWrites: process.argv.includes("--allow-evaluation-writes"),
  };
}

/**
 * Runs one newline-delimited combined MCP JSON-RPC session over stdio streams.
 * @param {Parameters<typeof createProofwakeMcpSession>[0]} options
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, maximumLineBytes?: number}} [streams]
 */
export async function runProofwakeMcpStdioServer(options, streams = {}) {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const maximumLineBytes = streams.maximumLineBytes ?? MAX_STDIO_LINE_BYTES;
  const session = createProofwakeMcpSession(resolvedStdioOptions(options));
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
