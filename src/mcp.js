import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildDailyReport, dateInTimeZone, DEFAULT_WORKING_PROFILE } from "./estimate.js";

const VERSION = "0.3.0";
const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max", "unknown"];

function jsonResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error) {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function validTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * @param {{
 *   store: import('./store.js').JsonlEventStore,
 *   pricing: import('./types.js').ModelPricing,
 *   profile?: import('./types.js').EstimationProfile,
 *   timeZone: string,
 *   allowWrites?: boolean
 * }} options
 */
export function createShadowbillMcpServer(options) {
  const server = new McpServer({ name: "shadowbill", version: VERSION });
  const profile = options.profile ?? DEFAULT_WORKING_PROFILE;

  server.registerTool(
    "shadowbill_daily_report",
    {
      title: "Shadowbill Daily Report",
      description: "Read API-equivalent AI cost and software-delivery metrics for one calendar day.",
      inputSchema: {
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe("Calendar date in YYYY-MM-DD format. Defaults to today in the selected timezone."),
        timezone: z.string().min(1).max(100).optional()
          .describe("IANA timezone such as America/Los_Angeles. Defaults to the server configuration."),
      },
    },
    async ({ date, timezone }) => {
      try {
        const selectedTimeZone = timezone ?? options.timeZone;
        const selectedDate = date ?? dateInTimeZone(new Date().toISOString(), selectedTimeZone);
        const events = await options.store.readAll();
        const report = buildDailyReport(events, selectedDate, options.pricing, profile, selectedTimeZone);
        return jsonResult({ ...report, timezone: selectedTimeZone });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  if (options.allowWrites) {
    server.registerTool(
      "shadowbill_record_chat_turn",
      {
        title: "Record Aggregate Chat Turn",
        description: "Append aggregate ChatGPT turn telemetry. This tool accepts counts and identifiers only; it has no prompt or response text fields.",
        inputSchema: {
          conversationKey: z.string().min(1).max(2048)
            .describe("A stable conversation identifier. Shadowbill hashes it before storage."),
          model: z.string().min(1).max(100),
          reasoningEffort: z.enum(REASONING_EFFORTS).default("unknown"),
          visibleInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          visibleOutputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          toolActivityCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
          responseDurationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
          timestamp: z.string().refine(validTimestamp, "timestamp must be ISO-8601 compatible").optional(),
        },
      },
      async (input) => {
        try {
          const timestamp = input.timestamp ? new Date(input.timestamp).toISOString() : new Date().toISOString();
          const conversationHash = hash(input.conversationKey);
          const eventKey = hash(JSON.stringify({
            conversationHash,
            timestamp,
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
            timestamp,
            conversationHash,
            model: input.model,
            reasoningEffort: input.reasoningEffort,
            visibleInputTokens: input.visibleInputTokens,
            visibleOutputTokens: input.visibleOutputTokens,
            ...(input.toolActivityCount === undefined ? {} : { toolActivityCount: input.toolActivityCount }),
            ...(input.responseDurationMs === undefined ? {} : { responseDurationMs: input.responseDurationMs }),
            collectorVersion: VERSION,
          };
          const inserted = await options.store.append(event);
          return jsonResult({ accepted: true, duplicate: !inserted, id: event.id, conversationHash });
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }

  return server;
}

export async function runShadowbillMcpStdioServer(options) {
  const server = createShadowbillMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
